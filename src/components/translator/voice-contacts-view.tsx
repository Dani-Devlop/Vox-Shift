'use client'

// ─────────────────────────────────────────────────────────────────────────────
// VoiceContactsView — persistent speaker recognition management (master prompt
// v2 §10). Contacts are people the LOCAL recognizer can name automatically:
//   · view / add / rename / delete (with explicit confirms)
//   · play the reference recording · see enrollment quality
//   · re-enroll with a fresh sample (merge or replace)
//   · temporarily disable recognition · see recognition stats
// Recognition itself is disclosed honestly: local DSP voiceprints (pitch +
// timbre), not a cloud embedding service.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Mic,
  Pencil,
  Play,
  Square,
  Trash2,
  UserPlus,
  UserRoundCheck,
  UserRoundX,
  Volume2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { MicRecorder, pcmFromBase64, pcmToBase64 } from '@/lib/audio/mic-recorder'
import type { VoiceContactData } from '@/types/translator'
import { LANG_META } from '@/types/translator'
import { cn } from '@/lib/utils'

const TARGET_SAMPLE_SEC = 10
const MAX_SAMPLE_SEC = 20

interface VoiceContactsViewProps {
  contacts: VoiceContactData[]
  loading: boolean
  onLoad: () => void
  onCreate: (input: {
    name: string
    audioBase64: string
    sampleRate: number
    consented: boolean
    language?: string
  }) => Promise<VoiceContactData | null>
  onUpdate: (id: string, patch: { name?: string; disabled?: boolean }) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
  onReenroll: (
    id: string,
    audioBase64: string,
    sampleRate: number,
    consented: boolean,
    merge?: boolean
  ) => Promise<{ ok: true; quality: { snrDb: number; speechSec: number; meanF0: number } } | null>
}

type RecorderPhase = 'idle' | 'recording' | 'review'

export function VoiceContactsView({
  contacts,
  loading,
  onLoad,
  onCreate,
  onUpdate,
  onDelete,
  onReenroll,
}: VoiceContactsViewProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [phase, setPhase] = useState<RecorderPhase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('fa')
  const [saving, setSaving] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [reenrollId, setReenrollId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Seconds captured — kept in STATE (refs must not be read during render). */
  const [capturedSec, setCapturedSec] = useState(0)

  const recorderRef = useRef<MicRecorder | null>(null)
  const chunksRef = useRef<Int16Array[]>([])
  const timerRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      audioRef.current?.pause()
      const rec = recorderRef.current
      recorderRef.current = null
      if (rec) void rec.stop()
    }
  }, [])

  // ── Recording (reuses the live pipeline's mic capture) ─────────────────────
  const stopForReview = useCallback(async () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (recorder) await recorder.stop()
    const total = chunksRef.current.reduce((acc, c) => acc + c.length, 0)
    const seconds = total / 16000
    if (seconds < 1.5) {
      setPhase('idle')
      setNotice('The sample is too short — record at least a few seconds of natural speech.')
      return
    }
    setCapturedSec(seconds)
    setPhase('review')
  }, [])

  const startRecording = useCallback(async () => {
    if (recorderRef.current) return
    chunksRef.current = []
    setElapsed(0)
    setLevel(0)
    const recorder = new MicRecorder({
      silenceMs: 999999, // continuous capture — one sample, no VAD splits
      speechStartMs: 60,
      maxUtteranceSec: MAX_SAMPLE_SEC,
      minUtteranceSec: 0.2,
      onUtterance: (base64) => {
        chunksRef.current.push(pcmFromBase64(base64))
      },
      onLevel: setLevel,
      onError: () => {
        setPhase('idle')
        setNotice('Microphone error — check browser permissions and try again.')
      },
    })
    try {
      await recorder.start()
      recorderRef.current = recorder
      setPhase('recording')
      timerRef.current = window.setInterval(() => {
        setElapsed((v) => {
          const next = v + 0.1
          if (next >= TARGET_SAMPLE_SEC) void stopForReview()
          return next
        })
      }, 100)
    } catch {
      setPhase('idle')
      setNotice('Could not access the microphone. Allow mic access and try again.')
    }
  }, [])


  const capturedBase64 = useCallback(() => {
    const chunks = chunksRef.current
    const total = chunks.reduce((acc, c) => acc + c.length, 0)
    if (total === 0) return null
    const merged = new Int16Array(total)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.length
    }
    return pcmToBase64(merged)
  }, [])

  const playRecording = useCallback(() => {
    const b64 = capturedBase64()
    if (!b64) return
    audioRef.current?.pause()
    const audio = new Audio(`data:audio/wav;base64,${pcmBytesToWavBase64(b64)}`)
    audioRef.current = audio
    void audio.play().catch(() => {})
  }, [capturedBase64])

  const submitSample = useCallback(async () => {
    const b64 = capturedBase64()
    if (!b64) return
    if (reenrollId) {
      setSaving(true)
      const res = await onReenroll(reenrollId, b64, 16000, true, true)
      setSaving(false)
      if (res) {
        setNotice(
          `Voice profile updated (merged 2 samples) · measured quality: ${res.quality.speechSec.toFixed(1)}s speech, SNR ${res.quality.snrDb.toFixed(0)} dB`
        )
        setReenrollId(null)
        setPhase('idle')
        setAddOpen(false)
      }
      return
    }
    const clean = name.trim()
    if (!clean) return
    setSaving(true)
    const created = await onCreate({ name: clean, audioBase64: b64, sampleRate: 16000, consented: true, language })
    setSaving(false)
    if (created) {
      setNotice(`“${created.name}” is now recognized automatically (${created.sampleDuration.toFixed(1)}s enrolled).`)
      setAddOpen(false)
      setPhase('idle')
      setName('')
    }
  }, [capturedBase64, language, name, onCreate, onReenroll, reenrollId])

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-black tracking-tight text-zinc-100">Voice Contacts</h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
              People VoxShift recognizes automatically by voice. When someone unknown speaks, they get a stable
              label (Unknown 1, Unknown 2…) — <span className="text-zinc-400">unknown is better than wrong</span>.
              Identify them once and every future session greets them by name.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => {
              setAddOpen(true)
              setReenrollId(null)
              setPhase('idle')
              setName('')
            }}
            className="h-9 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            Add contact
          </Button>
        </div>
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
          <span className="font-semibold text-zinc-400">How recognition works:</span> a local voiceprint (pitch
          register + spectral timbre, computed on this machine) is compared by cosine similarity. It reliably tells
          different people apart; near-identical voices or heavy noise stay honestly Unknown. Nothing is uploaded to
          a third-party recognition service.
        </p>
        {notice && (
          <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-emerald-200">{notice}</p>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-emerald-500 hover:text-emerald-300">
              ×
            </button>
          </div>
        )}
      </section>

      {/* Add / re-enroll recorder */}
      {addOpen && (
        <section className="lt-card rounded-2xl border border-teal-900/50 bg-zinc-900/40 p-5 sm:p-6">
          <h2 className="text-sm font-bold text-zinc-100">
            {reenrollId ? 'Re-enroll voice' : 'New voice contact'}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Record about {TARGET_SAMPLE_SEC} seconds of the person speaking naturally. {reenrollId ? 'The new sample is MERGED with the existing profile.' : ''}
          </p>

          {phase === 'idle' && (
            <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-end">
              {!reenrollId && (
                <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-zinc-400">Name</span>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hasani" maxLength={80} />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-zinc-400">Language</span>
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                      {Object.entries(LANG_META).map(([code, meta]) => (
                        <option key={code} value={code}>
                          {meta.flag} {meta.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <Button
                type="button"
                onClick={() => void startRecording()}
                disabled={!reenrollId && !name.trim()}
                className="h-10 gap-2 bg-emerald-600 text-white hover:bg-emerald-500"
              >
                <Mic className="h-4 w-4" aria-hidden />
                Start recording
              </Button>
            </div>
          )}

          {phase === 'recording' && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-2 font-mono text-sm text-red-400">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
                  REC {elapsed.toFixed(1)}s / {TARGET_SAMPLE_SEC}s
                </span>
                <Button type="button" variant="secondary" onClick={() => void stopForReview()} className="h-9 gap-1.5">
                  <Square className="h-3.5 w-3.5" aria-hidden />
                  Stop
                </Button>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-800" aria-hidden>
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-[width] duration-100"
                  style={{ width: `${Math.min(100, (elapsed / TARGET_SAMPLE_SEC) * 100)}%` }}
                />
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/60" aria-hidden>
                <div
                  className="h-full rounded-full bg-teal-400 transition-[width] duration-75"
                  style={{ width: `${Math.min(100, level * 220)}%` }}
                />
              </div>
            </div>
          )}

          {phase === 'review' && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-zinc-400">
                Sample captured: <span className="font-mono text-zinc-200">{capturedSec.toFixed(1)}s</span> —
                listen to verify it is the right person before saving.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" onClick={playRecording} className="h-9 gap-1.5">
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  Play sample
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPhase('idle')
                    setElapsed(0)
                  }}
                  className="h-9"
                >
                  Re-record
                </Button>
                <Button
                  type="button"
                  onClick={() => void submitSample()}
                  disabled={saving}
                  className="h-9 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
                >
                  <Check className="h-4 w-4" aria-hidden />
                  {saving ? 'Saving…' : reenrollId ? 'Update voice profile' : 'Save contact'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setAddOpen(false)
                    setReenrollId(null)
                    setPhase('idle')
                  }}
                  className="h-9"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Contact list */}
      <section className="lt-card overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
        <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 sm:px-5">
          <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Saved contacts</h2>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            {contacts.length}
          </span>
        </header>
        <div className="lt-scroll max-h-[32rem] overflow-y-auto p-3 sm:p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" aria-hidden />
              Loading contacts…
            </div>
          ) : contacts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-4 py-10 text-center">
              <UserRoundCheck className="h-5 w-5 text-zinc-600" aria-hidden />
              <p className="text-sm font-semibold text-zinc-300">No contacts yet</p>
              <p className="max-w-sm text-xs leading-relaxed text-zinc-600">
                During a live conversation, unknown speakers appear as “Unknown 1 / Unknown 2” with an{' '}
                <span className="text-teal-400">Identify</span> button — or enroll someone here up front.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {contacts.map((c) => (
                <li key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 sm:p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      {renamingId === c.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && renameValue.trim()) {
                                if (await onUpdate(c.id, { name: renameValue.trim() })) setRenamingId(null)
                              }
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                            className="h-8 w-44"
                            maxLength={80}
                            autoFocus
                          />
                          <Button
                            size="sm"
                            className="h-8 px-2"
                            onClick={async () => {
                              if (await onUpdate(c.id, { name: renameValue.trim() })) setRenamingId(null)
                            }}
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </div>
                      ) : (
                        <p className="flex items-center gap-2 text-sm font-bold text-zinc-100">
                          <Mic className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                          {c.name}
                          {c.language && <span className="text-[10px] font-medium text-zinc-500">{LANG_META[c.language]?.flag ?? ''} {LANG_META[c.language]?.name ?? c.language}</span>}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                        <span className={cn('font-semibold', c.disabled ? 'text-amber-400' : 'text-emerald-400')}>
                          {c.disabled ? 'Recognition paused' : 'Voice profile: Active'}
                        </span>
                        <span className="font-mono">
                          sample {c.sampleDuration.toFixed(1)}s{c.quality?.snrDb !== undefined ? ` · SNR ${c.quality.snrDb.toFixed(0)} dB` : ''}
                          {c.quality?.meanF0 ? ` · ${c.quality.meanF0.toFixed(0)} Hz` : ''}
                        </span>
                        <span title="Measured recognition statistics — real numbers, never invented">
                          {c.matchCount > 0
                            ? `recognized ${c.matchCount}× · last ${Math.round((c.lastMatchConfidence ?? 0) * 100)}%`
                            : 'not matched yet'}
                        </span>
                        <span className="font-mono text-zinc-600">match ≥ {Math.round(c.confidenceThreshold * 100)}%</span>
                        <span title={`Created ${new Date(c.createdAt).toLocaleString()} · Updated ${new Date(c.updatedAt).toLocaleString()}`}>
                          added {new Date(c.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {c.hasReferenceAudio && (
                        <button
                          type="button"
                          onClick={() => {
                            audioRef.current?.pause()
                            const audio = new Audio(`/api/voice-contacts/${c.id}/audio`)
                            audioRef.current = audio
                            void audio.play().catch(() => {})
                          }}
                          aria-label={`Play ${c.name}'s reference sample`}
                          title="Play reference recording"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
                        >
                          <Volume2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1 px-2 text-xs text-zinc-400"
                        onClick={() => {
                          setRenamingId(c.id)
                          setRenameValue(c.name)
                        }}
                      >
                        <Pencil className="h-3 w-3" aria-hidden />
                        <span className="hidden sm:inline">Rename</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1 px-2 text-xs text-zinc-400"
                        disabled={busyId === c.id}
                        onClick={() => {
                          setAddOpen(true)
                          setReenrollId(c.id)
                          setPhase('idle')
                        }}
                      >
                        <UserPlus className="h-3 w-3" aria-hidden />
                        <span className="hidden sm:inline">Re-enroll</span>
                      </Button>
                      <div className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1">
                        <span className="text-[10px] font-medium text-zinc-500">Recognize</span>
                        <Switch
                          checked={!c.disabled}
                          onCheckedChange={(v) => void onUpdate(c.id, { disabled: !v })}
                          aria-label={`Toggle recognition for ${c.name}`}
                        />
                      </div>
                      {deletingId === c.id ? (
                        <span className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-8"
                            disabled={busyId === c.id}
                            onClick={async () => {
                              setBusyId(c.id)
                              await onDelete(c.id)
                              setBusyId(null)
                              setDeletingId(null)
                            }}
                          >
                            Confirm delete
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8" onClick={() => setDeletingId(null)}>
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1 px-2 text-xs text-red-400 hover:text-red-300"
                          onClick={() => setDeletingId(c.id)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                          <span className="hidden sm:inline">Delete</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {contacts.some((c) => c.disabled) && (
        <p className="flex items-center gap-2 px-1 text-[11px] text-amber-400/80">
          <UserRoundX className="h-3.5 w-3.5" aria-hidden />
          Paused contacts keep their sample but are skipped by the recognizer until re-enabled.
        </p>
      )}
    </div>
  )
}

/** Wrap client-recorded PCM base64 into a WAV base64 (for <audio> preview). */
function pcmBytesToWavBase64(pcmBase64: string): string {
  const bin = atob(pcmBase64)
  const pcm = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  let binary = ''
  const CH = 0x8000
  for (let i = 0; i < out.length; i += CH) {
    binary += String.fromCharCode(...out.subarray(i, i + CH))
  }
  return btoa(binary)
}
