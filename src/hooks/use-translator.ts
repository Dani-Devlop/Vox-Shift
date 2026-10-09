'use client'

// ─────────────────────────────────────────────────────────────────────────────
// useTranslator — the client-side live translation state machine.
// Wires: MicRecorder (VAD utterances) → socket.io pipeline → AudioPlayer.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MicRecorder } from '@/lib/audio/mic-recorder'
import { TranslationAudioPlayer } from '@/lib/audio/translation-player'
import { getTranslatorSocket } from '@/lib/realtime/socket'
import type {
  ConversationData,
  HistoryEntryData,
  LangPair,
  Mode,
  OtherLang,
  PipelineStage,
  SpeakerRole,
  StyleMode,
  StageEvent,
  ThreadDetailData,
  ThreadMessageData,
  ThreadOverrides,
  ThreadSessionRef,
  TranslationEvent,
  UIPrefs,
  UtteranceError,
  UtteranceResult,
} from '@/types/translator'
import { getLangPair } from '@/types/translator'
import { useToast } from '@/hooks/use-toast'

export interface VoiceProfileData {
  id: string
  name: string
  isActive: boolean
  /** 'clone' = real provider-cloned voice · 'voice-match' = pitch-conformed preset */
  mode: 'clone' | 'voice-match'
  meanF0: number
  f0Std: number
  f0Min: number
  f0Max: number
  spectralCentroid: number
  estimatedGender: string
  voiceCharacter: string
  mappedVoice: string
  speedAdjust: number
  /** Pitch-conformance ratio — the user's F0 ÷ engine voice F0. */
  pitchRatio: number
  speakingRate: number
  sampleDuration: number
  /** Sample-quality diagnostics captured at enrollment. */
  clippingRatio: number
  snrDb: number
  engine: string
  /** Provider-side voice id (cloned profiles). */
  providerProfileId: string | null
  /** Cloning model key ('balanced' | 'quality'). */
  providerModel: string | null
  /** Cloner stability 0..1. */
  stability: number
  /** Provider similarity boost 0..1 (clone mode only). */
  providerSimilarity?: number
  /** Provider style exaggeration 0..0.45 (clone mode only). */
  providerStyle?: number
  /** Number of takes merged into this profile (1..3). */
  sampleCount?: number
}

export interface TranscriptEntry {
  id: string
  source: string
  translated: string
  timings: { asrMs: number; translateMs: number; ttsMs: number; totalMs: number }
  voice: string
  /** How the audio was produced — the UI must label this honestly. */
  voiceMode?: 'clone' | 'voice-match' | 'default'
  sourceLang: string
  targetLang: string
  /** Speaker turn ('A' default) — manual attribution, no engine diarization. */
  speakerRole?: SpeakerRole
  /** True when synthesized audio was delivered and may be replayable. */
  hasAudio: boolean
  createdAt: number
}

export type TranslatorStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'user-speaking'
  | 'processing'
  | 'speaking'
  | 'reconnecting'

/** Early-delivered translation shown before audio finishes synthesizing. */
export interface TranslationPartial {
  utteranceId: string
  source: string
  translated: string
  sourceLang: string
  targetLang: string
  voice: string
  speakerRole?: SpeakerRole
}

/** Live caption — partial ASR text while the user is still speaking. */
export interface LiveCaption {
  id: string
  text: string
  /** Elapsed speech time in ms (drives the caption timer chip). */
  elapsedMs: number
}

/** Client settings persisted to localStorage + server preferences. */
interface PersistedSettings {
  mode?: Mode
  otherLang?: OtherLang
  style?: StyleMode
  voiceMode?: 'profile' | 'default'
  playbackRate?: number
  bigButton?: boolean
  /** UI customization (spec §4.4) — server-synced too. */
  textSize?: UIPrefs['textSize']
  compact?: boolean
  showTranscript?: boolean
  /** Global behavior toggles (spec §6 settings center). */
  autoSaveHistory?: boolean
  useContext?: boolean
  showCaptions?: boolean
  /** AUTO direction: detect the spoken language per utterance and translate
   *  to the OTHER side of the pair (fa ↔ otherLang). */
  autoDetect?: boolean
  /** Show β (accented-TTS) languages in pickers — honest capability labels. */
  betaLangs?: boolean
  /** Auto-delete unstarred history older than N days (0 = keep forever). */
  historyRetentionDays?: number
}

const SETTINGS_KEY = 'lt-settings'
const STYLES: readonly StyleMode[] = ['clean', 'natural', 'literal', 'formal', 'casual']
const PREFS_SAVE_DEBOUNCE_MS = 800

export interface LatencyStats {
  count: number
  lastTotalMs: number
  avgTotalMs: number
  avgAsrMs: number
  avgTranslateMs: number
  avgTtsMs: number
  /** Fastest / slowest phrase this session — shows pipeline consistency. */
  minTotalMs: number
  maxTotalMs: number
}

const DEFAULT_VOICE = 'kazi'
const OTHER_LANG_GUARDS: readonly string[] = ['en', 'de', 'fr', 'es', 'ar', 'tr', 'it']
const PLAYBACK_RATES: readonly number[] = [0.75, 1, 1.25, 1.5]

export function useTranslator() {
  const { toast } = useToast()

  const [status, setStatus] = useState<TranslatorStatus>('idle')
  const [connected, setConnected] = useState(false)
  const [activeStage, setActiveStage] = useState<PipelineStage | null>(null)
  const [level, setLevel] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [profile, setProfile] = useState<VoiceProfileData | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  /** Honest voice-identity capability report (from /api/voice-profile). */
  const [capabilities, setCapabilities] = useState<{
    canClone: boolean
    cloneConfigured: boolean
    engine: string
    mode: string
    note?: string
    setup?: { envVar: string; envFile: string; steps: string[] } | null
  } | null>(null)
  /** Per-thread voice profile override (ThreadOverrides.profileId). */
  const [threadProfileId, setThreadProfileId] = useState<string | null>(null)
  const threadProfileIdRef = useRef<string | null>(null)
  const [style, setStyle] = useState<StyleMode>('natural')
  const [voiceMode, setVoiceMode] = useState<'profile' | 'default'>('profile')
  const [mode, setModeState] = useState<Mode>('dub')
  const [otherLang, setOtherLangState] = useState<OtherLang>('en')
  /** Output playback speed (0.75×–1.5×) — persisted, applies live. */
  const [playbackRate, setPlaybackRateState] = useState<number>(1)
  /** Big-button talk mode — oversized push-to-talk for phone interpreters. */
  const [bigButton, setBigButtonState] = useState<boolean>(false)
  /** AUTO direction + language availability + history retention (persisted). */
  const [autoDetect, setAutoDetectState] = useState(false)
  const [betaLangs, setBetaLangsState] = useState(true)
  const [historyRetentionDays, setHistoryRetentionDaysState] = useState(0)
  /** Manual speaker turn for two-person conversations ('A' = primary). NOT
   *  persisted — a per-session state. The engine has NO diarization; this is
   *  an explicit user action and the UI says so. */
  const [speaker, setSpeakerState] = useState<SpeakerRole>('A')
  const langPair = useMemo<LangPair>(
    () =>
      // AUTO direction: detect the spoken language per utterance; the server
      // picks the target as the OTHER side of the declared pair (autoPair).
      autoDetect ? { sourceLang: 'auto', targetLang: 'auto' } : getLangPair(mode, otherLang),
    [mode, otherLang, autoDetect]
  )
  /** The two sides of an AUTO conversation, e.g. 'fa,en'. */
  const autoPair = useMemo(() => `fa,${otherLang}`, [otherLang])
  /** Languages offered in pickers — β (accented-TTS) ones hideable. */
  const availableOtherLangs = useMemo<OtherLang[]>(
    () => (betaLangs ? ['en', 'de', 'fr', 'es', 'ar', 'tr', 'it'] : ['en']),
    [betaLangs]
  )
  const [stats, setStats] = useState<LatencyStats>({
    count: 0,
    lastTotalMs: 0,
    avgTotalMs: 0,
    avgAsrMs: 0,
    avgTranslateMs: 0,
    avgTtsMs: 0,
    minTotalMs: 0,
    maxTotalMs: 0,
  })

  const recorderRef = useRef<MicRecorder | null>(null)
  const playerRef = useRef<TranslationAudioPlayer | null>(null)
  const modeRef = useRef(mode)
  const otherLangRef = useRef(otherLang)
  const styleRef = useRef(style)
  const voiceModeRef = useRef(voiceMode)
  const profileRef = useRef(profile)
  const statusRef = useRef(status)
  const langPairRef = useRef(langPair)
  const playbackRateRef = useRef(playbackRate)
  const bigButtonRef = useRef(bigButton)
  /** Pair spec for AUTO conversations ('fa,<other>') — mirrors otherLang. */
  const autoPairRef = useRef('fa,en')
  /** Tail timer for the playback echo-guard (spec §9). */
  const echoTailRef = useRef<number | null>(null)
  /** Rolling audio cache for transcript replay (last 12 utterances). */
  const audioCacheRef = useRef(new Map<string, string>())
  /** Early-delivered translation (translation event) awaiting its audio. */
  const [partial, setPartial] = useState<TranslationPartial | null>(null)
  /** Live caption while the user is speaking (partial ASR). */
  const [liveCaption, setLiveCaption] = useState<LiveCaption | null>(null)
  /** Utterances sent but not yet completed (queue-depth transparency). */
  const [pendingCount, setPendingCount] = useState(0)
  /** Total captured speech time this session (ms) — drives the session recap. */
  const [sessionSpeechMs, setSessionSpeechMs] = useState(0)
  /** Language pairs used this session, e.g. ['fa→en'] — drives the recap chips. */
  const [sessionLangs, setSessionLangs] = useState<string[]>([])
  /** Server-persisted history; null = not loaded yet (loaded lazily). */
  const [history, setHistory] = useState<HistoryEntryData[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  /** One partial-ASR request in flight at a time (client-side guard). */
  const partialBusyRef = useRef(false)
  const partialTimeoutRef = useRef<number | null>(null)
  /** Caption utterance id — one per speech segment (set at VAD onset). */
  const captionIdRef = useRef('')
  /** Client-side history session id — one start→stop cycle (or typed-phrase
   *  streak) groups related phrases in Saved History. */
  const historySessionIdRef = useRef<string | null>(null)
  /** UI customization prefs (text size / compact / transcript visibility). */
  const [uiPrefs, setUiPrefs] = useState<UIPrefs>({ textSize: 'md', compact: false, showTranscript: true })
  /** Global behavior toggles (spec §6 settings center) — persisted + synced. */
  const [autoSaveHistory, setAutoSaveHistoryState] = useState(true)
  const [useContext, setUseContextState] = useState(true)
  const [showCaptions, setShowCaptionsState] = useState(true)
  /** All enrolled voice profiles (spec §5.2 — multiple profiles). */
  const [profiles, setProfiles] = useState<VoiceProfileData[]>([])
  /** Behavior-toggle refs (kept beside the states they mirror). */
  const autoSaveRef = useRef(autoSaveHistory)
  const useContextRef = useRef(useContext)
  const showCaptionsRef = useRef(showCaptions)
  const autoDetectRef = useRef(autoDetect)
  const betaLangsRef = useRef(betaLangs)
  const speakerRef = useRef(speaker)
  /** True once the initial localStorage+server preference load finished —
   *  prevents a defaults-save from clobbering stored preferences on boot. */
  const prefsHydratedRef = useRef(false)
  const prefsSaveTimerRef = useRef<number | null>(null)
  // ── Threads (persistent conversations) ───────────────────────────────────
  const [conversations, setConversations] = useState<ConversationData[] | null>(null)
  const [conversationsLoading, setConversationsLoading] = useState(false)
  const [activeThread, setActiveThread] = useState<ThreadDetailData | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadSession, setThreadSession] = useState<ThreadSessionRef | null>(null)
  const activeThreadIdRef = useRef<string | null>(null)
  const threadSessionRef = useRef<ThreadSessionRef | null>(null)
  /** Snapshot of global settings taken when a thread applies overrides —
   *  restored on close so a thread can never mutate global defaults. */
  const settingsSnapshotRef = useRef<{
    mode: Mode
    otherLang: OtherLang
    style: StyleMode
    voiceMode: 'profile' | 'default'
    playbackRate: number
    bigButton: boolean
  } | null>(null)
  /** Recently emitted payloads (last 3) — powers failed-segment retry. */
  const payloadCacheRef = useRef(new Map<string, { kind: 'audio' | 'text'; data: Record<string, unknown> }>())
  /** Last failed segment with its retry payload (null = nothing to retry). */
  const [lastError, setLastError] = useState<{
    utteranceId: string
    stage: string
    message: string
    payload: { kind: 'audio' | 'text'; data: Record<string, unknown> } | null
  } | null>(null)

  autoPairRef.current = `fa,${otherLangRef.current}`
  styleRef.current = style
  voiceModeRef.current = voiceMode
  profileRef.current = profile
  threadProfileIdRef.current = threadProfileId
  statusRef.current = status
  langPairRef.current = langPair
  playbackRateRef.current = playbackRate
  bigButtonRef.current = bigButton
  autoSaveRef.current = autoSaveHistory
  useContextRef.current = useContext
  showCaptionsRef.current = showCaptions
  autoDetectRef.current = autoDetect
  betaLangsRef.current = betaLangs
  speakerRef.current = speaker

  // ── Voice profiles (REST) ────────────────────────────────────────────────
  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/voice-profile', { cache: 'no-store' })
      const data = await res.json()
      const list: VoiceProfileData[] = Array.isArray(data?.profiles) ? data.profiles : []
      setProfiles(list)
      setProfile(list.find((p) => p.isActive) ?? null)
      if (data?.capabilities) setCapabilities(data.capabilities)
    } catch {
      // Non-fatal
    } finally {
      setProfileLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProfile()
  }, [loadProfile])

  // ── Settings persistence (localStorage + server preferences) ────────────
  // Load once after mount (deferred to a macrotask; avoids both hydration
  // mismatch with SSR and synchronous setState-in-effect). Server preferences
  // (anonymous cookie user) are fetched right after and win over localStorage
  // when present — they survive browser restarts and even other devices.

  /** Apply a validated settings object to state (shared by both loaders). */
  const applySettings = useCallback((s: PersistedSettings) => {
    if (s.mode === 'dub' || s.mode === 'interpreter') {
      modeRef.current = s.mode
      setModeState(s.mode)
    }
    if (s.otherLang && OTHER_LANG_GUARDS.includes(s.otherLang)) {
      otherLangRef.current = s.otherLang
      setOtherLangState(s.otherLang)
    }
    if (s.style && STYLES.includes(s.style)) setStyle(s.style)
    if (s.voiceMode === 'profile' || s.voiceMode === 'default') setVoiceMode(s.voiceMode)
    if (typeof s.playbackRate === 'number' && PLAYBACK_RATES.includes(s.playbackRate)) {
      playbackRateRef.current = s.playbackRate
      setPlaybackRateState(s.playbackRate)
    }
    if (typeof s.bigButton === 'boolean') setBigButtonState(s.bigButton)
    if (s.textSize === 'sm' || s.textSize === 'md' || s.textSize === 'lg') {
      setUiPrefs((prev) => ({ ...prev, textSize: s.textSize! }))
    }
    if (typeof s.compact === 'boolean') setUiPrefs((prev) => ({ ...prev, compact: s.compact! }))
    if (typeof s.showTranscript === 'boolean') setUiPrefs((prev) => ({ ...prev, showTranscript: s.showTranscript! }))
    if (typeof s.autoSaveHistory === 'boolean') setAutoSaveHistoryState(s.autoSaveHistory)
    if (typeof s.useContext === 'boolean') setUseContextState(s.useContext)
    if (typeof s.showCaptions === 'boolean') setShowCaptionsState(s.showCaptions)
    if (typeof s.autoDetect === 'boolean') setAutoDetectState(s.autoDetect)
    if (typeof s.betaLangs === 'boolean') setBetaLangsState(s.betaLangs)
    if ([0, 7, 30, 90].includes(Number(s.historyRetentionDays))) {
      setHistoryRetentionDaysState(Number(s.historyRetentionDays))
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (raw) {
          const s = JSON.parse(raw) as PersistedSettings
          applySettings(s)
        }
      } catch {
        // Corrupt/absent settings — keep defaults.
      }
    }, 0)
    return () => clearTimeout(t)
  }, [applySettings])

  // Server preferences (spec §4.1): authoritative when available.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/preferences', { cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!cancelled && data?.preferences && typeof data.preferences === 'object') {
          applySettings(data.preferences as PersistedSettings)
        }
      } catch {
        // Offline / API down — localStorage fallback already applied.
      } finally {
        if (!cancelled) prefsHydratedRef.current = true
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [applySettings])

  // Save whenever any persisted setting changes: localStorage immediately,
  // server preferences debounced (and only after the initial load finished —
  // never overwrite stored prefs with pre-hydration defaults).
  // While a thread is open its overrides temporarily change the live settings;
  // persistence is suppressed so thread overrides can never leak into the
  // stored global defaults (spec §4.2) — closing the thread restores them.
  useEffect(() => {
    const t = setTimeout(() => {
      if (activeThreadIdRef.current) return // inside a thread — do not persist
      try {
        const s: PersistedSettings = { mode, otherLang, style, voiceMode, playbackRate, bigButton, textSize: uiPrefs.textSize, compact: uiPrefs.compact, showTranscript: uiPrefs.showTranscript, autoSaveHistory, useContext, showCaptions, autoDetect, betaLangs, historyRetentionDays }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
      } catch {
        // Storage unavailable — persistence is a convenience only.
      }
    }, 0)
    return () => clearTimeout(t)
  }, [mode, otherLang, style, voiceMode, playbackRate, bigButton, uiPrefs, autoSaveHistory, useContext, showCaptions, autoDetect, betaLangs, historyRetentionDays])

  useEffect(() => {
    if (!prefsHydratedRef.current) return
    if (activeThreadIdRef.current) return // inside a thread — do not persist
    if (prefsSaveTimerRef.current !== null) window.clearTimeout(prefsSaveTimerRef.current)
    prefsSaveTimerRef.current = window.setTimeout(() => {
      prefsSaveTimerRef.current = null
      void fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, otherLang, style, voiceMode, playbackRate, bigButton, textSize: uiPrefs.textSize, compact: uiPrefs.compact, showTranscript: uiPrefs.showTranscript, autoSaveHistory, useContext, showCaptions, autoDetect, betaLangs, historyRetentionDays }),
      }).catch(() => {})
    }, PREFS_SAVE_DEBOUNCE_MS)
    return () => {
      if (prefsSaveTimerRef.current !== null) {
        window.clearTimeout(prefsSaveTimerRef.current)
        prefsSaveTimerRef.current = null
      }
    }
  }, [mode, otherLang, style, voiceMode, playbackRate, bigButton, uiPrefs, autoSaveHistory, useContext, showCaptions, autoDetect, betaLangs, historyRetentionDays])

  // ── UI customization setters (spec §4.4) ────────────────────────────────
  const setTextSize = useCallback((size: UIPrefs['textSize']) => setUiPrefs((prev) => ({ ...prev, textSize: size })), [])
  const setCompact = useCallback((on: boolean) => setUiPrefs((prev) => ({ ...prev, compact: on })), [])
  const setShowTranscript = useCallback((on: boolean) => setUiPrefs((prev) => ({ ...prev, showTranscript: on })), [])
  const setAutoSaveHistory = useCallback((on: boolean) => setAutoSaveHistoryState(on), [])
  const setUseContext = useCallback((on: boolean) => setUseContextState(on), [])
  const setShowCaptions = useCallback((on: boolean) => setShowCaptionsState(on), [])
  /** AUTO direction switch — resets pipeline context (language-pair specific). */
  const setAutoDetect = useCallback(
    (on: boolean) => {
      autoDetectRef.current = on
      setAutoDetectState(on)
      const s = getTranslatorSocket()
      if (s.connected) s.emit('session:reset')
    },
    []
  )
  const setBetaLangs = useCallback((on: boolean) => {
    betaLangsRef.current = on
    setBetaLangsState(on)
  }, [])
  const setHistoryRetentionDays = useCallback((days: number) => {
    setHistoryRetentionDaysState([0, 7, 30, 90].includes(days) ? days : 0)
  }, [])
  /** Manual speaker turn — applies to the NEXT utterance; no reset needed. */
  const setSpeaker = useCallback((role: SpeakerRole) => {
    speakerRef.current = role
    setSpeakerState(role)
  }, [])

  const setBigButton = useCallback((on: boolean) => setBigButtonState(on), [])

  /** Reuse (or lazily create) the current history-session id. */
  const ensureHistorySessionId = useCallback(() => {
    if (!historySessionIdRef.current) {
      historySessionIdRef.current = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }
    return historySessionIdRef.current
  }, [])

  /** Clear caption state + in-flight partial request guards. */
  const resetCaptionState = useCallback(() => {
    setLiveCaption(null)
    captionIdRef.current = ''
    partialBusyRef.current = false
    if (partialTimeoutRef.current !== null) {
      window.clearTimeout(partialTimeoutRef.current)
      partialTimeoutRef.current = null
    }
  }, [])

  /**
   * Output playback speed — applies to the live player (if any) immediately
   * and to every player created later.
   */
  const setPlaybackRate = useCallback((rate: number) => {
    const safe = Math.min(2, Math.max(0.5, Number(rate) || 1))
    playbackRateRef.current = safe
    setPlaybackRateState(safe)
    playerRef.current?.setRate(safe)
  }, [])

  /**
   * The profile actually used for synthesis: a thread-level override wins over
   * the global active profile (per-thread voice selection).
   */
  const effectiveProfile = useCallback((): VoiceProfileData | null => {
    if (voiceModeRef.current !== 'profile') return null
    const overrideId = threadProfileIdRef.current
    if (overrideId) {
      const override = profiles.find((p) => p.id === overrideId)
      if (override) return override
    }
    return profileRef.current
  }, [profiles])

  /** Reactive version for labels/UI: thread override → else global active. */
  const effectiveVoiceProfile = useMemo<VoiceProfileData | null>(() => {
    if (threadProfileId) {
      const override = profiles.find((p) => p.id === threadProfileId)
      if (override) return override
    }
    return profile
  }, [threadProfileId, profiles, profile])

  /** Cloning advanced settings (model / stability / similarity / style) for one cloned profile. */
  const updateCloneSettings = useCallback(
    async (
      id: string,
      patch: {
        providerModel?: 'balanced' | 'quality'
        stability?: number
        providerSimilarity?: number
        providerStyle?: number
      }
    ): Promise<boolean> => {
      try {
        const res = await fetch('/api/voice-profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...patch }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error ?? 'Request failed')
        const list: VoiceProfileData[] = Array.isArray(data?.profiles) ? data.profiles : []
        setProfiles(list)
        setProfile((prev) => (prev && prev.id === id ? data.profile : prev))
        return true
      } catch (err) {
        toast({ title: 'Could not update voice settings', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  const createProfile = useCallback(
    async (
      audioBase64: string,
      sampleRate: number,
      consented: boolean,
      name?: string,
      cloneOpts?: {
        providerModel?: 'balanced' | 'quality'
        stability?: number
        providerSimilarity?: number
        providerStyle?: number
        /** Up to 2 EXTRA takes (raw PCM base64, same sampleRate) — merged into
         *  one stronger provider embedding (multi-sample enrollment). */
        extraSamples?: string[]
      }
    ): Promise<VoiceProfileData | null> => {
      setProfileLoading(true)
      try {
        const res = await fetch('/api/voice-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64, sampleRate, consented, name, ...cloneOpts }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast({ title: 'Voice profile failed', description: data.error ?? 'Unknown error', variant: 'destructive' })
          return null
        }
        if (data.capabilities) setCapabilities(data.capabilities)
        const list: VoiceProfileData[] = Array.isArray(data?.profiles) ? data.profiles : []
        setProfiles(list)
        setProfile(data.profile)
        if (data.profile.mode === 'clone') {
          toast({
            title: 'Voice clone ready ✓',
            description: `“${data.profile.name}” is a real cloned voice — translations are now spoken with YOUR enrolled voice.`,
          })
        } else {
          toast({
            title: 'Voice profile ready ✓',
            description: `Pitch-conformed match: “${data.profile.mappedVoice}” shifted ×${data.profile.pitchRatio?.toFixed(2) ?? '1.00'} toward your register (estimated, not a clone)`,
          })
        }
        return data.profile
      } catch (err) {
        toast({ title: 'Voice profile failed', description: err instanceof Error ? err.message : 'Network error', variant: 'destructive' })
        return null
      } finally {
        setProfileLoading(false)
      }
    },
    [toast]
  )

  /** Make another enrolled profile the active default (spec §5.2). */
  const selectProfile = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch('/api/voice-profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, isActive: true }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error ?? 'Request failed')
        const list: VoiceProfileData[] = Array.isArray(data?.profiles) ? data.profiles : []
        setProfiles(list)
        setProfile(list.find((p) => p.id === id) ?? null)
        return true
      } catch (err) {
        toast({ title: 'Could not switch voice profile', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  /** Rename an enrolled profile. */
  const renameProfile = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      const clean = name.trim().slice(0, 60)
      if (!clean) return false
      try {
        const res = await fetch('/api/voice-profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name: clean }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error ?? 'Request failed')
        const list: VoiceProfileData[] = Array.isArray(data?.profiles) ? data.profiles : []
        setProfiles(list)
        setProfile((prev) => (prev && prev.id === id ? { ...prev, name: clean } : prev))
        return true
      } catch {
        toast({ title: 'Could not rename profile', variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  /** Delete one profile (or ALL when no id is given). */
  const deleteProfile = useCallback(
    async (id?: string) => {
      try {
        const res = await fetch(`/api/voice-profile${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'DELETE' })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error ?? 'Request failed')
        const list: VoiceProfileData[] = Array.isArray(data?.profiles) ? data.profiles : []
        setProfiles(list)
        setProfile(list.find((p) => p.isActive) ?? null)
        toast({ title: id ? 'Voice profile deleted' : 'All voice profiles removed' })
      } catch {
        toast({ title: 'Could not remove profile', variant: 'destructive' })
      }
    },
    [toast]
  )

  // ── Socket lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getTranslatorSocket()

    const onConnect = () => setConnected(true)
    const onDisconnect = () => {
      setConnected(false)
      if (statusRef.current !== 'idle') setStatus('reconnecting')
    }
    const onConnectError = () => setConnected(false)

    const onStage = (event: StageEvent) => {
      if (event.status === 'start') {
        setActiveStage(event.stage)
      } else if (event.stage === 'tts') {
        setActiveStage(null)
      }
    }

    const onTranslation = (event: TranslationEvent) => {
      setPartial({
        utteranceId: event.utteranceId,
        source: event.sourceText,
        translated: event.translatedText,
        sourceLang: event.sourceLang,
        targetLang: event.targetLang,
        voice: event.voice,
        speakerRole: event.speakerRole,
      })
    }

    /** Partial-ASR reply → live caption (ignored when empty or stale). */
    const onAsrPartial = (res: { utteranceId: string; text: string; final: boolean }) => {
      partialBusyRef.current = false
      if (partialTimeoutRef.current !== null) {
        window.clearTimeout(partialTimeoutRef.current)
        partialTimeoutRef.current = null
      }
      if (!res.text || res.utteranceId !== captionIdRef.current) return
      setLiveCaption((cur) => ({ id: res.utteranceId, text: res.text, elapsedMs: cur?.elapsedMs ?? 0 }))
    }

    const onResult = (result: UtteranceResult) => {
      setActiveStage(null)
      setPartial(null) // full result (with audio) replaces the early text
      setLiveCaption(null)
      setLastError(null) // a successful result clears any previous failure
      setPendingCount((c) => Math.max(0, c - 1))
      if (!result.sourceText && !result.translatedText) return // silence/noise segment

      const entry: TranscriptEntry = {
        id: result.utteranceId,
        source: result.sourceText,
        translated: result.translatedText,
        timings: result.timings,
        voice: result.voice,
        voiceMode: result.voiceMode,
        sourceLang: result.sourceLang ?? langPairRef.current.sourceLang,
        targetLang: result.targetLang ?? langPairRef.current.targetLang,
        speakerRole: result.speakerRole ?? 'A',
        hasAudio: Boolean(result.audioBase64),
        createdAt: Date.now(),
      }
      setTranscript((prev) => [entry, ...prev].slice(0, 50))

      // Session recap: remember the language pair used (first time only)
      const pairKey = `${entry.sourceLang}→${entry.targetLang}`
      setSessionLangs((prev) => (prev.includes(pairKey) ? prev : [...prev, pairKey]))

      // Keep recent audio for replay from the transcript
      if (result.audioBase64) {
        const cache = audioCacheRef.current
        cache.set(result.utteranceId, result.audioBase64)
        if (cache.size > 12) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
      }

      // Latency stats (rolling)
      setStats((prev) => {
        const count = prev.count + 1
        const avg = (a: number, v: number) => Math.round((a * (count - 1) + v) / count)
        return {
          count,
          lastTotalMs: result.timings.totalMs,
          avgTotalMs: avg(prev.avgTotalMs, result.timings.totalMs),
          avgAsrMs: avg(prev.avgAsrMs, result.timings.asrMs),
          avgTranslateMs: avg(prev.avgTranslateMs, result.timings.translateMs),
          avgTtsMs: avg(prev.avgTtsMs, result.timings.ttsMs),
          minTotalMs: prev.count === 0 ? result.timings.totalMs : Math.min(prev.minTotalMs, result.timings.totalMs),
          maxTotalMs: prev.count === 0 ? result.timings.totalMs : Math.max(prev.maxTotalMs, result.timings.totalMs),
        }
      })

      if (result.audioBase64) {
        playerRef.current?.enqueue(result.audioBase64)
      }

      // Persistence (fire-and-forget; failure is silent — convenience layers).
      // Saved-history storage respects the auto-save setting (spec §6.1).
      // Thread messages ALWAYS append while a conversation is open (spec §8) —
      // with auto-save off they simply carry no audio link (honest: no replay).
      const histSessionId = ensureHistorySessionId()
      const threadIdAtResult = activeThreadIdRef.current
      const threadSessionAtResult = threadSessionRef.current

      /** Append the result to the open thread; `historyEntryId` links audio. */
      const saveThreadMessage = (historyEntryId: string | null) => {
        if (!threadIdAtResult) return
        void fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: threadIdAtResult,
            sessionId: threadSessionAtResult?.sessionId,
            speakerRole: entry.speakerRole === 'B' ? 'other' : 'user',
            source: entry.source,
            translated: entry.translated,
            sourceLang: entry.sourceLang,
            targetLang: entry.targetLang,
            style: styleRef.current,
            voice: entry.voiceMode === 'clone' ? 'your voice (clone)' : entry.voice,
            timings: entry.timings,
            historyEntryId,
          }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((msgData) => {
            if (!msgData?.message?.id) return
            const msg: ThreadMessageData = {
              id: msgData.message.id,
              sessionId: threadSessionAtResult?.sessionId ?? null,
              sequenceNo: msgData.message.sequenceNo,
              speakerRole: entry.speakerRole === 'B' ? 'other' : 'user',
              sourceLang: entry.sourceLang,
              targetLang: entry.targetLang,
              source: entry.source,
              translated: entry.translated,
              style: styleRef.current,
              voice: entry.voice,
              timings: entry.timings,
              historyEntryId,
              processingStatus: 'complete',
              createdAt: msgData.message.createdAt,
            }
            setActiveThread((prev) =>
              prev && prev.conversation.id === threadIdAtResult
                ? { ...prev, messages: [...prev.messages, msg] }
                : prev
            )
            setConversations((prev) =>
              prev
                ? prev.map((c) =>
                    c.id === threadIdAtResult
                      ? { ...c, messageCount: c.messageCount + 1, lastActivityAt: msgData.message.createdAt }
                      : c
                  )
                : prev
            )
          })
          .catch(() => {})
      }

      if (autoSaveRef.current) {
        void fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: entry.source,
            translated: entry.translated,
            sourceLang: entry.sourceLang,
            targetLang: entry.targetLang,
            style: styleRef.current,
            voice: entry.voiceMode === 'clone' ? 'your voice (clone)' : entry.voice,
            timings: entry.timings,
            hasAudio: entry.hasAudio,
            audioBase64: result.audioBase64 || undefined,
            sessionId: histSessionId,
          }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (!data?.id) return
            setHistory((prev) => {
              if (prev === null) return null // panel not opened yet — will fetch fresh later
              const saved: HistoryEntryData = {
                id: data.id,
                source: entry.source,
                translated: entry.translated,
                sourceLang: entry.sourceLang,
                targetLang: entry.targetLang,
                style: styleRef.current,
                voice: entry.voice,
                timings: entry.timings,
                hasAudio: entry.hasAudio,
                starred: false,
                sessionId: histSessionId,
                createdAt: new Date().toISOString(),
              }
              return [saved, ...prev].slice(0, 100)
            })
            // Thread persistence (spec §5.1): the message links to the
            // audio-bearing history row so replay works after reload.
            saveThreadMessage(data.id)
          })
          .catch(() => {})
      } else {
        saveThreadMessage(null)
      }
    }

    const onUtteranceError = (error: UtteranceError) => {
      setActiveStage(null)
      setPartial(null)
      setLiveCaption(null)
      setPendingCount((c) => Math.max(0, c - 1))
      // Preserve the exact payload so the user can retry THIS segment (spec §7).
      const payload = payloadCacheRef.current.get(error.utteranceId) ?? null
      setLastError(payload ? { utteranceId: error.utteranceId, stage: error.stage, message: error.message, payload } : null)
      const rateLimited = /429|rate|quota|too many/i.test(error.message)
      toast({
        title: rateLimited ? 'Provider rate limit' : 'Pipeline error',
        description: rateLimited
          ? 'The provider is limiting requests right now. Completed phrases are safe — retry this segment in a moment.'
          : error.message,
        variant: 'destructive',
      })
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on('stage', onStage)
    socket.on('translation', onTranslation)
    socket.on('asr:partial:result', onAsrPartial)
    socket.on('result', onResult)
    socket.on('utterance:error', onUtteranceError)

    if (socket.connected) setConnected(true)

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off('stage', onStage)
      socket.off('translation', onTranslation)
      socket.off('asr:partial:result', onAsrPartial)
      socket.off('result', onResult)
      socket.off('utterance:error', onUtteranceError)
    }
  }, [toast, ensureHistorySessionId])

  // ── Playback state → status ─────────────────────────────────────────────
  const handlePlaybackStart = useCallback(() => {
    if (statusRef.current !== 'idle') setStatus('speaking')
  }, [])

  const handlePlaybackEnd = useCallback(() => {
    if (statusRef.current === 'speaking') setStatus('listening')
  }, [])

  /**
   * Playback UI state — independent of the session status so typed phrases
   * (no live session → status stays 'idle') still light up the playing
   * indicators in the LivePanel.
   */
  const [playbackActive, setPlaybackActive] = useState(false)

  /** Shared player factory — identical wiring for live sessions and typed phrases.
   *  Also drives the playback echo-guard (spec §9): while synthesized audio is
   *  playing, the mic's VAD is frozen so the output is never re-recognized as
   *  user speech; on end, a short tail window avoids catching the decay. */
  const createPlayer = useCallback(async () => {
    const player = new TranslationAudioPlayer({
      onPlaybackStart: () => {
        handlePlaybackStart()
        setPlaybackActive(true)
        if (echoTailRef.current !== null) {
          window.clearTimeout(echoTailRef.current)
          echoTailRef.current = null
        }
        recorderRef.current?.setPlaybackDucked(true)
      },
      onPlaybackEnd: () => {
        handlePlaybackEnd()
        setPlaybackActive(false)
        if (echoTailRef.current !== null) window.clearTimeout(echoTailRef.current)
        echoTailRef.current = window.setTimeout(() => {
          echoTailRef.current = null
          recorderRef.current?.setPlaybackDucked(false)
        }, 350)
      },
    })
    await player.init()
    player.setRate(playbackRateRef.current)
    return player
  }, [handlePlaybackStart, handlePlaybackEnd])

  // ── Thread session lifecycle (declared before session controls) ─────────

  /** Open (or reuse) a live session record for the open thread. */
  const beginThreadSession = useCallback(async (conversationId: string) => {
    const existing = threadSessionRef.current
    if (existing && existing.conversationId === conversationId && existing.status === 'live') return existing
    try {
      const res = await fetch(`/api/conversations/${conversationId}/sessions`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.session) return null
      const ref: ThreadSessionRef = { conversationId, sessionId: data.session.id, status: 'live' }
      threadSessionRef.current = ref
      setThreadSession(ref)
      return ref
    } catch {
      return null // thread session is a persistence nicety — never block the mic
    }
  }, [])

  const endThreadSession = useCallback(() => {
    const sess = threadSessionRef.current
    if (!sess) return
    void fetch(`/api/conversations/${sess.conversationId}/sessions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sess.sessionId, status: 'ended' }),
    }).catch(() => {})
    threadSessionRef.current = null
    setThreadSession((prev) => (prev ? { ...prev, status: 'ended' } : null))
  }, [])

  // ── Session controls ────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    playerRef.current?.clear()
    const socket = getTranslatorSocket()
    if (socket.connected) socket.emit('session:reset')
    if (recorder) await recorder.stop()
    setActiveStage(null)
    setPartial(null)
    resetCaptionState()
    setPendingCount(0)
    setLevel(0)
    setStatus('idle')
    // Ending the live session closes its history group — the next session (or
    // typed-phrase streak) starts a fresh one. A thread session ends with it.
    historySessionIdRef.current = null
    endThreadSession()
  }, [endThreadSession, resetCaptionState])

  const start = useCallback(async () => {
    if (recorderRef.current) return
    setStatus('starting')
    try {
      const player = await createPlayer()
      playerRef.current = player

      const socket = getTranslatorSocket()
      if (!socket.connected) {
        // Wait briefly for the connection before opening the mic
        await new Promise<void>((resolve) => {
          if (socket.connected) return resolve()
          const timer = setTimeout(() => resolve(), 4000)
          socket.once('connect', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }

      const recorder = new MicRecorder({
        onUtterance: (audioBase64, durationSec) => {
          const prof = effectiveProfile()
          // Speaker B (second person in a two-way conversation) speaks the
          // opposite language and audibly DIFFERENT: pipeline default voice,
          // no profile — so the two sides of the dialogue are distinguishable.
          const isB = speakerRef.current === 'B'
          const bProf = isB ? null : prof
          const useProfile = Boolean(bProf)
          const pair = langPairRef.current
          setSessionSpeechMs((v) => v + durationSec * 1000)
          setPendingCount((c) => c + 1)
          const utteranceId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const payload = {
            utteranceId,
            audioBase64,
            sampleRate: 16000,
            sourceLang: pair.sourceLang,
            targetLang: pair.targetLang,
            autoPair: autoDetectRef.current ? autoPairRef.current : undefined,
            style: styleRef.current,
            voice: useProfile ? bProf!.mappedVoice : isB ? 'jam' : DEFAULT_VOICE,
            speed: useProfile ? bProf!.speedAdjust : 1.0,
            pitchRatio: useProfile ? bProf!.pitchRatio : 1.0,
            profileMode: useProfile ? bProf!.mode : undefined,
            providerProfileId: useProfile ? bProf!.providerProfileId ?? undefined : undefined,
            providerModel: useProfile ? bProf!.providerModel ?? undefined : undefined,
            stability: useProfile ? bProf!.stability : undefined,
            providerSimilarity: useProfile ? bProf!.providerSimilarity ?? undefined : undefined,
            providerStyle: useProfile ? bProf!.providerStyle ?? undefined : undefined,
            speakerRole: speakerRef.current,
          }
          // Context off (settings): each phrase translates standalone — clear the
          // pipeline's rolling conversation history before this utterance runs.
          if (!useContextRef.current) {
            const s = getTranslatorSocket()
            if (s.connected) s.emit('session:reset')
          }
          // Keep the exact payload for failed-segment retry (spec §7).
          const payloads = payloadCacheRef.current
          payloads.set(utteranceId, { kind: 'audio', data: payload })
          if (payloads.size > 3) {
            const oldest = payloads.keys().next().value
            if (oldest !== undefined) payloads.delete(oldest)
          }
          getTranslatorSocket().emit('utterance', payload)
        },
        onLevel: setLevel,
        onSpeakingChange: (speaking) => {
          if (!speaking) return
          // New speech segment → new caption id (partials attach to it).
          captionIdRef.current = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          if (statusRef.current !== 'idle') setStatus('user-speaking')
        },
        // Live captions: mid-speech ASR snapshots (one in flight at a time).
        onPartial: (pcmBase64) => {
          if (!showCaptionsRef.current) return // captions off (settings)
          if (partialBusyRef.current) return
          const id = captionIdRef.current
          if (!id) return
          partialBusyRef.current = true
          const pair = langPairRef.current
          getTranslatorSocket().emit('asr:partial', {
            utteranceId: id,
            audioBase64: pcmBase64,
            sampleRate: 16000,
            sourceLang: pair.sourceLang,
          })
          // Safety valve: unblock if no reply arrives (disconnect, drop…).
          partialTimeoutRef.current = window.setTimeout(() => {
            partialBusyRef.current = false
            partialTimeoutRef.current = null
          }, 3000)
        },
        onSpeechTick: (elapsedMs) => {
          setLiveCaption((cur) => (cur ? { ...cur, elapsedMs } : null))
        },
        onError: (err) => {
          toast({ title: 'Microphone error', description: err.message, variant: 'destructive' })
          void stop()
        },
      })

      await recorder.start()
      recorderRef.current = recorder
      // Live speech starts a new history session group (typed phrases before
      // this belonged to their own streak).
      historySessionIdRef.current = null
      ensureHistorySessionId()
      // While a thread is open, recording runs inside a persisted thread
      // session (spec §5.5) — new messages append to the same conversation.
      const tid = activeThreadIdRef.current
      if (tid) void beginThreadSession(tid)
      setStatus('listening')
    } catch (err) {
      console.error('[use-translator] start failed:', err)
      setStatus('idle')
      const message =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow mic access and try again.'
          : err instanceof Error
            ? err.message
            : 'Failed to start the session'
      toast({ title: 'Cannot start', description: message, variant: 'destructive' })
    }
  }, [beginThreadSession, createPlayer, effectiveProfile, handlePlaybackEnd, handlePlaybackStart, stop, toast])

  const clearTranscript = useCallback(() => {
    setTranscript([])
    audioCacheRef.current.clear()
    setPartial(null)
    resetCaptionState()
    setPendingCount(0)
    setSessionSpeechMs(0)
    setSessionLangs([])
    setStats({ count: 0, lastTotalMs: 0, avgTotalMs: 0, avgAsrMs: 0, avgTranslateMs: 0, avgTtsMs: 0, minTotalMs: 0, maxTotalMs: 0 })
  }, [resetCaptionState])

  modeRef.current = mode
  otherLangRef.current = otherLang

  /** Reset pipeline context — it is language-pair specific. */
  const resetServerContext = useCallback(() => {
    const socket = getTranslatorSocket()
    if (socket.connected) socket.emit('session:reset')
  }, [])

  /** Switch Dub/Interpreter; resets pipeline context (it is language-specific). */
  const setMode = useCallback(
    (next: Mode) => {
      if (next === modeRef.current) return
      modeRef.current = next
      setModeState(next)
      resetServerContext()
    },
    [resetServerContext]
  )

  /** Change the non-Persian side language; resets pipeline context. */
  const setOtherLang = useCallback(
    (next: OtherLang) => {
      if (next === otherLangRef.current) return
      otherLangRef.current = next
      setOtherLangState(next)
      resetServerContext()
    },
    [resetServerContext]
  )

  /**
   * Type-to-translate: send a typed phrase through the same pipeline (no ASR).
   * Lazily initializes the audio player so playback works even when the mic
   * session is not running (Send click counts as a user gesture).
   */
  const translateText = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 1000) return false
    if (!playerRef.current) {
      try {
        playerRef.current = await createPlayer()
      } catch {
        // No audio output available — text result still arrives.
      }
    }
    const pair = langPairRef.current
    const prof = effectiveProfile()
    const useProfile = Boolean(prof)
    // Typed phrases group into a session streak (new group after a live session ends).
    ensureHistorySessionId()
    const utteranceId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const payload = {
      utteranceId,
      text: trimmed,
      sourceLang: pair.sourceLang,
      targetLang: pair.targetLang,
      autoPair: autoDetectRef.current ? autoPairRef.current : undefined,
      style: styleRef.current,
      voice: useProfile ? prof!.mappedVoice : DEFAULT_VOICE,
      speed: useProfile ? prof!.speedAdjust : 1.0,
      pitchRatio: useProfile ? prof!.pitchRatio : 1.0,
      profileMode: useProfile ? prof!.mode : undefined,
      providerProfileId: useProfile ? prof!.providerProfileId ?? undefined : undefined,
      providerModel: useProfile ? prof!.providerModel ?? undefined : undefined,
      stability: useProfile ? prof!.stability : undefined,
      providerSimilarity: useProfile ? prof!.providerSimilarity ?? undefined : undefined,
      providerStyle: useProfile ? prof!.providerStyle ?? undefined : undefined,
      speakerRole: speakerRef.current,
    }
    // Context off (settings): typed phrases translate standalone too.
    if (!useContextRef.current) {
      const s = getTranslatorSocket()
      if (s.connected) s.emit('session:reset')
    }
    // Keep the exact payload for failed-segment retry (spec §7).
    const payloads = payloadCacheRef.current
    payloads.set(utteranceId, { kind: 'text', data: payload })
    if (payloads.size > 3) {
      const oldest = payloads.keys().next().value
      if (oldest !== undefined) payloads.delete(oldest)
    }
    getTranslatorSocket().emit('translate:text', payload)
    return true
  }, [createPlayer, effectiveProfile, ensureHistorySessionId])

  /**
   * Push-to-talk: hold-to-capture control over the live recorder's VAD.
   * `true` opens an utterance immediately (bypassing silence detection);
   * `false` flushes whatever was captured, even mid-speech.
   */
  const pushToTalk = useCallback((active: boolean) => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (active) recorder.startPushToTalk()
    else recorder.stopPushToTalk()
  }, [])

  /**
   * Download a previously spoken utterance as a .wav file (from the rolling
   * 12-utterance client cache). Older phrases can be downloaded from Saved
   * History instead — the toast says so.
   */
  const downloadAudio = useCallback(
    (utteranceId: string, label?: string) => {
      const audio = audioCacheRef.current.get(utteranceId)
      if (!audio) {
        toast({
          title: 'Audio not available',
          description: 'Only the last 12 spoken phrases download here — older ones live in Saved History.',
        })
        return false
      }
      try {
        const bin = atob(audio)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${slugify(label) || 'translation'}-${utteranceId}.wav`
        a.click()
        URL.revokeObjectURL(url)
        return true
      } catch {
        toast({ title: 'Download failed', variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  /** Replay a previously spoken utterance from the transcript (if still cached). */
  const replay = useCallback(
    (utteranceId: string) => {
      const audio = audioCacheRef.current.get(utteranceId)
      if (audio && playerRef.current) {
        playerRef.current.enqueue(audio)
        return true
      }
      toast({
        title: 'Audio not available',
        description: 'Only the last 12 spoken phrases replay here — older ones live in Saved History.',
      })
      return false
    },
    [toast]
  )

  // ── Persisted history (REST) ──────────────────────────────────────────
  /** ISO cursor of the oldest loaded entry — null when everything is loaded. */
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/history?limit=60', { cache: 'no-store' })
      const data = await res.json()
      setHistory(Array.isArray(data.entries) ? data.entries : [])
      setHistoryCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null)
    } catch {
      setHistory([])
      setHistoryCursor(null)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  /** Delete ONE saved history entry (text + cached audio; thread messages
   *  stay but lose their audio link — disclosed behavior). */
  const deleteHistoryEntry = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Request failed')
        setHistory((prev) => (prev ? prev.filter((e) => e.id !== id) : prev))
        return true
      } catch {
        toast({ title: 'Could not delete the entry', variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  /**
   * Load the next page of history using the server cursor and append it.
   * No-op while a load is already running or the end was reached.
   */
  const loadMoreHistory = useCallback(async () => {
    if (!historyCursor || historyLoading) return
    setHistoryLoading(true)
    try {
      const res = await fetch(`/api/history?limit=60&before=${encodeURIComponent(historyCursor)}`, {
        cache: 'no-store',
      })
      const data = await res.json()
      const older: HistoryEntryData[] = Array.isArray(data.entries) ? data.entries : []
      if (older.length > 0) {
        setHistory((prev) => {
          if (prev === null) return older
          const seen = new Set(prev.map((e) => e.id))
          return [...prev, ...older.filter((e) => !seen.has(e.id))]
        })
      }
      setHistoryCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null)
    } catch {
      // Keep current list + cursor — user can retry.
    } finally {
      setHistoryLoading(false)
    }
  }, [historyCursor, historyLoading])

  const clearHistory = useCallback(async () => {
    try {
      await fetch('/api/history', { method: 'DELETE' })
      setHistory([])
      toast({ title: 'History cleared' })
    } catch {
      toast({ title: 'Could not clear history', variant: 'destructive' })
    }
  }, [toast])

  /**
   * Star / unstar a saved phrase (phrasebook). Optimistic flip with server
   * reconciliation — on failure the previous value is restored.
   */
  const toggleStar = useCallback(
    async (entryId: string) => {
      const current = history?.find((e) => e.id === entryId)
      const next = !(current?.starred ?? false)
      // Optimistic update
      setHistory((prev) =>
        prev?.map((e) => (e.id === entryId ? { ...e, starred: next } : e)) ?? prev
      )
      try {
        const res = await fetch(`/api/history/${entryId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: next }),
        })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json().catch(() => null)
        // Reconcile with the server value
        if (data && typeof data.starred === 'boolean') {
          setHistory((prev) =>
            prev?.map((e) => (e.id === entryId ? { ...e, starred: data.starred } : e)) ?? prev
          )
        }
      } catch {
        setHistory((prev) =>
          prev?.map((e) => (e.id === entryId ? { ...e, starred: !next } : e)) ?? prev
        )
        toast({ title: 'Could not update star', variant: 'destructive' })
      }
    },
    [history, toast]
  )

  // ── Threads (persistent conversations, spec §5) ─────────────────────────

  const loadConversations = useCallback(async (q?: string) => {
    setConversationsLoading(true)
    try {
      const url = `/api/conversations?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`
      const res = await fetch(url, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      setConversations(Array.isArray(data?.conversations) ? data.conversations : [])
    } catch {
      setConversations([])
    } finally {
      setConversationsLoading(false)
    }
  }, [])

  /**
   * Open a thread: load its messages + sessions and apply its settings
   * overrides on top of the current globals (snapshot for restore on close —
   * a thread must never permanently mutate global defaults, spec §4.2).
   */
  const openThread = useCallback(
    async (id: string) => {
      setThreadLoading(true)
      try {
        const res = await fetch(`/api/conversations/${id}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Thread not found')
        const data = (await res.json()) as ThreadDetailData
        // Snapshot current settings once per open (not per refresh).
        if (activeThreadIdRef.current !== id) {
          settingsSnapshotRef.current = {
            mode: modeRef.current,
            otherLang: otherLangRef.current,
            style: styleRef.current,
            voiceMode: voiceModeRef.current,
            playbackRate: playbackRateRef.current,
            bigButton: bigButtonRef.current,
          }
        }
        activeThreadIdRef.current = id
        setActiveThread(data)
        const o = data.conversation.overrides
        if (o) {
          if (o.mode) setMode(o.mode)
          if (o.otherLang) setOtherLang(o.otherLang)
          if (o.style) setStyle(o.style)
          if (o.voiceMode) setVoiceMode(o.voiceMode)
          if (typeof o.playbackRate === 'number') setPlaybackRate(o.playbackRate)
          if (typeof o.bigButton === 'boolean') setBigButton(o.bigButton)
          // Per-thread voice profile: an unknown/stale id falls back to the
          // global active profile (never blocks translation).
          threadProfileIdRef.current = typeof o.profileId === 'string' ? o.profileId : null
          setThreadProfileId(threadProfileIdRef.current)
        } else {
          threadProfileIdRef.current = null
          setThreadProfileId(null)
        }
        return true
      } catch (err) {
        toast({ title: 'Could not open conversation', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
        return false
      } finally {
        setThreadLoading(false)
      }
    },
    [setBigButton, setMode, setOtherLang, setPlaybackRate, setStyle, setVoiceMode, toast]
  )

  /** Close the thread, end any live session in it, restore global settings. */
  const closeThread = useCallback(() => {
    const sess = threadSessionRef.current
    if (sess) {
      void fetch(`/api/conversations/${sess.conversationId}/sessions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sess.sessionId, status: 'ended' }),
      }).catch(() => {})
      threadSessionRef.current = null
      setThreadSession(null)
    }
    const snap = settingsSnapshotRef.current
    if (snap) {
      setMode(snap.mode)
      setOtherLang(snap.otherLang)
      setStyle(snap.style)
      setVoiceMode(snap.voiceMode)
      setPlaybackRate(snap.playbackRate)
      setBigButton(snap.bigButton)
      settingsSnapshotRef.current = null
    }
    threadProfileIdRef.current = null
    setThreadProfileId(null)
    activeThreadIdRef.current = null
    setActiveThread(null)
    void loadConversations()
  }, [loadConversations, setBigButton, setMode, setOtherLang, setPlaybackRate, setStyle, setVoiceMode])

  const createConversation = useCallback(
    async (title?: string) => {
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title?.trim() || undefined }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data?.conversation) throw new Error(data?.error ?? 'Request failed')
        const conv = data.conversation as ConversationData
        setConversations((prev) => (prev ? [conv, ...prev] : prev))
        await openThread(conv.id)
        return conv.id
      } catch (err) {
        toast({ title: 'Could not create conversation', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
        return null
      }
    },
    [openThread, toast]
  )

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim().slice(0, 120)
      if (!clean) return false
      // Optimistic rename
      setActiveThread((prev) => (prev && prev.conversation.id === id ? { ...prev, conversation: { ...prev.conversation, title: clean } } : prev))
      setConversations((prev) => prev?.map((c) => (c.id === id ? { ...c, title: clean } : c)) ?? prev)
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: clean }),
        })
        if (!res.ok) throw new Error(String(res.status))
        return true
      } catch {
        toast({ title: 'Could not rename conversation', variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(String(res.status))
        setConversations((prev) => (prev ? prev.filter((c) => c.id !== id) : prev))
        if (activeThreadIdRef.current === id) {
          // Reuse closeThread's session teardown but keep the restored settings.
          const sess = threadSessionRef.current
          if (sess && sess.conversationId === id) {
            threadSessionRef.current = null
            setThreadSession(null)
          }
          activeThreadIdRef.current = null
          setActiveThread(null)
          settingsSnapshotRef.current = null
        }
        toast({ title: 'Conversation deleted' })
        return true
      } catch {
        toast({ title: 'Could not delete conversation', variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  /**
   * Persist thread settings overrides. Keys absent from `overrides` are
   * removed (undefined) or reset wholesale with `null` (inherit global).
   */
  const saveThreadOverrides = useCallback(
    async (overrides: ThreadOverrides | null) => {
      const id = activeThreadIdRef.current
      if (!id) return false
      setActiveThread((prev) =>
        prev && prev.conversation.id === id ? { ...prev, conversation: { ...prev.conversation, overrides } } : prev
      )
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overrides }),
        })
        if (!res.ok) throw new Error(String(res.status))
        return true
      } catch {
        toast({ title: 'Could not save thread settings', variant: 'destructive' })
        return false
      }
    },
    [toast]
  )

  /**
   * Retry the last failed segment with the exact same payload (spec §7:
   * "Allow the user to retry the failed segment"). Completed phrases are
   * untouched — only the failed one is re-sent.
   */
  const retryFailed = useCallback(() => {
    const err = lastError
    if (!err?.payload) return false
    const socket = getTranslatorSocket()
    socket.emit(err.payload.kind === 'text' ? 'translate:text' : 'utterance', err.payload.data)
    if (err.payload.kind === 'audio') setPendingCount((c) => c + 1)
    setLastError(null)
    return true
  }, [lastError])

  const clearError = useCallback(() => setLastError(null), [])

  // ── Sharing (Web Share API with clipboard fallback) ───────────────────

  /**
   * Share the latest translation — prefers native share with the WAV file,
   * falls back to text-only share, then to clipboard copy on desktop browsers
   * without the Web Share API.
   */
  const shareTranslation = useCallback(
    async (utteranceId: string, label: string | undefined, text: string) => {
      if (!text) return false
      const file = wavFileFromBase64(audioCacheRef.current.get(utteranceId), `${slugify(label) || 'translation'}.wav`)
      return shareOrCopy(text, file, toast)
    },
    [toast]
  )

  /** Share a saved-history phrase (audio fetched from the server cache). */
  const shareSaved = useCallback(
    async (entryId: string, label: string | undefined, text: string, hasAudio: boolean) => {
      if (!text) return false
      let file: File | null = null
      if (hasAudio) {
        try {
          const res = await fetch(`/api/history/${entryId}/audio`)
          if (res.ok) {
            const blob = await res.blob()
            file = new File([blob], `${slugify(label) || 'translation'}.wav`, { type: 'audio/wav' })
          }
        } catch {
          file = null // audio is optional — share text only
        }
      }
      return shareOrCopy(text, file, toast)
    },
    [toast]
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current
      if (recorder) void recorder.stop()
      recorderRef.current = null
      if (partialTimeoutRef.current !== null) window.clearTimeout(partialTimeoutRef.current)
      if (echoTailRef.current !== null) window.clearTimeout(echoTailRef.current)
    }
  }, [])

  return {
    // state
    status,
    connected,
    activeStage,
    level,
    transcript,
    profile,
    profiles,
    profileLoading,
    // voice identity capabilities (honest clone availability + setup steps)
    capabilities,
    threadProfileId,
    effectiveVoiceProfile,
    style,
    voiceMode,
    mode,
    otherLang,
    playbackRate,
    playbackActive,
    bigButton,
    langPair,
    partial,
    liveCaption,
    pendingCount,
    sessionSpeechMs,
    sessionLangs,
    stats,
    lastError,
    autoSaveHistory,
    useContext,
    showCaptions,
    // UI customization prefs (spec §4.4)
    uiPrefs,
    // actions
    start,
    stop,
    setStyle,
    setVoiceMode,
    setMode,
    setOtherLang,
    setPlaybackRate,
    setBigButton,
    setTextSize,
    setCompact,
    setShowTranscript,
    setAutoSaveHistory,
    setUseContext,
    setShowCaptions,
    translateText,
    pushToTalk,
    replay,
    downloadAudio,
    shareTranslation,
    shareSaved,
    createProfile,
    selectProfile,
    renameProfile,
    deleteProfile,
    updateCloneSettings,
    clearTranscript,
    retryFailed,
    clearError,
    // history
    history,
    historyLoading,
    historyCursor,
    loadHistory,
    loadMoreHistory,
    clearHistory,
    toggleStar,
    deleteHistoryEntry,
    // interpreter / auto direction (real bidirectional + manual speaker turns)
    autoDetect,
    setAutoDetect,
    speaker,
    setSpeaker,
    availableOtherLangs,
    betaLangs,
    setBetaLangs,
    historyRetentionDays,
    setHistoryRetentionDays,
    // threads (persistent conversations, spec §5)
    conversations,
    conversationsLoading,
    activeThread,
    threadLoading,
    threadSession,
    loadConversations,
    openThread,
    closeThread,
    createConversation,
    renameConversation,
    deleteConversation,
    saveThreadOverrides,
  }
}

/** Filename-safe slug from arbitrary text (translation label), max 40 chars. */
function slugify(text: string | undefined): string {
  if (!text) return ''
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '')
  )
}

/** WAV File from base64 (null when audio is missing/undecodable). */
function wavFileFromBase64(base64: string | undefined, filename: string): File | null {
  if (!base64) return null
  try {
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new File([bytes], filename, { type: 'audio/wav' })
  } catch {
    return null
  }
}

type ToastFn = ReturnType<typeof useToast>['toast']

/** Native share (files → text) with clipboard fallback. Returns the outcome. */
async function shareOrCopy(text: string, file: File | null, toast: ToastFn): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
    if (file && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], text, title: 'Live Voice Translator' })
      return true
    }
    if (typeof nav.share === 'function') {
      await nav.share({ title: 'Live Voice Translator', text })
      return true
    }
    await navigator.clipboard.writeText(text)
    toast({
      title: 'Copied to clipboard',
      description: 'Native sharing is not available in this browser — the translation was copied instead.',
    })
    return true
  } catch (err) {
    // User dismissed the share sheet — not an error.
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return false
    toast({ title: 'Share failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    return false
  }
}
