'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, AudioLines, BadgeCheck, CircleAlert, CircleStop, Fingerprint, Loader2, Mic, ShieldCheck, Square, Trash2, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MicRecorder, pcmFromBase64, pcmToBase64 } from '@/lib/audio/mic-recorder'
import type { VoiceProfileData } from '@/hooks/use-translator'
import { cn } from '@/lib/utils'

const MAX_SAMPLE_SEC = 12
const MIN_SAMPLE_SEC = 3

const READ_ALOUD_FA = 'سلام، من صدای خودم را برای مترجم زنده ضبط می‌کنم. امروز هوا خیلی خوب است و من حسابی خوشحالم.'

/** The engine voice + speed used when no profile is active (must match the pipeline default). */
const DEFAULT_ENGINE_VOICE = 'kazi'

interface VoiceProfileCardProps {
  profile: VoiceProfileData | null
  loading: boolean
  onCreate: (audioBase64: string, sampleRate: number, consented: boolean) => Promise<VoiceProfileData | null>
  onDelete: () => Promise<void>
  /** Output language of the current language pair — preview sentence follows it. */
  previewLang: string
}

/** Internal flow phases. The "has profile" view is derived from props. */
type Phase = 'idle' | 'recording' | 'analyzing'
type PreviewPhase = 'idle' | 'loading' | 'playing'
/** A/B compare: my mapped voice vs the default engine voice, same sentence. */
type ComparePhase = 'idle' | 'loading' | 'a' | 'b'

export function VoiceProfileCard({ profile, loading, onCreate, onDelete, previewLang }: VoiceProfileCardProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [preview, setPreview] = useState<PreviewPhase>('idle')
  const [compare, setCompare] = useState<ComparePhase>('idle')
  /** Explicit enrollment consent (spec §3.4) — required before recording. */
  const [consented, setConsented] = useState(false)
  const recorderRef = useRef<MicRecorder | null>(null)
  const chunksRef = useRef<Int16Array[]>([])
  const totalSamplesRef = useRef(0)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  /** Set when the listener stops a compare run — prevents auto-advancing to B. */
  const compareStopRef = useRef(false)

  // Stop preview audio when leaving the page / unmounting
  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause()
      previewAudioRef.current = null
    }
  }, [])

  // ── Voice A/B preview: audition the mapped engine voice ───────────────
  const startPreview = useCallback(async () => {
    if (!profile || preview === 'loading') return
    previewAudioRef.current?.pause()
    setPreview('loading')
    try {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: profile.mappedVoice, speed: profile.speedAdjust, lang: previewLang }),
      })
      const data = await res.json()
      if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
      const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`)
      previewAudioRef.current = audio
      audio.onended = () => setPreview('idle')
      audio.onpause = () => setPreview((p) => (p === 'playing' ? 'idle' : p))
      await audio.play()
      setPreview('playing')
    } catch {
      setPreview('idle')
    }
  }, [profile, preview, previewLang])

  const stopPreview = useCallback(() => {
    previewAudioRef.current?.pause()
    setPreview('idle')
  }, [])

  // ── Voice A/B compare: mapped voice vs default, same sentence ─────────
  const fetchPreviewUrl = useCallback(async (voice: string, speed: number): Promise<string> => {
    const res = await fetch('/api/voice-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice, speed, lang: previewLang }),
    })
    const data = await res.json()
    if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
    return `data:audio/wav;base64,${data.audioBase64}`
  }, [previewLang])

  /** Play one compare leg; resolves when it ends or the listener stops it. */
  const playCompareLeg = useCallback(
    (url: string, phase: 'a' | 'b') =>
      new Promise<void>((resolve, reject) => {
        const audio = new Audio(url)
        previewAudioRef.current = audio
        audio.onended = () => resolve()
        audio.onpause = () => {
          if (compareStopRef.current) resolve()
        }
        audio.onerror = () => reject(new Error('playback failed'))
        setCompare(phase)
        void audio.play().catch(reject)
      }),
    []
  )

  const startCompare = useCallback(async () => {
    if (!profile || compare !== 'idle') return
    previewAudioRef.current?.pause()
    compareStopRef.current = false
    setCompare('loading')
    try {
      const urlA = await fetchPreviewUrl(profile.mappedVoice, profile.speedAdjust)
      if (compareStopRef.current) return
      // Prefetch leg B while leg A plays — halves the gap between them.
      const urlBPromise = fetchPreviewUrl(DEFAULT_ENGINE_VOICE, 1).catch(() => null)
      await playCompareLeg(urlA, 'a')
      if (compareStopRef.current) return
      const urlB = await urlBPromise
      if (!urlB || compareStopRef.current) return
      await playCompareLeg(urlB, 'b')
    } catch {
      // Network/playback failure — reset quietly; the single preview still works.
    } finally {
      compareStopRef.current = false
      setCompare('idle')
    }
  }, [compare, fetchPreviewUrl, playCompareLeg, profile])

  const stopCompare = useCallback(() => {
    compareStopRef.current = true
    previewAudioRef.current?.pause()
    setCompare('idle')
  }, [])

  // Derive the visible view during render (no sync effect needed):
  //   recording > analyzing > profile view (if profile exists) > empty state
  const view: 'recording' | 'analyzing' | 'profile' | 'empty' =
    phase === 'recording'
      ? 'recording'
      : phase === 'analyzing' || (loading && !profile)
        ? 'analyzing'
        : profile
          ? 'profile'
          : 'empty'

  const finalize = useCallback(async () => {
    const chunks = chunksRef.current
    chunksRef.current = []
    totalSamplesRef.current = 0
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) await recorder.stop()

    const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0)
    const durationSec = totalSamples / 16000

    if (durationSec < MIN_SAMPLE_SEC) {
      setPhase('idle')
      return
    }

    setPhase('analyzing')
    const merged = new Int16Array(totalSamples)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    await onCreate(pcmToBase64(merged), 16000, true)
    setPhase('idle')
    // The parent hook owns profile state after creation
  }, [onCreate])

  const startRecording = useCallback(async () => {
    if (recorderRef.current) return
    chunksRef.current = []
    totalSamplesRef.current = 0
    setElapsed(0)

    const recorder = new MicRecorder({
      // Continuous capture: no silence cuts — the whole sample is one utterance
      silenceMs: 999999,
      speechStartMs: 60,
      maxUtteranceSec: MAX_SAMPLE_SEC,
      minUtteranceSec: 0.2,
      onUtterance: (base64) => {
        const pcm = pcmFromBase64(base64)
        chunksRef.current.push(pcm)
        totalSamplesRef.current += pcm.length
      },
      onLevel: setLevel,
      onError: () => {
        setPhase('idle')
      },
    })

    try {
      await recorder.start()
      recorderRef.current = recorder
      setPhase('recording')
    } catch {
      // Mic permission errors surface via toast in main flow; keep UI consistent
      setPhase('idle')
    }
  }, [])

  // Recording timer + auto stop
  useEffect(() => {
    if (phase !== 'recording') return
    const startedAt = performance.now()
    const interval = setInterval(() => {
      const sec = (performance.now() - startedAt) / 1000
      setElapsed(sec)
      if (sec >= MAX_SAMPLE_SEC) void finalize()
    }, 100)
    return () => clearInterval(interval)
  }, [phase, finalize])

  const removeProfile = useCallback(async () => {
    await onDelete()
    setPhase('idle')
  }, [onDelete])

  const recording = phase === 'recording'
  const progress = Math.min(1, elapsed / MAX_SAMPLE_SEC)
  const previewBusy = preview !== 'idle' || compare !== 'idle'

  return (
    <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
            <Fingerprint className="h-3.5 w-3.5" aria-hidden />
          </span>
          <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">
            Voice Identity
          </h2>
        </div>
        {profile && view === 'profile' && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
            title="Estimated match: closest engine voice to your pitch & tempo — not a clone"
          >
            <BadgeCheck className="h-3 w-3" aria-hidden /> VOICE MATCH
          </span>
        )}
      </header>

      {view === 'profile' && profile ? (
        <div className="space-y-4">
          {/* Honest capability disclosure (spec §3.3) */}
          <p className="flex gap-2 rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/80">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
            <span>
              <span className="font-semibold text-amber-200">Estimated match.</span> Your pitch,
              timbre and tempo are mapped to the closest studio voice — your identity is
              approximated, not replicated. A true cloning engine can be swapped in later.
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <ProfileStat label="Mean pitch" value={`${profile.meanF0.toFixed(0)} Hz`} />
            <ProfileStat label="Character" value={profile.voiceCharacter.split(' · ')[1] ?? 'Balanced'} />
            <ProfileStat label="Engine voice" value={profile.mappedVoice} mono />
            <ProfileStat label="Tempo match" value={`×${profile.speedAdjust.toFixed(2)}`} />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={preview === 'playing' ? stopPreview : () => void startPreview()}
              disabled={preview === 'loading' || compare !== 'idle'}
              aria-label={
                preview === 'playing' ? 'Stop voice preview' : 'Hear how your mapped voice sounds'
              }
              className={cn(
                'h-8 flex-1 gap-1.5 border-zinc-700 bg-zinc-900 text-xs transition-colors',
                preview === 'playing'
                  ? 'border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40'
                  : 'text-zinc-300 hover:bg-zinc-800'
              )}
            >
              {preview === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" aria-hidden />
              ) : preview === 'playing' ? (
                <Square className="h-3 w-3" aria-hidden />
              ) : (
                <Volume2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
              )}
              {preview === 'loading' ? 'Synthesizing…' : preview === 'playing' ? 'Stop preview' : 'Hear my voice'}
              {preview === 'playing' && (
                <span className="ml-0.5 flex items-end gap-[2px]" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="lt-eq-bar w-[2px] rounded-full bg-emerald-400"
                      style={{ height: `${6 + ((i * 5) % 7)}px`, animationDelay: `${i * 140}ms` }}
                    />
                  ))}
                </span>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={compare === 'idle' ? () => void startCompare() : stopCompare}
              disabled={compare === 'loading' || preview !== 'idle'}
              aria-label={
                compare === 'idle'
                  ? 'Compare my mapped voice with the default voice'
                  : 'Stop voice comparison'
              }
              title={`Same sentence with “${profile.mappedVoice}” vs the default “${DEFAULT_ENGINE_VOICE}”`}
              className={cn(
                'h-8 flex-1 gap-1.5 border-zinc-700 bg-zinc-900 text-xs transition-colors',
                compare !== 'idle'
                  ? 'border-teal-700/60 text-teal-300 hover:bg-teal-950/40'
                  : 'text-zinc-300 hover:bg-zinc-800'
              )}
            >
              {compare === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-400" aria-hidden />
              ) : compare !== 'idle' ? (
                <Square className="h-3 w-3" aria-hidden />
              ) : (
                <ArrowLeftRight className="h-3.5 w-3.5 text-teal-400" aria-hidden />
              )}
              {compare === 'loading'
                ? 'Loading A/B…'
                : compare === 'a'
                  ? `A · ${profile.mappedVoice}`
                  : compare === 'b'
                    ? `B · default`
                    : 'Compare A/B'}
              {compare === 'a' || compare === 'b' ? (
                <span className="ml-0.5 flex items-end gap-[2px]" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="lt-eq-bar w-[2px] rounded-full bg-teal-400"
                      style={{ height: `${6 + ((i * 5) % 7)}px`, animationDelay: `${i * 140}ms` }}
                    />
                  ))}
                </span>
              ) : null}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={startRecording}
              disabled={previewBusy}
              className="h-8 flex-1 gap-1.5 border-zinc-700 bg-zinc-900 text-xs hover:bg-zinc-800"
            >
              <Mic className="h-3.5 w-3.5" aria-hidden /> Re-record
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={removeProfile}
              disabled={previewBusy}
              className="h-8 gap-1.5 border-zinc-700 bg-zinc-900 px-3 text-xs text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      ) : view === 'recording' ? (
        <div className="space-y-3">
          {/* Level meter */}
          <div className="flex h-10 items-end gap-1" aria-hidden>
            <div className="flex h-full flex-1 items-end overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
              <div
                className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.4)] transition-all duration-100"
                style={{ width: `${Math.min(100, level * 100)}%` }}
              />
            </div>
            <span className="ml-1 w-10 text-right font-mono text-xs font-semibold text-emerald-400">
              {Math.max(0, MAX_SAMPLE_SEC - elapsed).toFixed(0)}s
            </span>
          </div>
          {/* Progress */}
          <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-100"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <div className="rounded-xl border border-dashed border-zinc-700/60 bg-zinc-900/40 p-3">
            <p dir="rtl" lang="fa" className="font-fa text-center text-sm leading-relaxed text-zinc-300">
              {READ_ALOUD_FA}
            </p>
          </div>
          <p className="text-center text-[11px] text-zinc-600">
            Read the sentence aloud in a normal voice
          </p>
          <Button
            size="sm"
            onClick={() => void finalize()}
            className="h-9 w-full gap-1.5 bg-rose-600 text-xs hover:bg-rose-500"
          >
            <CircleStop className="h-4 w-4" aria-hidden /> Stop & Create Profile
          </Button>
        </div>
      ) : view === 'analyzing' ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-500" aria-hidden />
          <p className="text-sm text-zinc-400">Analyzing your voice…</p>
          <p className="text-[11px] text-zinc-600">Pitch · timbre · tempo → engine voice</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-zinc-400">
            Record a short sample so the translator can speak with{' '}
            <span className="text-zinc-200">your voice identity</span>.
          </p>
          {/* Explicit consent before enrollment (spec §3.4) */}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
            />
            <span className="text-[11px] leading-relaxed text-zinc-400">
              <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-emerald-500" aria-hidden />
              I consent to my voice sample being analyzed to create this profile. The raw audio is
              processed in memory only — never stored.
            </span>
          </label>
          <Button
            size="sm"
            onClick={startRecording}
            disabled={!consented}
            className="h-10 w-full gap-2 bg-emerald-600 text-xs font-semibold hover:bg-emerald-500 disabled:opacity-50"
          >
            <AudioLines className="h-4 w-4" aria-hidden /> Record My Voice ({MAX_SAMPLE_SEC}s)
          </Button>
          <p className="text-center text-[11px] leading-relaxed text-zinc-600">
            Your sample is analyzed on the server (pitch, timbre, tempo) and mapped to the closest
            engine voice — an estimated match, not a deep-fake clone. Audio is not stored.
          </p>
        </div>
      )}
    </section>
  )
}

function ProfileStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={cn('mt-0.5 truncate text-sm font-semibold text-zinc-200', mono && 'font-mono text-xs')}>
        {value}
      </p>
    </div>
  )
}
