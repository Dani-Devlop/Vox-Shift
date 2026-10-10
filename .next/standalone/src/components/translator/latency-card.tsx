'use client'

import { motion } from 'framer-motion'
import { ArrowDownRight, ArrowUpRight, Gauge, Timer } from 'lucide-react'
import type { LatencyStats } from '@/hooks/use-translator'
import { cn } from '@/lib/utils'

interface LatencyCardProps {
  stats: LatencyStats
  /** Total captured speech time this session (ms) — recap row. */
  speechMs?: number
  /** Language pairs used this session (e.g. ['fa→en']) — recap chips. */
  langsUsed?: string[]
}

interface Bar {
  label: string
  ms: number
  color: string
  dot: string
}

export function LatencyCard({ stats, speechMs = 0, langsUsed = [] }: LatencyCardProps) {
  const bars: Bar[] = [
    { label: 'ASR', ms: stats.avgAsrMs, color: 'bg-teal-500', dot: 'bg-teal-500' },
    { label: 'Translate', ms: stats.avgTranslateMs, color: 'bg-emerald-500', dot: 'bg-emerald-500' },
    { label: 'Voice', ms: stats.avgTtsMs, color: 'bg-lime-500', dot: 'bg-lime-500' },
  ]
  const maxMs = Math.max(500, ...bars.map((b) => b.ms))
  const stageSum = bars.reduce((acc, b) => acc + b.ms, 0)
  // Segments of the stacked bar — proportions of the measured total
  // (guard zero so the bar renders as an empty track before data exists).
  const segments = stageSum > 0 ? bars.map((b) => ({ ...b, pct: (b.ms / stageSum) * 100 })) : []

  return (
    <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
            <Gauge className="h-3.5 w-3.5" aria-hidden />
          </span>
          <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Latency</h2>
        </div>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
          {stats.count} phrase{stats.count === 1 ? '' : 's'}
        </span>
      </header>

      {stats.count === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center">
          <Gauge className="h-5 w-5 text-zinc-600" aria-hidden />
          <p className="max-w-[220px] text-xs leading-relaxed text-zinc-600">
            Stage-by-stage latency appears after the first spoken phrase.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Stacked pipeline proportion bar — how the ~2s budget splits */}
          <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-zinc-800">
            {segments.map((seg, i) => (
              <motion.div
                key={seg.label}
                className={cn('h-full', seg.color, i > 0 && 'border-l border-zinc-950/60')}
                initial={{ width: 0 }}
                animate={{ width: `${seg.pct}%` }}
                transition={{ duration: 0.6, ease: 'easeOut', delay: 0.05 * i }}
                style={{ opacity: 0.9 }}
              />
            ))}
          </div>
          {bars.map((bar) => {
            const pct = stageSum > 0 ? Math.round((bar.ms / stageSum) * 100) : 0
            return (
              <div key={bar.label}>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5 text-zinc-400">
                    <span className={cn('h-1.5 w-1.5 rounded-full', bar.dot)} aria-hidden />
                    {bar.label}
                  </span>
                  <span className="font-mono text-zinc-500">
                    {bar.ms} ms <span className="text-zinc-600">· {pct}%</span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full rounded-full ${bar.color} opacity-90 transition-all duration-500`}
                    style={{ width: `${Math.max(3, (bar.ms / maxMs) * 100)}%` }}
                  />
                </div>
              </div>
            )
          })}
          <div className="mt-2 flex items-center justify-between border-t border-zinc-800 pt-3">
            <span className="text-xs font-semibold text-zinc-300">End-to-end avg</span>
            <span className="font-mono text-sm font-bold text-emerald-400">
              {(stats.avgTotalMs / 1000).toFixed(2)}s
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-600">Last</p>
              <p className="font-mono text-[11px] font-semibold text-zinc-300">
                {(stats.lastTotalMs / 1000).toFixed(2)}s
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <p className="flex items-center justify-center gap-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-600">
                <ArrowDownRight className="h-2.5 w-2.5 text-emerald-500" aria-hidden /> Best
              </p>
              <p className="font-mono text-[11px] font-semibold text-emerald-400">
                {(stats.minTotalMs / 1000).toFixed(2)}s
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <p className="flex items-center justify-center gap-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-600">
                <ArrowUpRight className="h-2.5 w-2.5 text-amber-500" aria-hidden /> Peak
              </p>
              <p className="font-mono text-[11px] font-semibold text-amber-400">
                {(stats.maxTotalMs / 1000).toFixed(2)}s
              </p>
            </div>
          </div>

          {/* Session recap — how much you actually talked and in which directions */}
          {(speechMs > 0 || langsUsed.length > 0) && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600">
                <Timer className="h-3 w-3 text-teal-400" aria-hidden /> This session
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                <span className="font-mono">
                  <span className="font-bold text-zinc-200">{stats.count}</span> phrase{stats.count === 1 ? '' : 's'}
                </span>
                {speechMs > 0 && (
                  <span className="font-mono">
                    <span className="font-bold text-teal-300">{(speechMs / 1000).toFixed(1)}s</span> spoken
                  </span>
                )}
                {langsUsed.map((pair) => (
                  <span
                    key={pair}
                    className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-zinc-400"
                  >
                    {pair}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
