// Shared types for the realtime translation pipeline.
// Engines are fully modular: Translation Layer + Voice Layer are independent
// and swappable (see README in project root).

export type StyleMode = 'clean' | 'natural' | 'literal' | 'formal' | 'casual'

export interface UtteranceRequest {
  utteranceId: string
  sessionId: string
  /** Base64-encoded raw PCM, Int16 little-endian, mono */
  audioBase64: string
  sampleRate: number
  sourceLang: string // e.g. 'fa'
  targetLang: string // e.g. 'en'
  style: StyleMode
  /** Engine voice id to use for synthesis ('default' → engine fallback) */
  voice: string
  /** TTS speed factor (0.5 .. 2.0) */
  speed: number
  /** Pitch-conformance ratio (user F0 ÷ engine voice F0). 1/undefined = no shift. */
  pitchRatio?: number
  /** 'clone' → provider-cloned voice (real cloning engine); 'voice-match' → pitch-conformed preset. */
  profileMode?: 'clone' | 'voice-match'
  /** Provider-side voice id (ElevenLabs voice_id) for cloned profiles. */
  providerProfileId?: string
  /** Cloning model key ('balanced' | 'quality') selected on the profile. */
  providerModel?: string
  /** Cloner stability 0..1 (higher = steadier, lower = more expressive). */
  stability?: number
  /** Provider similarity boost 0..1 (clone mode only). */
  providerSimilarity?: number
  /** Provider style exaggeration 0..0.45 (clone mode only). */
  providerStyle?: number
  /** Speaker turn label for two-person interpreter conversations.
   *  'A' = primary speaker, 'B' = second speaker (opposite direction).
   *  Manual attribution — the ASR engine provides NO diarization; the UI
   *  must state that honestly. */
  speakerRole?: 'A' | 'B'
  /** Pair spec for AUTO conversations ('fa,en'): detect source → target is
   *  the OTHER member. Only used when sourceLang/targetLang are 'auto'. */
  autoPair?: string
}

export type PipelineStage = 'asr' | 'translate' | 'tts'

export interface StageEvent {
  utteranceId: string
  stage: PipelineStage
  status: 'start' | 'done' | 'error'
  ms?: number
}

export interface UtteranceResult {
  utteranceId: string
  sourceText: string
  translatedText: string
  /** Base64 WAV (24kHz) synthesized speech, empty if nothing to speak */
  audioBase64: string
  audioFormat: 'wav'
  voice: string
  /** How the audio was produced: provider-cloned voice, pitch-conformed
   *  preset, or the pipeline default. The UI must label this honestly. */
  voiceMode?: 'clone' | 'voice-match' | 'default'
  /** Echoed direction so the client can label transcript entries.
   *  When the request used sourceLang 'auto', this is the DETECTED language
   *  (never the literal string 'auto'). */
  sourceLang: string
  targetLang: string
  /** Set when auto-detection ran — the language the ASR text was recognized as. */
  detectedLang?: string
  /** Echoed speaker turn label ('A' default). */
  speakerRole?: 'A' | 'B'
  timings: {
    asrMs: number
    translateMs: number
    ttsMs: number
    totalMs: number
  }
}

export interface UtteranceError {
  utteranceId: string
  stage: PipelineStage | 'queue'
  message: string
}

/** Typed-text request — skips ASR, shares the translate + TTS stages. */
export interface TextTranslateRequest {
  utteranceId: string
  sessionId: string
  text: string
  sourceLang: string
  targetLang: string
  style: StyleMode
  voice: string
  speed: number
  /** Pitch-conformance ratio (user F0 ÷ engine voice F0). 1/undefined = no shift. */
  pitchRatio?: number
  /** 'clone' → provider-cloned voice (real cloning engine); 'voice-match' → pitch-conformed preset. */
  profileMode?: 'clone' | 'voice-match'
  /** Provider-side voice id (ElevenLabs voice_id) for cloned profiles. */
  providerProfileId?: string
  /** Cloning model key ('balanced' | 'quality') selected on the profile. */
  providerModel?: string
  /** Cloner stability 0..1 (higher = steadier, lower = more expressive). */
  stability?: number
  /** Provider similarity boost 0..1 (clone mode only). */
  providerSimilarity?: number
  /** Provider style exaggeration 0..0.45 (clone mode only). */
  providerStyle?: number
  /** Speaker turn label — see UtteranceRequest.speakerRole. */
  speakerRole?: 'A' | 'B'
  /** Pair spec for AUTO conversations — see UtteranceRequest.autoPair. */
  autoPair?: string
}

/**
 * Emitted as soon as the translation stage completes — BEFORE TTS finishes —
 * so the UI can show text early while audio is still synthesizing.
 */
export interface TranslationEvent {
  utteranceId: string
  sourceText: string
  translatedText: string
  /** Detected language when auto-detect ran, else the requested source. */
  sourceLang: string
  targetLang: string
  voice: string
  speakerRole?: 'A' | 'B'
}

/**
 * Live-caption request: a mid-speech snapshot of the current utterance, run
 * through ASR only (no translation/TTS) so the UI can show partial source text
 * while the user is still talking. Fire-and-forget — never enters the FIFO.
 */
export interface AsrPartialRequest {
  utteranceId: string
  sessionId: string
  /** Base64-encoded raw PCM (Int16 LE mono) snapshot so far */
  audioBase64: string
  sampleRate: number
  sourceLang: string
}

export interface AsrPartialResult {
  utteranceId: string
  /** Best-effort transcript of the snapshot ('' when nothing intelligible) */
  text: string
  final: boolean
}

export const DEFAULTS = {
  sourceLang: 'fa',
  targetLang: 'en',
  style: 'natural' as StyleMode,
  voice: 'default',
  speed: 1.0,
  sampleRate: 16000,
}
