'use client'

// ─────────────────────────────────────────────────────────────────────────────
// IdentifySpeakerDialog — unknown-speaker enrollment (master prompt v2 §6/§7).
// Plays the ~10 s voice sample captured automatically from live speech, lets
// the user verify it belongs to the intended person, then name + save the
// Voice Contact. Consent is explicit; the sample stays on this machine.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, Square, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LANG_META } from '@/types/translator'

interface IdentifySpeakerDialogProps {
  open: boolean
  clusterKey: string
  phase: 'loading' | 'ready' | 'saving'
  sample?: { wavBase64: string; sampleRate: number; durationSec: number; speechSec: number }
  error?: string
  onConfirm: (name: string, language?: string) => Promise<boolean>
  onCancel: () => void
}

export function IdentifySpeakerDialog({
  open,
  clusterKey,
  phase,
  sample,
  error,
  onConfirm,
  onCancel,
}: IdentifySpeakerDialogProps) {
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('fa')
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // NOTE: local state resets naturally because the parent keys this dialog by
  // clusterKey + open state (fresh mount per identification) — no setState
  // inside effects needed.

  useEffect(() => {
    if (open && phase === 'ready') {
      const t = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(t)
    }
  }, [open, phase])

  if (!open) return null

  const playSample = () => {
    if (!sample) return
    try {
      const bin = atob(sample.wavBase64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/wav' })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        setPlaying(false)
        URL.revokeObjectURL(url)
      }
      setPlaying(true)
      void audio.play()
    } catch {
      setPlaying(false)
    }
  }

  const stopSample = () => {
    audioRef.current?.pause()
    setPlaying(false)
  }

  const submit = async () => {
    const clean = name.trim()
    if (!clean || !sample) return
    await onConfirm(clean, language)
  }

  const enough = (sample?.speechSec ?? 0) >= 8

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Identify unknown speaker"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget && phase !== 'saving') onCancel()
      }}
    >
      <div className="lt-card w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-100">
              <UserPlus className="h-4 w-4 text-teal-400" aria-hidden />
              Identify {clusterKey.replace('spk_', 'Unknown ').replace(/^Unknown 0+/, 'Unknown ')}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              This voice did not match any saved contact. Listen to the automatically captured sample, verify it is
              the right person, then give them a name — they will be recognized automatically from now on.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-full border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-500 transition-colors hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {/* Voice sample playback (spec §7) */}
        <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Voice sample</span>
            {phase === 'loading' ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Collecting…
              </span>
            ) : sample ? (
              <span className="font-mono text-[11px] text-zinc-500">
                {sample.speechSec.toFixed(1)}s speech · {sample.durationSec.toFixed(1)}s total
              </span>
            ) : null}
          </div>
          {phase !== 'loading' && sample && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={playing ? 'secondary' : 'default'}
                onClick={playing ? stopSample : playSample}
                className="h-8 gap-1.5"
              >
                {playing ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                {playing ? 'Stop' : 'Play voice sample'}
              </Button>
              <span
                className={`text-[11px] ${enough ? 'text-emerald-400' : 'text-amber-400'}`}
                title="Recognition quality improves with more speech"
              >
                {enough ? 'Good sample' : 'Short sample — still usable'}
              </span>
            </div>
          )}
          {error && (
            <p className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              {error}
            </p>
          )}
        </div>

        {/* Name + language */}
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-zinc-400">Who is this person?</span>
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && sample && phase === 'ready') void submit()
              }}
              placeholder="e.g. Hasani"
              maxLength={80}
              disabled={phase !== 'ready' || !sample}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-zinc-400">Their language (optional)</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={phase !== 'ready'}
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

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={phase === 'saving'} className="h-9">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!name.trim() || !sample || phase !== 'ready'}
            className="h-9 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {phase === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}
            Save as Contact
          </Button>
        </div>

        <p className="mt-3 text-center text-[10px] leading-relaxed text-zinc-600">
          The voiceprint is computed locally on this machine. The sample is stored only for this contact and can be
          deleted at any time from Voice Contacts.
        </p>
      </div>
    </div>
  )
}
