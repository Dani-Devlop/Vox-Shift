'use client'

// ─────────────────────────────────────────────────────────────────────────────
// SpeakerChip — live speaker attribution (master prompt v2 §11/§13/§29).
// Shows the resolved name (contact / correction / "Unknown N") with the
// HONEST identification status. Unknown speakers offer "Identify Person";
// ambiguous matches offer candidate confirmation — never a silent guess.
// ─────────────────────────────────────────────────────────────────────────────

import { Mic, ShieldCheck, HelpCircle, CircleHelp, UserSearch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SpeakerInfo } from '@/types/translator'

interface SpeakerChipProps {
  info: SpeakerInfo | undefined
  /** Fallback label when no recognition info exists (e.g. manual A/B only). */
  fallback?: string
  onStartIdentify?: (clusterKey: string) => void
  onConfirmCandidate?: (clusterKey: string, contactId: string, name: string) => void
  onKeepUnknown?: (clusterKey: string) => void
  compact?: boolean
}

export function SpeakerChip({
  info,
  fallback,
  onStartIdentify,
  onConfirmCandidate,
  onKeepUnknown,
  compact,
}: SpeakerChipProps) {
  if (!info) {
    return fallback ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
        <Mic className="h-3 w-3" aria-hidden />
        {fallback}
      </span>
    ) : null
  }

  const name = info.name ?? 'Unknown'
  const pct = typeof info.confidence === 'number' ? Math.round(info.confidence * 100) : null

  // ── Ambiguous (spec §14): inline candidate confirmation ───────────────────
  if (info.status === 'possible' && info.candidates && info.candidates.length > 0) {
    return (
      <span
        className={cn(
          'inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-amber-800/50 bg-amber-950/30 px-2.5 py-1',
          compact && 'px-2'
        )}
      >
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">
          <HelpCircle className="h-3 w-3" aria-hidden />
          Needs confirmation
        </span>
        {info.candidates.slice(0, 2).map((c) => (
          <button
            key={c.contactId}
            type="button"
            onClick={() => onConfirmCandidate?.(info.clusterKey, c.contactId, c.name)}
            className="rounded-full border border-amber-700/60 bg-amber-900/30 px-2 py-0.5 text-[10px] font-semibold text-amber-200 transition-colors hover:bg-amber-900/60"
            title={`Confirm this speaker is ${c.name} (${Math.round(c.score * 100)}% voice similarity)`}
          >
            {c.name} · {Math.round(c.score * 100)}%
          </button>
        ))}
        <button
          type="button"
          onClick={() => onKeepUnknown?.(info.clusterKey)}
          className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:text-zinc-200"
          title="Keep as Unknown — do not assign a name"
        >
          Keep Unknown
        </button>
      </span>
    )
  }

  const isVerified = info.status === 'verified'
  const isUnknown = info.status === 'unknown'

  const chip = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold',
        isVerified
          ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
          : isUnknown
            ? 'border-amber-800/50 bg-amber-950/30 text-amber-300'
            : 'border-zinc-800 bg-zinc-900 text-zinc-400'
      )}
      title={
        isVerified
          ? `Recognized as ${name}${pct !== null ? ` — voice similarity ${pct}%` : ''}`
          : isUnknown
            ? 'Voice not recognized — no contact matched with enough confidence. Unknown is better than wrong.'
            : 'Attributed by conversation context (short phrase).'
      }
    >
      {isVerified ? (
        <ShieldCheck className="h-3 w-3" aria-hidden />
      ) : isUnknown ? (
        <CircleHelp className="h-3 w-3" aria-hidden />
      ) : (
        <Mic className="h-3 w-3" aria-hidden />
      )}
      {name}
      {!compact && pct !== null && isVerified && <span className="font-mono font-medium opacity-70">{pct}%</span>}
    </span>
  )

  // Unknown speakers get an inline "Identify Person" action (spec §11).
  if (isUnknown && onStartIdentify) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {chip}
        <button
          type="button"
          onClick={() => onStartIdentify(info.clusterKey)}
          className="inline-flex items-center gap-1 rounded-full border border-teal-800/60 bg-teal-950/40 px-2 py-0.5 text-[10px] font-bold text-teal-300 transition-colors hover:bg-teal-900/50"
          title="Who is this? Save them as a Voice Contact for automatic recognition."
        >
          <UserSearch className="h-3 w-3" aria-hidden />
          Identify
        </button>
      </span>
    )
  }

  return chip
}
