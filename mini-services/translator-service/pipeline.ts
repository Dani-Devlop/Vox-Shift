import type {
  AsrPartialRequest,
  AsrPartialResult,
  StageEvent,
  TextTranslateRequest,
  TranslationEvent,
  UtteranceError,
  UtteranceRequest,
  UtteranceResult,
} from './types'
import { ZaiASREngine } from './engines/asr'
import { LLMTranslationEngine, parseAutoPair, type TranslationContextTurn } from './engines/translator'
import { VoiceIdentityEngine } from './engines/voice'
import { pcmToWav } from './engines/audio-utils'

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline orchestrator — wires the three independent layers together:
//   ASR  →  Translation  →  Voice identity synthesis
// Each layer is a swappable engine; this file is the only place that knows
// the execution order, so engines can be replaced without touching transport.
// Typed text requests skip ASR and reuse the same translate + TTS stages.
// ─────────────────────────────────────────────────────────────────────────────

const asrEngine = new ZaiASREngine()
const translateEngine = new LLMTranslationEngine()
const voiceEngine = new VoiceIdentityEngine()

/** Rolling conversational context per session (keeps pronouns/tense coherent). */
const sessionHistory = new Map<string, TranslationContextTurn[]>()

function getHistory(sessionId: string): TranslationContextTurn[] {
  return sessionHistory.get(sessionId) ?? []
}

function pushHistory(sessionId: string, turn: TranslationContextTurn) {
  const list = sessionHistory.get(sessionId) ?? []
  list.push(turn)
  if (list.length > 12) list.splice(0, list.length - 12)
  sessionHistory.set(sessionId, list)
}

export function clearSession(sessionId: string) {
  sessionHistory.delete(sessionId)
}

export interface PipelineHandlers {
  onStage: (event: StageEvent) => void
  /** Fires right after the translation stage — before voice synthesis. */
  onTranslation?: (event: TranslationEvent) => void
  onResult: (result: UtteranceResult) => void
  onError: (error: UtteranceError) => void
}

function baseResult(req: {
  utteranceId: string
  voice: string
  sourceLang: string
  targetLang: string
  profileMode?: 'clone' | 'voice-match'
  speakerRole?: 'A' | 'B'
}) {
  return {
    utteranceId: req.utteranceId,
    audioBase64: '',
    audioFormat: 'wav' as const,
    voice: req.voice,
    voiceMode: (req.profileMode ?? 'default') as 'clone' | 'voice-match' | 'default',
    sourceLang: req.sourceLang,
    targetLang: req.targetLang,
    speakerRole: req.speakerRole,
  }
}

/** Shared translate → TTS tail used by both the audio and text pipelines. */
async function translateAndSpeak(
  req: {
    utteranceId: string
    sessionId: string
    sourceLang: string
    targetLang: string
    style: UtteranceRequest['style']
    voice: string
    speed: number
    pitchRatio?: number
    profileMode?: 'clone' | 'voice-match'
    providerProfileId?: string
    providerModel?: string
    stability?: number
    providerSimilarity?: number
    providerStyle?: number
    speakerRole?: 'A' | 'B'
    /** 'fa,en' — the two sides of an AUTO conversation (detect → other side). */
    autoPair?: string
  },
  sourceText: string,
  asrMs: number,
  startedAt: number,
  handlers: PipelineHandlers
): Promise<void> {
  const { utteranceId, sessionId } = req

  // ── Stage 2: Natural translation (with optional language auto-detect) ────
  const t0 = Date.now()
  handlers.onStage({ utteranceId, stage: 'translate', status: 'start' })
  let translatedText = ''
  // When the client picked the AUTO direction, the source language is unknown:
  // detection + translation happen in ONE LLM call (no extra latency). With a
  // declared pair (sourceLang 'auto' + targetLang 'auto' + autoPair 'fa,en')
  // the TARGET is the OTHER side of the pair — a true bidirectional
  // conversation: speak fa → hear the pair's other language, and vice versa.
  const auto = req.sourceLang === 'auto'
  const pairAuto = auto && req.targetLang === 'auto'
  const [pairA, pairB] = pairAuto ? parseAutoPair(req.autoPair) : ['fa', 'en'] as [string, string]
  let detectedLang: string | undefined
  let effectiveSource = req.sourceLang
  let effectiveTarget = req.targetLang
  try {
    if (auto) {
      const autoRes = await translateEngine.translateAuto(sourceText, {
        // Pair mode: translate into the OTHER side of the pair once detected.
        // Simple auto: keep the client's fixed target.
        targetLang: pairAuto ? pairA : req.targetLang,
        style: req.style,
        history: getHistory(sessionId),
        candidates: pairAuto ? [pairA, pairB] : undefined,
      })
      translatedText = autoRes.text
      detectedLang = autoRes.detectedLang
      effectiveSource = detectedLang
      effectiveTarget = pairAuto ? (detectedLang === pairA ? pairB : pairA) : req.targetLang
      if (!pairAuto) {
        // Detected language outside candidates still translates to the fixed target.
        effectiveTarget = req.targetLang
      }
    } else {
      translatedText = await translateEngine.translate(sourceText, {
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        style: req.style,
        history: getHistory(sessionId),
      })
    }
  } catch {
    // One retry on transient LLM failure
    try {
      if (auto) {
        const autoRes = await translateEngine.translateAuto(sourceText, {
          targetLang: pairAuto ? pairA : req.targetLang,
          style: req.style,
          candidates: pairAuto ? [pairA, pairB] : undefined,
        })
        translatedText = autoRes.text
        detectedLang = autoRes.detectedLang
        effectiveSource = detectedLang
        effectiveTarget = pairAuto ? (detectedLang === pairA ? pairB : pairA) : req.targetLang
      } else {
        translatedText = await translateEngine.translate(sourceText, {
          sourceLang: req.sourceLang,
          targetLang: req.targetLang,
          style: req.style,
        })
      }
    } catch (retryErr) {
      throw retryErr instanceof Error ? retryErr : new Error('Translation failed')
    }
  }
  const translateMs = Date.now() - t0
  handlers.onStage({ utteranceId, stage: 'translate', status: 'done', ms: translateMs })

  if (!translatedText || translatedText === '[unclear]') {
    handlers.onResult({
      ...baseResult({ ...req, sourceLang: effectiveSource, targetLang: effectiveTarget }),
      sourceText,
      translatedText: '',
      detectedLang: auto ? detectedLang : undefined,
      timings: { asrMs, translateMs, ttsMs: 0, totalMs: Date.now() - startedAt },
    })
    return
  }

  pushHistory(sessionId, { source: sourceText, translated: translatedText })

  // ── Early text delivery: hand the translation to the UI before TTS ────
  handlers.onTranslation?.({
    utteranceId,
    sourceText,
    translatedText,
    sourceLang: effectiveSource,
    targetLang: effectiveTarget,
    voice: req.voice,
    speakerRole: req.speakerRole,
  })

  // ── Stage 3: Voice identity synthesis ────────────────────────────────────
  const t1 = Date.now()
  handlers.onStage({ utteranceId, stage: 'tts', status: 'start' })
  let audioBase64 = ''
  try {
    const audioBuffer = await voiceEngine.synthesize(translatedText, {
      voice: req.voice,
      speed: req.speed,
      pitchRatio: req.pitchRatio,
      profileMode: req.profileMode,
      providerProfileId: req.providerProfileId,
      providerModel: req.providerModel,
      stability: req.stability,
      providerSimilarity: req.providerSimilarity,
      providerStyle: req.providerStyle,
    })
    audioBase64 = audioBuffer.toString('base64')
  } catch (err) {
    handlers.onStage({ utteranceId, stage: 'tts', status: 'error' })
    handlers.onError({
      utteranceId,
      stage: 'tts',
      message: err instanceof Error ? err.message : 'Voice synthesis failed',
    })
    // Still deliver the text result so the UI shows the translation.
    handlers.onResult({
      ...baseResult({ ...req, sourceLang: effectiveSource, targetLang: effectiveTarget }),
      sourceText,
      translatedText,
      detectedLang: auto ? detectedLang : undefined,
      timings: { asrMs, translateMs, ttsMs: Date.now() - t1, totalMs: Date.now() - startedAt },
    })
    return
  }
  const ttsMs = Date.now() - t1
  handlers.onStage({ utteranceId, stage: 'tts', status: 'done', ms: ttsMs })

  handlers.onResult({
    ...baseResult({ ...req, sourceLang: effectiveSource, targetLang: effectiveTarget }),
    sourceText,
    translatedText,
    audioBase64,
    detectedLang: auto ? detectedLang : undefined,
    timings: { asrMs, translateMs, ttsMs, totalMs: Date.now() - startedAt },
  })
}

export async function processUtterance(req: UtteranceRequest, handlers: PipelineHandlers): Promise<void> {
  const startedAt = Date.now()
  const { utteranceId } = req

  try {
    // ── Stage 1: Speech recognition ────────────────────────────────────────
    handlers.onStage({ utteranceId, stage: 'asr', status: 'start' })
    const wav = pcmToWav(Buffer.from(req.audioBase64, 'base64'), req.sampleRate || 16000)
    const sourceText = await asrEngine.transcribe(wav.toString('base64'))
    const asrMs = Date.now() - startedAt
    handlers.onStage({ utteranceId, stage: 'asr', status: 'done', ms: asrMs })

    if (!sourceText || sourceText.length < 1) {
      // Nothing intelligible — end silently, client ignores empty results.
      handlers.onResult({
        ...baseResult(req),
        sourceText: '',
        translatedText: '',
        timings: { asrMs, translateMs: 0, ttsMs: 0, totalMs: Date.now() - startedAt },
      })
      return
    }

    await translateAndSpeak(req, sourceText, asrMs, startedAt, handlers)
  } catch (err) {
    handlers.onError({
      utteranceId,
      stage: 'asr',
      message: err instanceof Error ? err.message : 'Pipeline failure',
    })
  }
}

/** Typed-text variant of the pipeline: no ASR stage, translate + speak only. */
export async function processTextTranslate(req: TextTranslateRequest, handlers: PipelineHandlers): Promise<void> {
  const startedAt = Date.now()
  try {
    await translateAndSpeak(req, req.text, 0, startedAt, handlers)
  } catch (err) {
    handlers.onError({
      utteranceId: req.utteranceId,
      stage: 'translate',
      message: err instanceof Error ? err.message : 'Pipeline failure',
    })
  }
}

/**
 * Live-caption pass: transcribe a mid-speech snapshot only. Runs OUTSIDE the
 * utterance FIFO — best-effort, errors resolve to an empty transcript.
 */
export async function processAsrPartial(req: AsrPartialRequest): Promise<AsrPartialResult> {
  try {
    const wav = pcmToWav(Buffer.from(req.audioBase64, 'base64'), req.sampleRate || 16000)
    const text = await asrEngine.transcribe(wav.toString('base64'))
    return { utteranceId: req.utteranceId, text: (text ?? '').trim(), final: false }
  } catch {
    return { utteranceId: req.utteranceId, text: '', final: false }
  }
}
