'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Voice Identity view — dedicated enrollment workspace:
//   consent → record sample → REVIEW (replay / re-record) → submit
//   → honest stage tracker (incl. real provider enrollment) → profile.
// Two profile modes, labeled truthfully everywhere:
//   CLONE        — real cross-language voice cloning (ElevenLabs IVC). The
//                  generated English audio comes from the enrolled voice.
//   PITCH-MATCH  — estimated pitch-conformed preset (used when no cloning
//                  credential is configured; never presented as a clone).
// Plus: multi-profile management, sample-quality feedback, honest similarity
// estimate, Test-my-voice preview, A/B compare, cloning advanced settings.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight, AudioLines, BadgeCheck, ChevronDown, CircleAlert, CircleStop, Fingerprint, Loader2,
  Mic, Pencil, Play, Plus, RotateCcw, ShieldCheck, Sliders, Square, Star, Trash2, Volume2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { MicRecorder, pcmFromBase64, pcmToBase64 } from '@/lib/audio/mic-recorder'
import type { VoiceProfileData } from '@/hooks/use-translator'
import { cn } from '@/lib/utils'

const MAX_SAMPLE_SEC = 15
const MIN_SAMPLE_SEC = 3

const READ_ALOUD_FA = 'سلام، من صدای خودم را برای مترجم زنده ضبط می‌کنم. امروز هوا خیلی خوب است و من حسابی خوشحالم.'

/** The engine voice + speed used when no profile is active (matches the pipeline default). */
const DEFAULT_ENGINE_VOICE = 'kazi'

export interface VoiceCapabilities {
  canClone: boolean
  cloneConfigured: boolean
  engine: string
  mode: string
  note?: string
  setup?: { envVar: string; envFile: string; steps: string[] } | null
}

interface VoiceIdentityViewProps {
  profile: VoiceProfileData | null
  profiles: VoiceProfileData[]
  loading: boolean
  capabilities: VoiceCapabilities | null
  onCreate: (
    audioBase64: string,
    sampleRate: number,
    consented: boolean,
    name?: string,
    cloneOpts?: {
      providerModel?: 'balanced' | 'quality'
      stability?: number
      providerSimilarity?: number
      providerStyle?: number
      extraSamples?: string[]
    }
  ) => Promise<VoiceProfileData | null>
  onSelect: (id: string) => Promise<boolean>
  onRename: (id: string, name: string) => Promise<boolean>
  onDelete: (id?: string) => Promise<void>
  onUpdateClone: (id: string, patch: { providerModel?: 'balanced' | 'quality'; stability?: number; providerSimilarity?: number; providerStyle?: number }) => Promise<boolean>
  /** Output language of the current language pair — preview sentence follows it. */
  previewLang: string
}

type Phase = 'idle' | 'recording' | 'review' | 'analyzing'
type PreviewPhase = 'idle' | 'loading' | 'playing'
type ComparePhase = 'idle' | 'loading' | 'a' | 'b'

/** Stages shown while enrolling — the clone path adds the real provider leg. */
const STAGES_MATCH = ['Recording sample', 'Uploading audio', 'Validating sample', 'Analyzing pitch & timbre', 'Conforming pitch', 'Saving profile']
const STAGES_CLONE = ['Recording sample', 'Uploading audio', 'Validating sample', 'Analyzing voice', 'Provider enrollment', 'Provider confirmation', 'Saving profile']

/** Minimal RIFF/WAV writer — client-side replay of the recorded PCM sample. */
function pcmToWavClient(pcm: Int16Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, v, true))
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Honest similarity band from measurable sample properties — explicitly an
 *  estimate; the provider returns no similarity score, so no percentage. */
function similarityBand(p: VoiceProfileData): { band: string; reason: string; tone: 'good' | 'fair' | 'low' } {
  const dur = p.sampleDuration ?? 0
  const snr = p.snrDb ?? 0
  if (p.mode !== 'clone') {
    return { band: 'Estimated', reason: 'pitch-conformed preset match', tone: 'fair' }
  }
  if (dur >= 12 && snr >= 15) return { band: 'Good', reason: `${dur.toFixed(0)}s clean sample`, tone: 'good' }
  if (dur >= 8) return { band: 'Fair', reason: `${dur.toFixed(0)}s sample${snr < 12 ? ' · room noise present' : ''}`, tone: 'fair' }
  return { band: 'Limited', reason: `short sample (${dur.toFixed(0)}s) — re-enroll with 12s+ for a better clone`, tone: 'low' }
}

/** Deterministic waveform bars computed from the ACTUAL recorded PCM — a real
 *  preview of the sample, never a decorative fake. 44 buckets of RMS. */
function Waveform({ pcm, buckets = 44 }: { pcm: Int16Array | null; buckets?: number }) {
  if (!pcm || pcm.length === 0) return null
  const size = Math.floor(pcm.length / buckets) || 1
  const bars: number[] = []
  for (let b = 0; b < buckets; b++) {
    let sum = 0
    const start = b * size
    const end = Math.min(pcm.length, start + size)
    for (let i = start; i < end; i++) {
      const v = pcm[i] / 32768
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    bars.push(Math.min(1, rms * 3.2))
  }
  return (
    <div className="flex h-12 items-center gap-[2px] rounded-xl border border-zinc-800 bg-zinc-950/60 px-2" aria-hidden>
      {bars.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-full bg-gradient-to-t from-emerald-700 to-emerald-400"
          style={{ height: `${Math.max(6, v * 100)}%`, opacity: 0.35 + v * 0.65 }}
        />
      ))}
    </div>
  )
}

export function VoiceIdentityView({
  profile, profiles, loading, capabilities, onCreate, onSelect, onRename, onDelete, onUpdateClone, previewLang,
}: VoiceIdentityViewProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [preview, setPreview] = useState<PreviewPhase>('idle')
  const [compare, setCompare] = useState<ComparePhase>('idle')
  /** Explicit enrollment consent — required before recording. */
  const [consented, setConsented] = useState(false)
  /** Optional profile name typed before recording. */
  const [profileName, setProfileName] = useState('')
  /** Cloning advanced choices applied at enrollment. */
  const [enrollModel, setEnrollModel] = useState<'balanced' | 'quality'>('balanced')
  const [enrollStability, setEnrollStability] = useState(0.5)
  const [enrollSimilarity, setEnrollSimilarity] = useState(0.8)
  const [enrollStyle, setEnrollStyle] = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(false)
  /** Multi-take enrollment: saved takes merge into ONE provider embedding
   *  (ElevenLabs IVC accepts multiple files). Max 3 takes total. */
  const MAX_TAKES = 3
  const takesRef = useRef<Int16Array[]>([])
  const [takeCount, setTakeCount] = useState(0)
  /** Elapsed seconds of the REAL server round-trip (honest progress). */
  const [analyzeElapsed, setAnalyzeElapsed] = useState(0)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)
  const [reviewPlaying, setReviewPlaying] = useState(false)
  /** Last preview/compare error — rendered inline, honest, dismissible. */
  const [previewError, setPreviewError] = useState<string | null>(null)
  const recorderRef = useRef<MicRecorder | null>(null)
  const chunksRef = useRef<Int16Array[]>([])
  const reviewPcmRef = useRef<Int16Array | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const reviewAudioRef = useRef<HTMLAudioElement | null>(null)
  const compareStopRef = useRef(false)

  const cloneReady = capabilities?.cloneConfigured === true

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause()
      previewAudioRef.current = null
      reviewAudioRef.current?.pause()
      reviewAudioRef.current = null
    }
  }, [])

  // ── Preview: audition the active profile (clone or pitch-conformed) ──────
  const startPreview = useCallback(async () => {
    if (!profile || preview === 'loading') return
    previewAudioRef.current?.pause()
    setPreview('loading')
    try {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: profile.id, lang: previewLang }),
      })
      const data = await res.json()
      if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
      const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`)
      previewAudioRef.current = audio
      audio.onended = () => setPreview('idle')
      audio.onpause = () => setPreview((p) => (p === 'playing' ? 'idle' : p))
      await audio.play()
      setPreview('playing')
    } catch (err) {
      setPreview('idle')
      setPreviewError(err instanceof Error ? err.message : 'Preview unavailable — try again shortly')
    }
  }, [profile, preview, previewLang])

  const stopPreview = useCallback(() => {
    previewAudioRef.current?.pause()
    setPreview('idle')
  }, [])

  // ── A/B compare: YOUR profile voice vs the pipeline default ─────────────
  const fetchProfilePreviewUrl = useCallback(
    async (profileId: string): Promise<string> => {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, lang: previewLang }),
      })
      const data = await res.json()
      if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
      return `data:audio/wav;base64,${data.audioBase64}`
    },
    [previewLang]
  )

  const fetchPresetPreviewUrl = useCallback(
    async (voice: string): Promise<string> => {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice, speed: 1, lang: previewLang }),
      })
      const data = await res.json()
      if (!res.ok || !data.audioBase64) throw new Error(data.error ?? 'Preview unavailable')
      return `data:audio/wav;base64,${data.audioBase64}`
    },
    [previewLang]
  )

  const playCompareLeg = useCallback(
    (url: string, leg: 'a' | 'b') =>
      new Promise<void>((resolve, reject) => {
        const audio = new Audio(url)
        previewAudioRef.current = audio
        audio.onended = () => resolve()
        audio.onpause = () => {
          if (compareStopRef.current) resolve()
        }
        audio.onerror = () => reject(new Error('playback failed'))
        setCompare(leg)
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
      const urlA = await fetchProfilePreviewUrl(profile.id)
      if (compareStopRef.current) return
      const urlBPromise = fetchPresetPreviewUrl(DEFAULT_ENGINE_VOICE).catch(() => null)
      await playCompareLeg(urlA, 'a')
      if (compareStopRef.current) return
      const urlB = await urlBPromise
      if (!urlB || compareStopRef.current) return
      await playCompareLeg(urlB, 'b')
    } catch {
      setPreviewError('A/B compare failed — the single preview still works. Try again shortly.')
    } finally {
      compareStopRef.current = false
      setCompare('idle')
    }
  }, [compare, fetchProfilePreviewUrl, fetchPresetPreviewUrl, playCompareLeg, profile])

  const stopCompare = useCallback(() => {
    compareStopRef.current = true
    previewAudioRef.current?.pause()
    setCompare('idle')
  }, [])

  const view: 'recording' | 'review' | 'analyzing' | 'profile' | 'empty' =
    phase === 'recording'
      ? 'recording'
      : phase === 'review'
        ? 'review'
        : phase === 'analyzing' || (loading && !profile)
          ? 'analyzing'
          : profile
            ? 'profile'
            : 'empty'

  // ── Recording lifecycle ───────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (recorderRef.current) return
    chunksRef.current = []
    setElapsed(0)

    const recorder = new MicRecorder({
      silenceMs: 999999, // continuous capture — the whole sample is one utterance
      speechStartMs: 60,
      maxUtteranceSec: MAX_SAMPLE_SEC,
      minUtteranceSec: 0.2,
      onUtterance: (base64) => {
        chunksRef.current.push(pcmFromBase64(base64))
      },
      onLevel: setLevel,
      onError: () => setPhase('idle'),
    })

    try {
      await recorder.start()
      recorderRef.current = recorder
      setPhase('recording')
    } catch {
      setPhase('idle')
    }
  }, [])

  /** Stop capturing and enter the REVIEW step (replay before submit). */
  const stopForReview = useCallback(async () => {
    const chunks = chunksRef.current
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) await recorder.stop()

    const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0)
    const durationSec = totalSamples / 16000
    if (durationSec < MIN_SAMPLE_SEC) {
      setPhase('idle')
      return
    }
    const merged = new Int16Array(totalSamples)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    reviewPcmRef.current = merged
    setReviewUrl(URL.createObjectURL(pcmToWavClient(merged, 16000)))
    setPhase('review')
  }, [])

  const playReview = useCallback(async () => {
    if (!reviewUrl) return
    reviewAudioRef.current?.pause()
    const audio = new Audio(reviewUrl)
    reviewAudioRef.current = audio
    audio.onended = () => setReviewPlaying(false)
    audio.onpause = () => setReviewPlaying(false)
    await audio.play()
    setReviewPlaying(true)
  }, [reviewUrl])

  /** Submit the reviewed sample(s) → provider enrollment (+ pitch analysis).
   *  All takes go to the provider; the primary take drives pitch analysis. */
  const submitSample = useCallback(async () => {
    const pcm = reviewPcmRef.current
    if (!pcm) {
      setPhase('idle')
      return
    }
    reviewAudioRef.current?.pause()
    setPhase('analyzing')
    setAnalyzeElapsed(0)
    await onCreate(pcmToBase64(pcm), 16000, true, profileName.trim() || undefined, {
      providerModel: enrollModel,
      stability: enrollStability,
      providerSimilarity: enrollSimilarity,
      providerStyle: enrollStyle,
      extraSamples: takesRef.current.length > 0 ? takesRef.current.map((t) => pcmToBase64(t)) : undefined,
    })
    // Reset the multi-take buffer after a completed attempt (success or fail —
    // the user sees the outcome and can start a fresh enrollment).
    takesRef.current = []
    setTakeCount(0)
    setProfileName('')
    setPhase('idle')
  }, [enrollModel, enrollStability, enrollSimilarity, enrollStyle, onCreate, profileName])

  /** Keep the reviewed take and record ANOTHER one (multi-sample enrollment). */
  const keepTakeAndRecordAgain = useCallback(() => {
    const pcm = reviewPcmRef.current
    if (!pcm || takesRef.current.length >= MAX_TAKES - 1) return
    takesRef.current.push(pcm)
    setTakeCount(takesRef.current.length)
    reviewAudioRef.current?.pause()
    reviewPcmRef.current = null
    setReviewUrl(null)
    setPhase('idle')
  }, [])

  const cancelReview = useCallback(() => {
    reviewAudioRef.current?.pause()
    reviewPcmRef.current = null
    setReviewUrl(null)
    setPhase('idle')
  }, [])

  // Recording timer + auto stop
  useEffect(() => {
    if (phase !== 'recording') return
    const startedAt = performance.now()
    const interval = setInterval(() => {
      const sec = (performance.now() - startedAt) / 1000
      setElapsed(sec)
      if (sec >= MAX_SAMPLE_SEC) void stopForReview()
    }, 100)
    return () => clearInterval(interval)
  }, [phase, stopForReview])

  const recording = phase === 'recording'
  const progress = Math.min(1, elapsed / MAX_SAMPLE_SEC)
  const previewBusy = preview !== 'idle' || compare !== 'idle'
  /** Honest progress: only REAL completed steps are shown as done. During the
   *  server round-trip we show the current step + a live elapsed timer — no
   *  invented percentages, no invented ETA (the provider gives none). */
  const stages = cloneReady ? STAGES_CLONE : STAGES_MATCH
  const analyzeTimerRunning = phase === 'analyzing'
  useEffect(() => {
    if (!analyzeTimerRunning) return
    const startedAt = performance.now()
    const interval = setInterval(() => setAnalyzeElapsed((performance.now() - startedAt) / 1000), 200)
    return () => clearInterval(interval)
  }, [analyzeTimerRunning])
  const stageIndex =
    recording ? 0 : phase === 'review' ? 1 : phase === 'analyzing' ? 2 : -1

  const isClone = profile?.mode === 'clone'

  return (
    <div className="lt-enter mx-auto flex max-w-3xl flex-col gap-6">
      {/* ── Provider status banner (honest capability report) ─────────────── */}
      <section
        className={cn(
          'rounded-2xl border p-4 text-[11px] leading-relaxed',
          cloneReady
            ? 'border-emerald-900/60 bg-emerald-950/20 text-emerald-200/90'
            : 'border-amber-900/40 bg-amber-950/20 text-amber-200/80'
        )}
      >
        <div className="flex gap-2">
          {cloneReady ? (
            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
          )}
          <div className="space-y-1.5">
            {cloneReady ? (
              <p>
                <span className="font-semibold text-emerald-200">Real voice cloning is active</span>{' '}
                (ElevenLabs Instant Voice Cloning). Your enrolled sample becomes a persistent cloned
                voice — translations are synthesized with YOUR timbre, pitch register and speaking
                style, cross-language (Persian reference → English speech).
              </p>
            ) : (
              <>
                <p>
                  <span className="font-semibold text-amber-200">Real voice cloning needs one credential.</span>{' '}
                  Until it is added, enrollment creates an honest <em>pitch-conformed match</em> (estimated,
                  not a clone). To enable genuine cloning:
                </p>
                <ol className="ml-4 list-decimal space-y-0.5">
                  {capabilities?.setup?.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                  {capabilities?.setup && (
                    <li>
                      Env var: <code className="rounded bg-amber-950/60 px-1 font-mono text-[10px]">{capabilities.setup.envVar}</code>{' '}
                      in <code className="rounded bg-amber-950/60 px-1 font-mono text-[10px]">{capabilities.setup.envFile}</code>
                    </li>
                  )}
                </ol>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ── Enrollment / active profile panel ─────────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
              <Fingerprint className="h-3.5 w-3.5" aria-hidden />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">
              Voice Identity
            </h2>
          </div>
          {profile && view === 'profile' && (
            isClone ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                title="Real cloned voice: synthesis uses your enrolled voice via ElevenLabs IVC"
              >
                <BadgeCheck className="h-3 w-3" aria-hidden /> REAL VOICE CLONE
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                title="Pitch-conformed match: your sample shapes pitch & tempo of the output — not a clone"
              >
                <BadgeCheck className="h-3 w-3" aria-hidden /> PITCH-CONFORMED MATCH
              </span>
            )
          )}
        </header>

        {view === 'profile' && profile ? (
          <div className="space-y-4">
            {/* Honest capability disclosure for the ACTIVE profile */}
            {isClone ? (
              <p className="flex gap-2 rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-3 py-2.5 text-[11px] leading-relaxed text-emerald-200/85">
                <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                <span>
                  <span className="font-semibold text-emerald-200">Your cloned voice is live.</span>{' '}
                  Every translated phrase is synthesized from this enrolled voice at the provider
                  (model: {profile.providerModel === 'quality' ? 'quality' : 'balanced'}). Deleting the
                  profile also deletes the sample + clone at the provider.
                </span>
              </p>
            ) : (
              <p className="flex gap-2 rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/80">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                <span>
                  <span className="font-semibold text-amber-200">Pitch-conformed match.</span> Your
                  sample&apos;s pitch (×{profile.pitchRatio?.toFixed(2) ?? '1.00'} shift), brightness
                  and tempo genuinely shape the synthesized audio — the closest studio voice is
                  re-tuned toward your register. It is an estimated match, not a vocal clone.
                  {cloneReady ? ' Re-enroll below to create a real clone instead.' : ''}
                </span>
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {isClone ? (
                <>
                  <ProfileStat label="Clone engine" value="ElevenLabs IVC" mono />
                  <ProfileStat label="Model" value={profile.providerModel === 'quality' ? 'Quality' : 'Balanced'} />
                  <ProfileStat label="Stability" value={`×${(profile.stability ?? 0.5).toFixed(2)}`} mono />
                  <ProfileStat label="Sample" value={`${profile.sampleDuration.toFixed(1)}s`} />
                </>
              ) : (
                <>
                  <ProfileStat label="Mean pitch" value={`${profile.meanF0.toFixed(0)} Hz`} />
                  <ProfileStat label="Pitch shift" value={`×${profile.pitchRatio?.toFixed(2) ?? '1.00'}`} mono />
                  <ProfileStat label="Engine voice" value={profile.mappedVoice} mono />
                  <ProfileStat label="Tempo match" value={`×${profile.speedAdjust.toFixed(2)}`} />
                </>
              )}
            </div>
            {/* Honest similarity estimate (never a fabricated percentage) */}
            {(() => {
              const sim = similarityBand(profile)
              return (
                <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                      sim.tone === 'good' ? 'bg-emerald-500/10 text-emerald-400' : sim.tone === 'fair' ? 'bg-amber-500/10 text-amber-400' : 'bg-rose-500/10 text-rose-400'
                    )}
                  >
                    Estimated similarity: {sim.band}
                  </span>
                  {sim.reason} — the provider returns no similarity score; use A/B compare to judge by ear.
                </p>
              )
            })()}
            <SampleQuality clippingRatio={profile.clippingRatio} snrDb={profile.snrDb} />
            {previewError && (
              <div className="flex items-start justify-between gap-2 rounded-xl border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
                <span className="min-w-0">{previewError}</span>
                <button type="button" onClick={() => setPreviewError(null)} aria-label="Dismiss error" className="shrink-0 font-bold text-rose-300 hover:text-rose-100">
                  ✕
                </button>
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                size="sm"
                onClick={preview === 'playing' ? stopPreview : () => void startPreview()}
                disabled={preview === 'loading' || compare !== 'idle'}
                aria-label={preview === 'playing' ? 'Stop voice preview' : 'Hear how your enrolled voice sounds'}
                className={cn(
                  'h-8 flex-1 gap-1.5 border-zinc-700 bg-zinc-900 text-xs transition-colors',
                  preview === 'playing' ? 'border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40' : 'text-zinc-300 hover:bg-zinc-800'
                )}
              >
                {preview === 'loading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" aria-hidden />
                ) : preview === 'playing' ? (
                  <Square className="h-3 w-3" aria-hidden />
                ) : (
                  <Volume2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                )}
                {preview === 'loading' ? 'Synthesizing…' : preview === 'playing' ? 'Stop preview' : 'Test my voice'}
                {preview === 'playing' && (
                  <span className="ml-0.5 flex items-end gap-[2px]" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="lt-eq-bar w-[2px] rounded-full bg-emerald-400" style={{ height: `${6 + ((i * 5) % 7)}px`, animationDelay: `${i * 140}ms` }} />
                    ))}
                  </span>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={compare === 'idle' ? () => void startCompare() : stopCompare}
                disabled={compare === 'loading' || preview !== 'idle'}
                aria-label={compare === 'idle' ? 'Compare your voice with the default voice' : 'Stop voice comparison'}
                title={`Same sentence with “${profile.name}” vs the default “${DEFAULT_ENGINE_VOICE}”`}
                className={cn(
                  'h-8 flex-1 gap-1.5 border-zinc-700 bg-zinc-900 text-xs transition-colors',
                  compare !== 'idle' ? 'border-teal-700/60 text-teal-300 hover:bg-teal-950/40' : 'text-zinc-300 hover:bg-zinc-800'
                )}
              >
                {compare === 'loading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-400" aria-hidden />
                ) : compare !== 'idle' ? (
                  <Square className="h-3 w-3" aria-hidden />
                ) : (
                  <ArrowLeftRight className="h-3.5 w-3.5 text-teal-400" aria-hidden />
                )}
                {compare === 'loading' ? 'Loading A/B…' : compare === 'a' ? `A · yours` : compare === 'b' ? 'B · default' : 'Compare A/B'}
                {(compare === 'a' || compare === 'b') && (
                  <span className="ml-0.5 flex items-end gap-[2px]" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="lt-eq-bar w-[2px] rounded-full bg-teal-400" style={{ height: `${6 + ((i * 5) % 7)}px`, animationDelay: `${i * 140}ms` }} />
                    ))}
                  </span>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={startRecording}
                disabled={previewBusy}
                className="h-8 flex-1 gap-1.5 border-zinc-700 bg-zinc-900 text-xs hover:bg-zinc-800"
              >
                <Mic className="h-3.5 w-3.5" aria-hidden /> New sample
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onDelete(profile.id)}
                disabled={previewBusy}
                aria-label="Delete this profile"
                className="h-8 gap-1.5 border-zinc-700 bg-zinc-900 px-3 text-xs text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>

            {/* Cloning advanced settings (only for cloned profiles) */}
            {isClone && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[11px] font-semibold text-zinc-300 transition-colors hover:text-emerald-300"
                >
                  <span className="flex items-center gap-1.5">
                    <Sliders className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Advanced voice settings
                    <span className="font-mono text-[10px] font-normal text-zinc-600">
                      {profile.providerModel === 'quality' ? 'quality' : 'balanced'} · st {(profile.stability ?? 0.5).toFixed(2)}
                    </span>
                  </span>
                  <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', showAdvanced && 'rotate-180')} aria-hidden />
                </button>
                {showAdvanced && (
                  <div className="grid gap-4 border-t border-zinc-800 px-3 py-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Cloning model</p>
                      <Select
                        value={profile.providerModel === 'quality' ? 'quality' : 'balanced'}
                        onValueChange={(v) => {
                          if (v === 'balanced' || v === 'quality') void onUpdateClone(profile.id, { providerModel: v })
                        }}
                      >
                        <SelectTrigger className="h-9 border-zinc-800 bg-zinc-950 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-zinc-800 bg-zinc-900">
                          <SelectItem value="balanced" className="text-xs">Balanced — lower latency (live chat)</SelectItem>
                          <SelectItem value="quality" className="text-xs">Quality — highest fidelity</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">
                        Applies to every new synthesis with this profile.
                      </p>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <span>Stability</span>
                        <span className="font-mono normal-case">{(profile.stability ?? 0.5).toFixed(2)}</span>
                      </p>
                      <Slider
                        value={[profile.stability ?? 0.5]}
                        min={0}
                        max={1}
                        step={0.05}
                        onValueCommit={([v]) => void onUpdateClone(profile.id, { stability: v })}
                        className="py-2"
                        aria-label="Cloning stability"
                      />
                      <p className="text-[10px] leading-snug text-zinc-600">
                        Lower = more expressive & emotional · higher = steadier and more consistent.
                      </p>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <span>Similarity boost</span>
                        <span className="font-mono normal-case">{(profile.providerSimilarity ?? 0.8).toFixed(2)}</span>
                      </p>
                      <Slider
                        value={[profile.providerSimilarity ?? 0.8]}
                        min={0.4}
                        max={1}
                        step={0.05}
                        onValueCommit={([v]) => void onUpdateClone(profile.id, { providerSimilarity: v })}
                        className="py-2"
                        aria-label="Similarity boost"
                      />
                      <p className="text-[10px] leading-snug text-zinc-600">
                        Higher = output stays closer to your enrolled voice.
                      </p>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <span>Style exaggeration</span>
                        <span className="font-mono normal-case">{(profile.providerStyle ?? 0).toFixed(2)}</span>
                      </p>
                      <Slider
                        value={[profile.providerStyle ?? 0]}
                        min={0}
                        max={0.45}
                        step={0.05}
                        onValueCommit={([v]) => void onUpdateClone(profile.id, { providerStyle: v })}
                        className="py-2"
                        aria-label="Style exaggeration"
                      />
                      <p className="text-[10px] leading-snug text-zinc-600">
                        Higher = follows the recorded speaking style more strongly.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : view === 'recording' ? (
          <div className="space-y-3">
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
            <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full bg-emerald-500 transition-all duration-100" style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="rounded-xl border border-dashed border-zinc-700/60 bg-zinc-900/40 p-3">
              <p dir="rtl" lang="fa" className="font-fa text-center text-sm leading-relaxed text-zinc-300">
                {READ_ALOUD_FA}
              </p>
            </div>
            <p className="text-center text-[11px] text-zinc-600">
              Read the sentence aloud in a normal voice — {elapsed.toFixed(1)}s / {MAX_SAMPLE_SEC}s
              {cloneReady ? ' · longer samples clone better' : ''}
            </p>
            <Button size="sm" onClick={() => void stopForReview()} className="h-9 w-full gap-1.5 bg-rose-600 text-xs hover:bg-rose-500">
              <CircleStop className="h-4 w-4" aria-hidden /> Stop &amp; Review
            </Button>
          </div>
        ) : view === 'review' ? (
          /* ── Review step: replay the sample BEFORE submitting (spec: record,
             replay, submit) ── */
          <div className="space-y-3" aria-live="polite">
            <p className="text-sm font-medium text-zinc-300">
              {takeCount > 0
                ? `Take ${takeCount + 1} recorded — ${takeCount + 1} takes will merge into one stronger clone`
                : 'Sample recorded — listen before creating the profile'}
            </p>
            <Waveform pcm={reviewPcmRef.current} />
            <ReviewQuality pcm={reviewPcmRef.current} />
            <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void playReview()}
                className="h-9 gap-1.5 border-zinc-700 bg-zinc-900 px-4 text-xs text-emerald-300 hover:bg-emerald-950/40"
                aria-label="Replay the recorded sample"
              >
                {reviewPlaying ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                {reviewPlaying ? 'Stop' : 'Replay sample'}
              </Button>
              <span className="flex-1 text-center text-[11px] text-zinc-500">
                {(reviewPcmRef.current?.length ?? 0) / 16000 > 0
                  ? `${((reviewPcmRef.current?.length ?? 0) / 16000).toFixed(1)}s · 16 kHz`
                  : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  cancelReview()
                  void startRecording()
                }}
                className="h-9 gap-1.5 border-zinc-700 bg-zinc-900 text-xs text-zinc-300 hover:bg-zinc-800"
                aria-label="Discard and re-record"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Re-record
              </Button>
            </div>
            <Input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Profile name (optional) — e.g. “My phone voice”"
              maxLength={60}
              className="h-9 border-zinc-800 bg-zinc-900 text-sm placeholder:text-zinc-600 focus-visible:ring-emerald-500/60"
              aria-label="Profile name"
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={cancelReview}
                className="h-9 flex-1 border-zinc-700 bg-zinc-900 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </Button>
              {cloneReady && takeCount < MAX_TAKES - 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={keepTakeAndRecordAgain}
                  className="h-9 flex-[2] gap-1.5 border-teal-800/60 bg-teal-950/30 text-xs text-teal-200 hover:bg-teal-950/50"
                  title="Keep this take and record another — multiple takes produce a stronger clone"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden /> Add take {takeCount + 2}/{MAX_TAKES}
                </Button>
              )}
              <Button size="sm" onClick={() => void submitSample()} className="h-9 flex-[2] gap-1.5 bg-emerald-600 text-xs font-semibold hover:bg-emerald-500">
                <AudioLines className="h-4 w-4" aria-hidden />
                {cloneReady ? `Create voice clone${takeCount > 0 ? ` (${takeCount + 1} takes)` : ''}` : 'Create profile'}
              </Button>
            </div>
          </div>
        ) : view === 'analyzing' ? (
          <div className="flex flex-col items-center gap-3 py-6" aria-live="polite">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-500" aria-hidden />
            <p className="text-sm font-medium text-zinc-300">
              {cloneReady ? 'Uploading to the cloning provider…' : 'Analyzing your sample…'}
            </p>
            {/* Honest stage tracker: only REAL completed steps get a ✓. The
                server call is one request — the provider returns no progress
                stream, so we show the true elapsed time instead of a fake
                percentage or invented ETA. */}
            <ol className="mt-1 grid w-full max-w-sm grid-cols-2 gap-x-4 gap-y-1">
              {stages.map((s, i) => {
                const current = i === stageIndex
                const done = i < stageIndex
                return (
                  <li
                    key={s}
                    className={cn(
                      'flex items-center gap-1.5 text-[11px]',
                      current ? 'font-semibold text-emerald-300' : done ? 'text-zinc-400' : 'text-zinc-600'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[8px] font-bold',
                        current
                          ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                          : done
                            ? 'border-emerald-700 bg-emerald-950/50 text-emerald-500'
                            : 'border-zinc-700 text-zinc-600'
                      )}
                    >
                      {done ? '✓' : i + 1}
                    </span>
                    {s}
                  </li>
                )
              })}
            </ol>
            <p className="text-[11px] text-zinc-600">
              Elapsed: {analyzeElapsed.toFixed(1)}s · the provider reports no intermediate progress,
              so no ETA is shown
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-zinc-400">
              Record a short sample so the translator speaks with{' '}
              <span className="text-zinc-200">your voice identity</span>.
              {cloneReady
                ? ' The sample is cloned at the provider — translations are spoken with YOUR voice.'
                : ' Pitch, brightness and tempo of the output are conformed to your voice.'}
            </p>
            <Input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Profile name (optional) — e.g. “My phone voice”"
              maxLength={60}
              className="h-9 border-zinc-800 bg-zinc-900 text-sm placeholder:text-zinc-600 focus-visible:ring-emerald-500/60"
              aria-label="Profile name"
            />
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
              />
              <span className="text-[11px] leading-relaxed text-zinc-400">
                <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-emerald-500" aria-hidden />
                {cloneReady ? (
                  <>
                    I confirm I am authorized to use this voice sample. To create my clone, the sample
                    is sent securely to ElevenLabs (server-side key) and stored there — together with
                    the derived voice — until I delete this profile.
                  </>
                ) : (
                  <>
                    I consent to my voice sample being analyzed to create this profile. The raw audio
                    is processed in memory only — never stored.
                  </>
                )}
              </span>
            </label>
            {cloneReady && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:text-emerald-300"
                >
                  <Sliders className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Enrollment settings
                  <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', showAdvanced && 'rotate-180')} aria-hidden />
                </button>
                {showAdvanced && (
                  <div className="grid w-full gap-3 border-t border-zinc-800 pt-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Cloning model</p>
                      <Select value={enrollModel} onValueChange={(v) => { if (v === 'balanced' || v === 'quality') setEnrollModel(v) }}>
                        <SelectTrigger className="h-9 border-zinc-800 bg-zinc-950 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-zinc-800 bg-zinc-900">
                          <SelectItem value="balanced" className="text-xs">Balanced — lower latency (live chat)</SelectItem>
                          <SelectItem value="quality" className="text-xs">Quality — highest fidelity</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <span>Stability</span>
                        <span className="font-mono normal-case">{enrollStability.toFixed(2)}</span>
                      </p>
                      <Slider
                        value={[enrollStability]}
                        min={0}
                        max={1}
                        step={0.05}
                        onValueChange={([v]) => setEnrollStability(v)}
                        className="py-2"
                        aria-label="Cloning stability"
                      />
                      <p className="text-[10px] leading-snug text-zinc-600">Lower = more expressive · higher = steadier.</p>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <span>Similarity boost</span>
                        <span className="font-mono normal-case">{enrollSimilarity.toFixed(2)}</span>
                      </p>
                      <Slider
                        value={[enrollSimilarity]}
                        min={0.4}
                        max={1}
                        step={0.05}
                        onValueChange={([v]) => setEnrollSimilarity(v)}
                        className="py-2"
                        aria-label="Similarity boost"
                      />
                      <p className="text-[10px] leading-snug text-zinc-600">Higher = closer to the enrolled voice.</p>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <span>Style exaggeration</span>
                        <span className="font-mono normal-case">{enrollStyle.toFixed(2)}</span>
                      </p>
                      <Slider
                        value={[enrollStyle]}
                        min={0}
                        max={0.45}
                        step={0.05}
                        onValueChange={([v]) => setEnrollStyle(v)}
                        className="py-2"
                        aria-label="Style exaggeration"
                      />
                      <p className="text-[10px] leading-snug text-zinc-600">Higher = follows the speaking style more strongly.</p>
                    </div>
                  </div>
                )}
              </div>
            )}
            <Button
              size="sm"
              onClick={startRecording}
              disabled={!consented}
              className="h-10 w-full gap-2 bg-emerald-600 text-xs font-semibold hover:bg-emerald-500 disabled:opacity-50"
            >
              <AudioLines className="h-4 w-4" aria-hidden /> Record My Voice ({MAX_SAMPLE_SEC}s)
            </Button>
            <p className="text-center text-[11px] leading-relaxed text-zinc-600">
              {cloneReady
                ? 'Your sample is enrolled via ElevenLabs Instant Voice Cloning (cross-language: Persian reference → English output) using a server-side key. Delete the profile anytime to remove the clone.'
                : 'Your sample is analyzed on the server (pitch, timbre, tempo) and mapped to the closest engine voice with pitch conformance — an estimated match, not a deep-fake clone. Audio is not stored.'}
            </p>
          </div>
        )}
      </section>

      {/* ── Saved profiles (multiple identities) ────────────────────────────── */}
      {profiles.length > 0 && (
        <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">
              Saved profiles
            </h2>
            <span className="font-mono text-[10px] text-zinc-500">{profiles.length} enrolled</span>
          </header>
          <ul className="flex flex-col gap-2">
            {profiles.map((p) => {
              const isActive = p.id === profile?.id
              const pClone = p.mode === 'clone'
              return (
                <li
                  key={p.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors',
                    isActive
                      ? 'border-emerald-900/60 bg-emerald-950/20'
                      : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                  )}
                >
                  {renamingId === p.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void onRename(p.id, renameValue).then(() => setRenamingId(null))
                      }}
                    >
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={60}
                        className="h-8 border-zinc-800 bg-zinc-950 text-sm focus-visible:ring-emerald-500/60"
                        aria-label="Profile name"
                      />
                      <Button type="submit" size="sm" className="h-8 bg-emerald-600 px-3 text-xs hover:bg-emerald-500">
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="outline" className="h-8 border-zinc-700 px-3 text-xs" onClick={() => setRenamingId(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className={cn('flex items-center gap-1.5 truncate text-sm font-semibold', isActive ? 'text-emerald-200' : 'text-zinc-200')}>
                          {p.name}
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider',
                              pClone ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
                            )}
                            title={pClone ? 'Real cloned voice (provider-backed)' : 'Pitch-conformed preset match'}
                          >
                            {pClone ? 'CLONE' : 'PITCH-MATCH'}
                          </span>
                          {p.isActive && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-label="Default profile" />}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-zinc-500">
                          {pClone
                            ? `ivc · ${p.providerModel === 'quality' ? 'quality' : 'balanced'} · st ${(p.stability ?? 0.5).toFixed(2)} · ${p.sampleDuration.toFixed(0)}s sample`
                            : `${p.mappedVoice} · ×${p.pitchRatio?.toFixed(2)} pitch · ×${p.speedAdjust.toFixed(2)} tempo · ${p.meanF0.toFixed(0)} Hz`}
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        {!p.isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void onSelect(p.id)}
                            className="h-7 gap-1 px-2 text-[11px] text-emerald-300 hover:bg-emerald-950/40"
                            title="Set as the default voice for translations"
                          >
                            <Play className="h-3 w-3" aria-hidden /> Use
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRenamingId(p.id)
                            setRenameValue(p.name)
                          }}
                          className="h-7 w-7 px-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                          aria-label={`Rename ${p.name}`}
                        >
                          <Pencil className="h-3 w-3" aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onDelete(p.id)}
                          className="h-7 w-7 px-0 text-zinc-500 hover:bg-rose-950/40 hover:text-rose-300"
                          aria-label={`Delete ${p.name}`}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </Button>
                      </span>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

/** Sample-quality feedback with honest warnings. */
function SampleQuality({ clippingRatio, snrDb }: { clippingRatio: number; snrDb: number }) {
  const clipping = clippingRatio > 0.005
  const noisy = snrDb > 0 && snrDb < 12
  if (!clipping && !noisy) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <BadgeCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
        Sample quality: clean{snrDb > 0 ? ` · ~${snrDb.toFixed(0)} dB signal-to-noise` : ''}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {clipping && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-300">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Some clipping detected ({(clippingRatio * 100).toFixed(1)}% of samples) — speak a bit
          softer or move away from the mic next time.
        </p>
      )}
      {noisy && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-300">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Background noise is high (~{snrDb.toFixed(0)} dB SNR) — a quieter room will improve the
          match.
        </p>
      )}
    </div>
  )
}

function ProfileStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={cn('mt-0.5 truncate text-sm font-semibold text-zinc-200', mono && 'font-mono text-xs')}>{value}</p>
    </div>
  )
}

/** REAL review-time quality feedback computed from the recorded PCM itself:
 *  loudness (RMS dBFS), clipping and duration hints — measurable, honest,
 *  with actionable re-record coaching. */
function ReviewQuality({ pcm }: { pcm: Int16Array | null }) {
  if (!pcm || pcm.length === 0) return null
  let sum = 0
  let clipped = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768
    sum += v * v
    if (Math.abs(pcm[i]) >= 32700) clipped++
  }
  const rms = Math.sqrt(sum / pcm.length)
  const dbfs = 20 * Math.log10(Math.max(rms, 1e-6))
  const durationSec = pcm.length / 16000
  const clipRatio = clipped / pcm.length
  const hints: { tone: 'ok' | 'warn' | 'bad'; text: string }[] = []
  if (dbfs < -30) hints.push({ tone: 'bad', text: 'Too quiet — move closer to the microphone and speak up.' })
  else if (dbfs > -8) hints.push({ tone: 'warn', text: 'Very loud — back away slightly to avoid distortion.' })
  else hints.push({ tone: 'ok', text: 'Good recording level.' })
  if (clipRatio > 0.005) hints.push({ tone: 'bad', text: 'Clipping detected — lower your input volume and re-record.' })
  if (durationSec < 6) hints.push({ tone: 'warn', text: 'Short take — recording 10s+ produces a better profile.' })
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Sample quality (measured)</p>
      <ul className="flex flex-col gap-1">
        <li className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">Loudness</span>
          <span className="font-mono text-zinc-300">{dbfs.toFixed(1)} dBFS</span>
        </li>
        <li className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">Clipping</span>
          <span className="font-mono text-zinc-300">{(clipRatio * 100).toFixed(2)}%</span>
        </li>
        <li className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">Duration</span>
          <span className="font-mono text-zinc-300">{durationSec.toFixed(1)}s</span>
        </li>
      </ul>
      <ul className="mt-2 space-y-1">
        {hints.map((h, i) => (
          <li
            key={i}
            className={cn(
              'text-[11px] leading-snug',
              h.tone === 'ok' && 'text-emerald-400',
              h.tone === 'warn' && 'text-amber-400',
              h.tone === 'bad' && 'text-rose-400'
            )}
          >
            {h.tone === 'ok' ? '✓' : h.tone === 'warn' ? '⚠' : '✗'} {h.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
