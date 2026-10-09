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
  /** Echoed direction so the client can label transcript entries */
  sourceLang: string
  targetLang: string
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
}

/**
 * Emitted as soon as the translation stage completes — BEFORE TTS finishes —
 * so the UI can show text early while audio is still synthesizing.
 */
export interface TranslationEvent {
  utteranceId: string
  sourceText: string
  translatedText: string
  sourceLang: string
  targetLang: string
  voice: string
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
