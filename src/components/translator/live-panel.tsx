'use client'

import { motion } from 'framer-motion'
import { useState, useCallback, useEffect, useRef } from 'react'
import { ArrowLeftRight, AudioLines, Check, CircleAlert, Clock, Copy, Download, Keyboard, Loader2, Maximize2, Mic2, Minimize2, RotateCcw, SendHorizonal, Share2, Square, WandSparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LiveCaption, TranscriptEntry, TranslationPartial, TranslatorStatus } from '@/hooks/use-translator'
import type { LangPair, PipelineStage } from '@/types/translator'
import { LANG_META } from '@/types/translator'

/** The engine voice + speed the pipeline uses when no profile is active. */
const DEFAULT_ENGINE_VOICE = 'kazi'

interface LivePanelProps {
  latest: TranscriptEntry | null
  status: TranslatorStatus
  activeStage: PipelineStage | null
  langPair: LangPair
  /** Early-delivered translation shown while audio is still synthesizing. */
  partial: TranslationPartial | null
  /** Live caption — partial ASR text while the user is still speaking. */
  liveCaption: LiveCaption | null
  /** Utterances sent but not yet completed (1 = none queued, just processing). */
  pendingCount?: number
  canReplay: boolean
  onReplay: () => void
  /** Download the latest phrase's audio as .wav (undefined = unavailable). */
  onDownload?: () => void
  /** Share the latest translation (Web Share API, clipboard fallback). */
  onShare?: () => void
  onTranslateText: (text: string) => Promise<boolean>
  /** Hold-to-talk (push-to-talk); undefined when no live session. */
  onPushToTalk?: (active: boolean) => void
  /** Oversized hold-to-talk button (mobile interpreter mode). */
  bigButton?: boolean
  /** Presentation mode — jumbo text for showing the other person the screen. */
  present: boolean
  onTogglePresent: () => void
  /** When set, enables Voice A/B on the real translation (mapped voice vs default). */
  abProfile?: { mappedVoice: string; speedAdjust: number; pitchRatio?: number } | null
  /** When set, A/B leg A plays the REAL enrolled profile (clone or voice-match)
   *  via its profileId — the honest way to audition cloned voices. */
  abProfileId?: string | null
  /** True while result audio is actually playing (works for typed phrases too). */
  playbackActive?: boolean
  /** Last failed segment (spec §7) — shows a retry affordance. */
  lastError?: { stage: string; message: string } | null
  onRetryFailed?: () => void
  onDismissError?: () => void
  /** UI text-size preference (spec §4.4) — scales the hero text. */
  textScale?: 'sm' | 'md' | 'lg'
  /** Manual speaker turn for two-person conversations (NO engine diarization —
   *  the UI labels each turn and the honest hint explains the limitation). */
  speaker?: 'A' | 'B'
  onSpeakerChange?: (role: 'A' | 'B') => void
  /** Honest note shown under the speaker control (diarization limitation). */
  speakerNote?: string
}

const STAGE_LABEL: Record<PipelineStage, string> = {
  asr: 'Recognizing speech…',
  translate: 'Translating…',
  tts: 'Synthesizing your voice…',
}

/** Deterministic pseudo-waveform bar heights (avoid hydration randomness). */
const WAVE_BARS = [38, 62, 84, 55, 92, 70, 45, 78, 100, 64, 40, 88, 58, 96, 52, 74, 42, 82, 66, 48, 90, 60, 36, 76]

/** Hero text sizes by UI text-size preference (spec §4.4). */
const HERO_SRC: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-base sm:text-lg',
  md: 'text-lg sm:text-xl',
  lg: 'text-xl sm:text-2xl',
}
const HERO_TGT: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-lg sm:text-xl',
  md: 'text-xl sm:text-2xl',
  lg: 'text-2xl sm:text-3xl',
}

export function LivePanel({ latest, status, activeStage, langPair, partial, liveCaption, pendingCount = 1, canReplay, onReplay, onDownload, onShare, onTranslateText, onPushToTalk, bigButton, present, onTogglePresent, abProfile = null, abProfileId = null, playbackActive = false, lastError = null, onRetryFailed, onDismissError, textScale = 'md', speaker, onSpeakerChange, speakerNote }: LivePanelProps) {
  const processing = activeStage !== null
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pttHeld, setPttHeld] = useState(false)
  // ── Voice A/B on the real translation: leg A = mapped profile voice,
  // leg B = the default pipeline voice. Same sentence, back to back.
  const [ab, setAb] = useState<'idle' | 'loading' | 'a' | 'b'>('idle')
  const abAudioRef = useRef<HTMLAudioElement | null>(null)
  /** Set when the listener stops a compare run — prevents auto-advancing to B. */
  const abStopRef = useRef(false)
  // A partial is visible when it is newer than the completed `latest` entry
  // (older partials whose result already arrived are stale and hidden).
  const partialVisible = partial !== null && (latest === null || partial.utteranceId !== latest.id)
  // Live caption shows while the user speaks and while the pipeline works —
  // it hands over to the early translation as soon as that arrives.
  const captionVisible = Boolean(liveCaption?.text) && (status === 'user-speaking' || (processing && !partialVisible))
  // Displayed entry carries its own language pair (it may predate a switch).
  const pair: LangPair = partialVisible
    ? { sourceLang: partial.sourceLang, targetLang: partial.targetLang }
    : latest
      ? { sourceLang: latest.sourceLang, targetLang: latest.targetLang }
      : langPair
  const src = LANG_META[pair.sourceLang] ?? LANG_META.en
  const tgt = LANG_META[pair.targetLang] ?? LANG_META.fa
  // Playing indicators key off real audio playback (playbackActive) rather
  // than session status — typed phrases play without a live session too.
  const playing = playbackActive && !processing

  const copyTranslation = async () => {
    if (!latest?.translated) return
    try {
      await navigator.clipboard.writeText(latest.translated)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard unavailable — ignore
    }
  }

  const submitDraft = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const ok = await onTranslateText(text)
      if (ok) setDraft('')
    } finally {
      setSending(false)
    }
  }

  // Stop A/B playback when the panel unmounts
  useEffect(() => {
    return () => {
      abAudioRef.current?.pause()
      abAudioRef.current = null
    }
  }, [])

  const fetchAbUrl = useCallback(
    async (voice: string, speed: number, text: string, lang: string, pitchRatio = 1): Promise<string> => {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice, speed, lang, text, pitchRatio }),
      })
      const data = await res.json()
      if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
      return `data:audio/wav;base64,${data.audioBase64}`
    },
    []
  )

  /** Leg A of the A/B when a real profile is enrolled — plays the profile's
   *  actual voice (clone → provider voice, voice-match → conformed preset). */
  const fetchAbProfileUrl = useCallback(
    async (profileId: string, text: string, lang: string): Promise<string> => {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, lang, text }),
      })
      const data = await res.json()
      if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
      return `data:audio/wav;base64,${data.audioBase64}`
    },
    []
  )

  /** Play one A/B leg; resolves when it ends or the listener stops it. */
  const playAbLeg = useCallback(
    (url: string, phase: 'a' | 'b') =>
      new Promise<void>((resolve, reject) => {
        const audio = new Audio(url)
        abAudioRef.current = audio
        audio.onended = () => resolve()
        audio.onpause = () => {
          if (abStopRef.current) resolve()
        }
        audio.onerror = () => reject(new Error('playback failed'))
        setAb(phase)
        void audio.play().catch(reject)
      }),
    []
  )

  const startAb = useCallback(async () => {
    if ((!abProfileId || !latest?.translated) && (!abProfile || !latest?.translated)) return
    if (ab !== 'idle') return
    abStopRef.current = false
    setAb('loading')
    try {
      const text = latest!.translated
      const lang = pair.targetLang
      const urlA = abProfileId
        ? await fetchAbProfileUrl(abProfileId, text, lang)
        : await fetchAbUrl(abProfile!.mappedVoice, abProfile!.speedAdjust, text, lang, abProfile!.pitchRatio ?? 1)
      if (abStopRef.current) return
      // Prefetch leg B while leg A plays — halves the gap between them.
      const urlBPromise = fetchAbUrl(DEFAULT_ENGINE_VOICE, 1, text, lang).catch(() => null)
      await playAbLeg(urlA, 'a')
      if (abStopRef.current) return
      const urlB = await urlBPromise
      if (!urlB || abStopRef.current) return
      await playAbLeg(urlB, 'b')
    } catch {
      // Network/playback failure — reset quietly; chips stay informative.
    } finally {
      abStopRef.current = false
      setAb('idle')
    }
  }, [abProfile, abProfileId, latest, ab, pair.targetLang, fetchAbUrl, fetchAbProfileUrl, playAbLeg])

  const stopAb = useCallback(() => {
    abStopRef.current = true
    abAudioRef.current?.pause()
    setAb('idle')
  }, [])

  return (
    <section
      aria-live="polite"
      aria-label="Live translation"
      className={cn(
        'lt-card relative flex min-h-[220px] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 transition-all duration-500 sm:min-h-[240px] sm:p-6',
        present &&
          'min-h-[46vh] border-emerald-800/60 ring-1 ring-emerald-500/30 shadow-[0_0_90px_-24px_rgba(16,185,129,0.55)]'
      )}
    >
      {/* Corner accent */}
      <div className="pointer-events-none absolute right-0 top-0 h-16 w-16 rounded-bl-[2.5rem] bg-emerald-500/5" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">
          <span aria-hidden className="h-1 w-1 rounded-full bg-emerald-500/70" />
          Live Translation
        </span>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Present mode — jumbo text for face-to-face interpreting */}
          <button
            type="button"
            onClick={onTogglePresent}
            aria-pressed={present}
            aria-label={present ? 'Exit presentation mode' : 'Presentation mode — enlarge the translation'}
            title={present ? 'Exit presentation mode (Esc)' : 'Presentation mode — jumbo text (for showing the other person)'}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
              present
                ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-700/60 hover:text-emerald-300'
            )}
          >
            {present ? <Minimize2 className="h-3 w-3" aria-hidden /> : <Maximize2 className="h-3 w-3" aria-hidden />}
            <span className="hidden sm:inline">{present ? 'Exit' : 'Present'}</span>
          </button>
          {processing && (
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <span className="flex h-4 items-end gap-0.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="lt-eq-bar h-full w-1 rounded-full bg-amber-400"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
              {activeStage && STAGE_LABEL[activeStage]}
              {pendingCount > 1 && (
                <span className="rounded-full border border-amber-800/50 bg-amber-950/20 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-400" title="Phrases waiting in the playback queue">
                  +{pendingCount - 1} queued
                </span>
              )}
            </div>
          )}
          {playing && (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <span className="flex h-4 items-end gap-0.5" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="lt-eq-bar h-full w-1 rounded-full bg-emerald-400"
                    style={{ animationDelay: `${i * 0.12}s` }}
                  />
                ))}
              </span>
              Playing in your voice
            </div>
          )}
          {latest && !processing && !present && (
            <button
              type="button"
              onClick={() => void copyTranslation()}
              aria-label="Copy translation to clipboard"
              title="Copy translation"
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
                copied
                  ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-700/60 hover:text-emerald-300'
              )}
            >
              {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          )}
          {canReplay && !playing && !processing && !present && (
            <button
              type="button"
              onClick={onReplay}
              aria-label="Replay last translation"
              title="Replay last translation"
              className="group inline-flex h-7 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 text-[11px] font-semibold text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <RotateCcw className="h-3 w-3 transition-transform duration-300 group-hover:-rotate-180" aria-hidden />
              <span className="hidden sm:inline">Replay</span>
            </button>
          )}
          {onDownload && latest?.hasAudio && !playing && !processing && !present && (
            <button
              type="button"
              onClick={onDownload}
              aria-label="Download the translated audio as a WAV file"
              title="Download audio (.wav)"
              className="group inline-flex h-7 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 text-[11px] font-semibold text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <Download className="h-3 w-3 transition-transform duration-300 group-hover:translate-y-0.5" aria-hidden />
              <span className="hidden sm:inline">WAV</span>
            </button>
          )}
          {onShare && latest && !processing && !present && (
            <button
              type="button"
              onClick={onShare}
              aria-label="Share this translation"
              title="Share translation (text + audio where supported)"
              className="group inline-flex h-7 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 text-[11px] font-semibold text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <Share2 className="h-3 w-3 transition-transform duration-300 group-hover:-translate-y-0.5" aria-hidden />
              <span className="hidden sm:inline">Share</span>
            </button>
          )}
        </div>
      </div>

      {/* Failed segment retry (spec §7) — completed phrases are never lost */}
      {lastError && !processing && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-rose-900/50 bg-rose-950/20 px-3 py-2"
        >
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-rose-200/90">
            A segment failed ({lastError.stage === 'queue' ? 'pipeline busy' : lastError.stage}).
            Everything before it is safe.
          </span>
          {onRetryFailed && (
            <button
              type="button"
              onClick={onRetryFailed}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-rose-800/60 bg-rose-950/50 px-2.5 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
            >
              <RotateCcw className="h-3 w-3" aria-hidden /> Retry
            </button>
          )}
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss error"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-rose-300/70 hover:text-rose-200"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}

      {/* Live caption — partial ASR while the user is still talking */}
      {captionVisible && liveCaption && (
        <motion.div
          key={liveCaption.id}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="status"
          aria-label="Live caption of what you are saying"
          className="mb-3 flex items-start gap-2.5 rounded-xl border border-rose-900/50 bg-rose-950/20 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        >
          <Mic2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-rose-400" aria-hidden />
          <div className="min-w-0 flex-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-rose-300/70">
              Hearing… {(liveCaption.elapsedMs / 1000).toFixed(1)}s
            </span>
            <p
              dir={src.rtl ? 'rtl' : 'ltr'}
              lang={pair.sourceLang}
              className={cn(
                'break-words leading-snug text-zinc-200',
                bigButton ? 'text-base' : 'text-sm',
                src.rtl && 'font-fa text-right'
              )}
            >
              {liveCaption.text}
            </p>
          </div>
        </motion.div>
      )}

      {partialVisible && partial ? (
        /* Early text delivery — translation arrived, audio still synthesizing */
        <motion.div
          key={partial.utteranceId}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className="flex flex-1 flex-col justify-center gap-4"
        >
          {partial.source && (
            <p
              dir={src.rtl ? 'rtl' : 'ltr'}
              lang={pair.sourceLang}
              className={cn(
                'leading-relaxed font-medium text-zinc-400',
                present ? 'text-2xl sm:text-3xl' : HERO_SRC[textScale],
                src.rtl ? 'font-fa text-right' : 'text-left'
              )}
            >
              {partial.source}
            </p>
          )}
          <div className="lt-sweep">
            <p
              dir={tgt.rtl ? 'rtl' : 'ltr'}
              lang={pair.targetLang}
              className={cn(
                'font-semibold leading-tight tracking-tight text-white',
                present ? 'text-4xl sm:text-5xl' : HERO_TGT[textScale],
                tgt.rtl && 'font-fa text-right'
              )}
            >
              {partial.translated}
            </p>
          </div>
          <div className={cn('flex flex-wrap items-center gap-2 text-[11px] text-zinc-500', present && 'hidden')}>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1">
              <span aria-hidden>{src.flag}</span>
              <span aria-hidden className="text-zinc-600">→</span>
              <span aria-hidden>{tgt.flag}</span>
              {src.name} → {tgt.name}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-800/50 bg-amber-950/20 px-2.5 py-1 text-amber-400">
              <span className="flex h-3 items-end gap-[2px]" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="lt-eq-bar h-full w-[3px] rounded-full bg-amber-400"
                    style={{ animationDelay: `${i * 0.14}s` }}
                  />
                ))}
              </span>
              <WandSparkles className="h-3 w-3" aria-hidden />
              voicing it in your voice…
            </span>
          </div>
        </motion.div>
      ) : latest ? (
        <motion.div
          key={latest.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: 'easeOut' }}
          className="flex flex-1 flex-col justify-center gap-4"
        >
          {/* Source (direction-aware) */}
          {latest.source && (
            <p
              dir={src.rtl ? 'rtl' : 'ltr'}
              lang={pair.sourceLang}
              className={cn(
                'leading-relaxed font-medium text-zinc-400',
                present ? 'text-2xl sm:text-3xl' : HERO_SRC[textScale],
                src.rtl ? 'font-fa text-right' : 'text-left'
              )}
            >
              {latest.source}
            </p>
          )}
          {/* Translation (direction-aware) */}
          <p
            dir={tgt.rtl ? 'rtl' : 'ltr'}
            lang={pair.targetLang}
            className={cn(
              'font-semibold leading-tight tracking-tight text-white',
              present ? 'text-4xl sm:text-5xl' : HERO_TGT[textScale],
              tgt.rtl && 'font-fa text-right'
            )}
          >
            {latest.translated || '…'}
          </p>
          <div className={cn('flex flex-wrap items-center gap-2 text-[11px] text-zinc-500', present && 'hidden')}>
            {/* Voice A/B — the real translation, YOUR profile voice (A) vs default (B) */}
            {(abProfileId || abProfile) && latest.translated && (
              <button
                type="button"
                onClick={ab === 'idle' ? () => void startAb() : stopAb}
                disabled={ab === 'loading'}
                aria-label={
                  ab === 'idle'
                    ? 'Compare your enrolled voice with the default voice on this translation'
                    : 'Stop voice comparison'
                }
                title={`This translation with your enrolled voice (A) vs the default “${DEFAULT_ENGINE_VOICE}” (B)`}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/60',
                  ab !== 'idle'
                    ? 'border-teal-700/60 bg-teal-950/40 text-teal-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-teal-700/60 hover:text-teal-300'
                )}
              >
                {ab === 'loading' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-teal-400" aria-hidden />
                ) : ab !== 'idle' ? (
                  <Square className="h-2.5 w-2.5" aria-hidden />
                ) : (
                  <ArrowLeftRight className="h-3 w-3 text-teal-400" aria-hidden />
                )}
                {ab === 'loading' ? 'Loading A/B…' : ab === 'a' ? 'A · your voice' : ab === 'b' ? 'B · default' : 'Voice A/B'}
                {(ab === 'a' || ab === 'b') && (
                  <span className="ml-0.5 flex items-end gap-[2px]" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="lt-eq-bar w-[2px] rounded-full bg-teal-400"
                        style={{ height: `${5 + ((i * 4) % 6)}px`, animationDelay: `${i * 140}ms` }}
                      />
                    ))}
                  </span>
                )}
              </button>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 transition-colors hover:border-zinc-700">
              <span aria-hidden>{src.flag}</span>
              <span aria-hidden className="text-zinc-600">→</span>
              <span aria-hidden>{tgt.flag}</span>
              {src.name} → {tgt.name}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 transition-colors hover:border-zinc-700">
              <Mic2 className="h-3 w-3 text-emerald-500" aria-hidden />
              {latest.voice}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 transition-colors hover:border-zinc-700">
              <Clock className="h-3 w-3 text-zinc-500" aria-hidden />
              <span className="font-mono">{(latest.timings.totalMs / 1000).toFixed(1)}s</span>
              end-to-end
            </span>
          </div>
        </motion.div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-dashed border-zinc-700/60 bg-zinc-900/50">
            <AudioLines className="h-7 w-7 text-emerald-500/60" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <p className="lt-text-gradient text-lg font-semibold tracking-tight">
              Press START and speak in {src.name}
            </p>
            {langPair.sourceLang === 'fa' ? (
              <p dir="rtl" lang="fa" className="font-fa mx-auto max-w-sm text-sm leading-relaxed text-zinc-500">
                {langPair.targetLang === 'fa'
                  ? 'حالت مترجم: انگلیسی صحبت کنید، معنی فارسی را همین‌جا ببینید'
                  : 'دکمه را بزنید و فارسی صحبت کنید — ترجمه را با صدای خودتان بشنوید'}
              </p>
            ) : (
              <p className="mx-auto max-w-sm text-sm leading-relaxed text-zinc-500">
                Speak {src.name} out loud — the {tgt.name} translation appears here instantly.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Output waveform strip while audio plays */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none -mx-1 mt-4 flex h-8 items-center justify-center gap-[3px] overflow-hidden transition-opacity duration-500',
          playing ? 'opacity-100' : 'opacity-0'
        )}
      >
        {WAVE_BARS.map((h, i) => (
          <span
            key={i}
            className={cn('w-1 rounded-full', playing ? 'lt-eq-bar bg-gradient-to-t from-emerald-600 to-lime-400' : 'bg-zinc-800')}
            style={{
              height: `${h}%`,
              animationDelay: `${(i % 12) * 0.09}s`,
              animationDuration: `${0.7 + (i % 5) * 0.13}s`,
            }}
          />
        ))}
      </div>

      {/* Hold-to-talk (push-to-talk) — desktop Space key mirrors this button */}
      {onPushToTalk && bigButton ? (
        <button
          type="button"
          onPointerDown={() => {
            setPttHeld(true)
            onPushToTalk(true)
          }}
          onPointerUp={() => {
            setPttHeld(false)
            onPushToTalk(false)
          }}
          onPointerLeave={() => {
            if (pttHeld) {
              setPttHeld(false)
              onPushToTalk(false)
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Hold to talk — release to send"
          className={cn(
            'mt-2 inline-flex h-32 w-full touch-none select-none flex-col items-center justify-center gap-2 rounded-2xl border-2 transition-all duration-150 sm:h-36',
            pttHeld
              ? 'scale-[0.98] border-rose-500/80 bg-rose-600/20 text-rose-200 shadow-[0_0_44px_-8px_rgba(244,63,94,0.65),inset_0_1px_0_rgba(255,255,255,0.08)]'
              : 'border-emerald-900/70 bg-gradient-to-b from-zinc-900 to-emerald-950/30 text-emerald-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-emerald-700'
          )}
        >
          <Mic2 className={cn('h-8 w-8', pttHeld ? 'animate-pulse' : 'drop-shadow-[0_0_10px_rgba(16,185,129,0.45)]')} aria-hidden />
          <span className="text-sm font-black uppercase tracking-[0.22em]">
            {pttHeld ? 'Recording…' : 'Hold to talk'}
          </span>
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            {pttHeld ? 'release to send' : 'tap and hold while you speak'}
          </span>
        </button>
      ) : onPushToTalk && (
        <button
          type="button"
          onPointerDown={() => {
            setPttHeld(true)
            onPushToTalk(true)
          }}
          onPointerUp={() => {
            setPttHeld(false)
            onPushToTalk(false)
          }}
          onPointerLeave={() => {
            if (pttHeld) {
              setPttHeld(false)
              onPushToTalk(false)
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Hold to talk — release to send"
          className={cn(
            'mt-2 inline-flex h-10 w-full touch-none select-none items-center justify-center gap-2 rounded-xl border text-xs font-bold uppercase tracking-[0.14em] transition-all duration-150',
            pttHeld
              ? 'border-rose-500/70 bg-rose-600/20 text-rose-300 shadow-[0_0_28px_-6px_rgba(244,63,94,0.55),inset_0_1px_0_rgba(255,255,255,0.08)]'
              : 'border-zinc-800 bg-zinc-900/70 text-zinc-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-zinc-700 hover:text-zinc-300'
          )}
        >
          <Mic2 className={cn('h-3.5 w-3.5', pttHeld && 'animate-pulse')} aria-hidden />
          {pttHeld ? 'Recording — release to send' : 'Hold to talk · release to send'}
          <kbd className="ml-1 hidden rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500 sm:inline">
            SPACE
          </kbd>
        </button>
      )}

      {/* Manual speaker turn — two-person conversations. Honest: the ASR engine
          has NO diarization, so who is speaking is an explicit user action. */}
      {onSpeakerChange && (
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2.5">
          <div className="flex items-center gap-2" role="radiogroup" aria-label="Current speaker">
            {(['A', 'B'] as const).map((role) => {
              const active = (speaker ?? 'A') === role
              return (
                <button
                  key={role}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSpeakerChange(role)}
                  className={cn(
                    'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-bold uppercase tracking-[0.14em] transition-all',
                    active
                      ? 'border-teal-500/70 bg-teal-950/50 text-teal-200 shadow-[0_0_18px_-6px_rgba(45,212,191,0.7)]'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  )}
                >
                  <AudioLines className={cn('h-3.5 w-3.5', active && role === 'B' && 'text-teal-300')} aria-hidden />
                  Speaker {role}
                  {role === 'A' && <span className="hidden text-[9px] font-medium normal-case tracking-normal text-zinc-500 sm:inline">(your voice)</span>}
                  {role === 'B' && <span className="hidden text-[9px] font-medium normal-case tracking-normal text-zinc-500 sm:inline">(2nd voice)</span>}
                </button>
              )
            })}
          </div>
          <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-zinc-600">{speakerNote ?? 'Speaker detection is not automatic — tap the button when the other person takes a turn. Speaker B is spoken with a distinct voice.'}</p>
        </div>
      )}

      {/* Type-to-translate — same pipeline, no ASR */}
      <form
        onSubmit={(e) => void submitDraft(e)}
        className="mt-3 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-emerald-800/70"
      >
        <span className="ml-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-500">
          <Keyboard className="h-3.5 w-3.5" aria-hidden />
        </span>
        <label htmlFor="lt-text-input" className="sr-only">
          Type a phrase to translate instead of speaking
        </label>
        <input
          id="lt-text-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={1000}
          autoComplete="off"
          dir={src.rtl ? 'rtl' : 'ltr'}
          placeholder={`…or type in ${src.name}`}
          className="w-0 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          aria-label="Translate typed phrase"
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all',
            draft.trim() && !sending
              ? 'bg-emerald-600 text-zinc-950 shadow-[0_0_16px_-4px_rgba(16,185,129,0.8)] hover:bg-emerald-500'
              : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
          )}
        >
          <SendHorizonal className={cn('h-3.5 w-3.5', sending && 'animate-pulse')} aria-hidden />
          <span className="hidden sm:inline">{sending ? 'Sending' : 'Translate'}</span>
        </button>
      </form>
    </section>
  )
}
