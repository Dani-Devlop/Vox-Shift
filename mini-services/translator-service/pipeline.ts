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
import { LLMTranslationEngine, parseAutoPair, buildSystemPrompt, buildUserPrompt, buildAutoSystemPrompt, parseAutoReply, type TranslationContextTurn } from './engines/translator'
import { VoiceIdentityEngine } from './engines/voice'
import { openAICompatibleASR, openAICompatibleChat, routedCall } from './providers/router'
import { pcmToWav } from './engines/audio-utils'
import { computeVoiceprint } from '../../src/lib/speaker/voiceprint'
import type { SpeakerTracker } from './engines/speaker-tracker'

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline orchestrator (master prompt v2 §3):
//   Audio → [Voiceprint → Speaker Tracking] → ASR → Translation → TTS → Output
// Each layer is modular; the speaker layer is LOCAL (DSP voiceprint) and runs
// before ASR so identity is attached to every result. Every stage records the
// ACTUAL provider used; user-registered providers are tried first with real
// automatic failover to the built-in engines.
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
  speaker?: UtteranceResult['speaker']
  speakerMs?: number
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
    speaker: req.speaker,
    speakerMs: req.speakerMs,
  }
}

/** Compute the speaker attribution for an utterance (local, milliseconds). */
function attributeSpeaker(
  audioBase64: string,
  sampleRate: number,
  tracker: SpeakerTracker | undefined
): { speaker: UtteranceResult['speaker']; speakerMs: number } {
  if (!tracker) return { speaker: undefined, speakerMs: 0 }
  const t0 = Date.now()
  try {
    const pcm = Buffer.from(audioBase64, 'base64')
    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
    const vp = computeVoiceprint(int16, sampleRate || 16000)
    const speaker = tracker.assign(
      vp ? { vector: Array.from(vp.vector), speechSec: vp.quality.speechSec } : null,
      vp ? { pcm, sampleRate: sampleRate || 16000, speechSec: vp.quality.speechSec } : undefined
    )
    return { speaker: speaker ?? undefined, speakerMs: Date.now() - t0 }
  } catch {
    // Recognition must never break translation — continue without identity.
    return { speaker: undefined, speakerMs: Date.now() - t0 }
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
    speaker?: UtteranceResult['speaker']
    speakerMs?: number
  },
  sourceText: string,
  asrMs: number,
  asrProvider: string,
  startedAt: number,
  handlers: PipelineHandlers
): Promise<void> {
  const { utteranceId, sessionId } = req

  // ── Stage 2: Natural translation (with optional language auto-detect) ────
  const t0 = Date.now()
  handlers.onStage({ utteranceId, stage: 'translate', status: 'start' })
  let translatedText = ''
  // When the client picked the AUTO direction, the source language is unknown:
  // detection + translation happen in ONE call (no extra latency). With a
  // declared pair (sourceLang 'auto' + targetLang 'auto' + autoPair 'fa,en')
  // the TARGET is the OTHER side of the pair — a true bidirectional
  // conversation: speak fa → hear the pair's other language, and vice versa.
  const auto = req.sourceLang === 'auto'
  const pairAuto = auto && req.targetLang === 'auto'
  const [pairA, pairB] = pairAuto ? parseAutoPair(req.autoPair) : ['fa', 'en'] as [string, string]
  let detectedLang: string | undefined
  let effectiveSource = req.sourceLang
  let effectiveTarget = req.targetLang
  let translateProvider = 'builtin:zai-llm'

  /** Routed explicit-direction translation (user providers → built-in GLM). */
  const routedTranslate = async (history?: TranslationContextTurn[]): Promise<string> => {
    const system = buildSystemPrompt(req.sourceLang, req.targetLang, req.style)
    const user = buildUserPrompt(sourceText, history)
    const res = await routedCall<string>('translate', {
      user: (p) => openAICompatibleChat(p, system, user, 0.3),
      builtin: () => translateEngine.translate(sourceText, {
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        style: req.style,
        history,
      }),
    })
    translateProvider = res.providerId
    return res.value
  }

  /** Routed AUTO translation (detect + translate in one provider call). */
  const routedTranslateAuto = async (history?: TranslationContextTurn[]): Promise<{ text: string; detectedLang: string }> => {
    const system = buildAutoSystemPrompt(pairAuto ? pairA : req.targetLang, req.style, pairAuto ? [pairA, pairB] : undefined)
    const user = buildUserPrompt(sourceText, history)
    const res = await routedCall<string>('translate', {
      user: (p) => openAICompatibleChat(p, system, user, 0.2),
      builtin: () =>
        translateEngine.translateAuto(sourceText, {
          targetLang: pairAuto ? pairA : req.targetLang,
          style: req.style,
          history,
          candidates: pairAuto ? [pairA, pairB] : undefined,
        }).then((r) => `DETECTED: ${r.detectedLang}\nTRANSLATION: ${r.text}`),
    })
    translateProvider = res.providerId
    const parsed = parseAutoReply(res.value, pairAuto ? [pairA, pairB] : undefined)
    if (parsed.text) return parsed
    // Provider ignored the format — treat the whole reply as the translation.
    return { detectedLang: req.targetLang === 'fa' ? 'en' : 'fa', text: res.value.slice(0, 500) }
  }

  try {
    if (auto) {
      const autoRes = await routedTranslateAuto(getHistory(sessionId))
      translatedText = autoRes.text
      detectedLang = autoRes.detectedLang
      effectiveSource = detectedLang
      effectiveTarget = pairAuto ? (detectedLang === pairA ? pairB : pairA) : req.targetLang
      if (!pairAuto) {
        // Detected language outside candidates still translates to the fixed target.
        effectiveTarget = req.targetLang
      }
    } else {
      translatedText = await routedTranslate(getHistory(sessionId))
    }
  } catch {
    // One retry on transient failure (real failover already ran inside the router).
    try {
      if (auto) {
        const autoRes = await routedTranslateAuto()
        translatedText = autoRes.text
        detectedLang = autoRes.detectedLang
        effectiveSource = detectedLang
        effectiveTarget = pairAuto ? (detectedLang === pairA ? pairB : pairA) : req.targetLang
      } else {
        translatedText = await routedTranslate()
      }
    } catch (retryErr) {
      throw retryErr instanceof Error ? retryErr : new Error('Translation failed')
    }
  }
  const translateMs = Date.now() - t0
  handlers.onStage({ utteranceId, stage: 'translate', status: 'done', ms: translateMs })

  const usedProviders = { asr: asrProvider, translate: translateProvider, tts: 'pending' }

  if (!translatedText || translatedText === '[unclear]') {
    handlers.onResult({
      ...baseResult({ ...req, sourceLang: effectiveSource, targetLang: effectiveTarget }),
      sourceText,
      translatedText: '',
      detectedLang: auto ? detectedLang : undefined,
      providers: { ...usedProviders, tts: '' },
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
    speaker: req.speaker,
  })

  // ── Stage 3: Voice identity synthesis (clone → provider chain → built-in) ─
  const t1 = Date.now()
  handlers.onStage({ utteranceId, stage: 'tts', status: 'start' })
  let audioBase64 = ''
  let audioFormat: 'wav' | 'mp3' = 'wav'
  let ttsProvider = 'builtin:zai-tts'
  try {
    const synth = await voiceEngine.synthesize(translatedText, {
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
    audioBase64 = synth.buffer.toString('base64')
    audioFormat = synth.format
    ttsProvider = synth.providerId
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
      providers: { ...usedProviders, tts: `${ttsProvider} (failed)` },
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
    audioFormat,
    detectedLang: auto ? detectedLang : undefined,
    providers: { ...usedProviders, tts: ttsProvider },
    timings: { asrMs, translateMs, ttsMs, totalMs: Date.now() - startedAt },
  })
}

export async function processUtterance(
  req: UtteranceRequest,
  handlers: PipelineHandlers,
  tracker?: SpeakerTracker
): Promise<void> {
  const startedAt = Date.now()
  const { utteranceId } = req

  try {
    // ── Stage 0: Speaker recognition (LOCAL voiceprint — spec v2 §3/§16) ───
    // Identity is computed BEFORE ASR so it attaches to everything below.
    const { speaker, speakerMs } = attributeSpeaker(req.audioBase64, req.sampleRate, tracker)

    // ── Stage 1: Speech recognition (user providers → built-in z-ai ASR) ───
    handlers.onStage({ utteranceId, stage: 'asr', status: 'start' })
    const pcm = Buffer.from(req.audioBase64, 'base64')
    const wav = pcmToWav(pcm, req.sampleRate || 16000)
    const wavBase64 = wav.toString('base64')
    let sourceText = ''
    let asrProvider = 'builtin:zai-asr'
    const routed = await routedCall<string>('asr', {
      user: (p) => openAICompatibleASR(p, wavBase64),
      builtin: () => asrEngine.transcribe(wavBase64),
    })
    sourceText = routed.value
    asrProvider = routed.providerId
    const asrMs = Date.now() - startedAt
    handlers.onStage({ utteranceId, stage: 'asr', status: 'done', ms: asrMs })

    if (!sourceText || sourceText.length < 1) {
      // Nothing intelligible — end silently, client ignores empty results.
      handlers.onResult({
        ...baseResult({ ...req, speaker, speakerMs }),
        sourceText: '',
        translatedText: '',
        providers: { asr: asrProvider, translate: '', tts: '' },
        timings: { asrMs, translateMs: 0, ttsMs: 0, totalMs: Date.now() - startedAt },
      })
      return
    }

    await translateAndSpeak(
      { ...req, speaker, speakerMs },
      sourceText,
      asrMs,
      asrProvider,
      startedAt,
      handlers
    )
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
    await translateAndSpeak(req, req.text, 0, 'typed text', startedAt, handlers)
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
