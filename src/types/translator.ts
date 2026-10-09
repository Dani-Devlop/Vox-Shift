// Shared types between the Next.js client and the realtime translator service.

export type StyleMode = 'clean' | 'natural' | 'literal' | 'formal' | 'casual'

// ── Threads (persistent conversations) ─────────────────────────────────────

/** Thread settings overrides — absent keys inherit global preferences. */
export interface ThreadOverrides {
  style?: StyleMode
  mode?: Mode
  otherLang?: OtherLang
  voiceMode?: 'profile' | 'default'
  /** Per-thread voice profile choice: a VoiceProfile id overrides the global
   *  default profile (only meaningful while voiceMode is 'profile'). */
  profileId?: string
  playbackRate?: number
  bigButton?: boolean
}

/** Conversation row as returned by /api/conversations. */
export interface ConversationData {
  id: string
  title: string
  sourceLang: string
  targetLang: string
  hasOverrides?: boolean
  messageCount: number
  sessionCount: number
  createdAt: string
  lastActivityAt: string
}

/** One persisted message inside a thread (spec §5.4). */
export interface ThreadMessageData {
  id: string
  sessionId: string | null
  sequenceNo: number
  speakerRole: 'user' | 'other'
  sourceLang: string
  targetLang: string
  source: string
  translated: string
  style: string
  voice: string
  timings?: { asrMs: number; translateMs: number; ttsMs: number; totalMs: number } | null
  historyEntryId: string | null
  processingStatus: string
  createdAt: string
}

/** Thread detail (GET /api/conversations/[id]). */
export interface ThreadDetailData {
  conversation: {
    id: string
    title: string
    sourceLang: string
    targetLang: string
    overrides: ThreadOverrides | null
    createdAt: string
    lastActivityAt: string
  }
  sessions: { id: string; status: string; startedAt: string; endedAt: string | null }[]
  messages: ThreadMessageData[]
}

/** UI customization preferences (server-persisted, spec §4.4). */
export interface UIPrefs {
  textSize: 'sm' | 'md' | 'lg'
  compact: boolean
  showTranscript: boolean
}

// ── Language model ───────────────────────────────────────────────────────────
// The product speaks two sides: a fixed PERSIAN side and a selectable "other"
// side. Dub mode = Persian is the source (user speaks Persian, hears the other
// language). Interpreter mode = Persian is the target (user speaks the other
// language, reads Persian).

export type Mode = 'dub' | 'interpreter'

export interface ThreadSessionRef {
  conversationId: string
  sessionId: string
  /** Server status of the thread session ('live' | 'ended'). */
  status: string
}

export type OtherLang = 'en' | 'de' | 'fr' | 'es' | 'ar' | 'tr' | 'it'

export const OTHER_LANGS: readonly OtherLang[] = ['en', 'de', 'fr', 'es', 'ar', 'tr', 'it']

export interface LangMeta {
  flag: string
  name: string
  rtl: boolean
  /** Native-script hint shown in the type-to-translate input. */
  sampleHint: string
  /** Honest TTS capability for this language with the current engine:
   *  'native' = a tuned engine voice exists · 'beta' = translation works but
   *  the synthesized voice is accented (marked β in the UI, hideable). */
  tts: 'native' | 'beta'
}

export const LANG_META: Record<string, LangMeta> = {
  fa: { flag: '🇮🇷', name: 'Persian', rtl: true, sampleHint: 'سلام، حالت چطوره؟', tts: 'beta' },
  en: { flag: '🇬🇧', name: 'English', rtl: false, sampleHint: 'Hi, how are you doing today?', tts: 'native' },
  de: { flag: '🇩🇪', name: 'German', rtl: false, sampleHint: 'Guten Morgen, wie geht es dir?', tts: 'beta' },
  fr: { flag: '🇫🇷', name: 'French', rtl: false, sampleHint: "Bonjour, comment ça va aujourd'hui ?", tts: 'beta' },
  es: { flag: '🇪🇸', name: 'Spanish', rtl: false, sampleHint: 'Hola, ¿cómo estás hoy?', tts: 'beta' },
  ar: { flag: '🇸🇦', name: 'Arabic', rtl: true, sampleHint: 'مرحباً، كيف حالك اليوم؟', tts: 'beta' },
  tr: { flag: '🇹🇷', name: 'Turkish', rtl: false, sampleHint: 'Merhaba, bugün nasılsın?', tts: 'beta' },
  it: { flag: '🇮🇹', name: 'Italian', rtl: false, sampleHint: 'Ciao, come stai oggi?', tts: 'beta' },
}

export interface LangPair {
  sourceLang: string
  targetLang: string
}

export function getLangPair(mode: Mode, other: OtherLang): LangPair {
  return mode === 'dub'
    ? { sourceLang: 'fa', targetLang: other }
    : { sourceLang: other, targetLang: 'fa' }
}

/** Convenience flags for the pair, e.g. "🇮🇷 → 🇬🇧". */
export function langPairFlags(pair: LangPair): string {
  return `${LANG_META[pair.sourceLang]?.flag ?? '❓'} → ${LANG_META[pair.targetLang]?.flag ?? '❓'}`
}

export type PipelineStage = 'asr' | 'translate' | 'tts'

export interface StageEvent {
  utteranceId: string
  stage: PipelineStage
  status: 'start' | 'done' | 'error'
  ms?: number
}

/**
 * Early text delivery — emitted right after the translation stage, before TTS
 * completes. Lets the UI show translated text ~600ms after speech instead of
 * waiting for the full pipeline.
 */
export interface TranslationEvent {
  utteranceId: string
  sourceText: string
  translatedText: string
  /** Detected language when auto-detect ran, else the requested source. */
  sourceLang: string
  targetLang: string
  voice: string
  speakerRole?: SpeakerRole
}

/** Manual speaker-turn label for two-person conversations. The ASR engine
 *  provides NO diarization — attribution is an explicit user action and the
 *  UI must say so. */
export type SpeakerRole = 'A' | 'B'

export interface UtteranceResult {
  utteranceId: string
  sourceText: string
  translatedText: string
  audioBase64: string
  audioFormat: 'wav'
  voice: string
  /** 'clone' = real provider-cloned voice · 'voice-match' = pitch-conformed preset · 'default' */
  voiceMode?: 'clone' | 'voice-match' | 'default'
  /** Detected language when the AUTO direction was used (never 'auto'). */
  sourceLang: string
  targetLang: string
  /** Set when auto-detection ran. */
  detectedLang?: string
  /** Echoed speaker turn label ('A' default). */
  speakerRole?: SpeakerRole
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

/** Persisted history entry (GET /api/history). `hasAudio` reflects replayable
 *  disk-cached audio — entries can be replayed across page reloads via
 *  GET /api/history/{id}/audio. `starred` marks phrasebook entries;
 *  `sessionId` groups phrases captured in one start→stop session. */
export interface HistoryEntryData {
  id: string
  source: string
  translated: string
  sourceLang: string
  targetLang: string
  style: string
  voice: string
  timings: { asrMs: number; translateMs: number; ttsMs: number; totalMs: number }
  hasAudio: boolean
  starred?: boolean
  sessionId?: string | null
  createdAt: string
}
