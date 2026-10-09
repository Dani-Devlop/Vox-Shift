'use client'

import { motion } from 'framer-motion'
import { Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TranslatorStatus } from '@/hooks/use-translator'

const STATUS_META: Record<
  TranslatorStatus,
  { label: string; dot: string; text: string; pulse?: boolean; glow?: string }
> = {
  idle: { label: 'Ready', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  starting: {
    label: 'Starting…',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    pulse: true,
    glow: '0 0 10px 1px rgba(251,191,36,0.55)',
  },
  listening: {
    label: 'Listening',
    dot: 'bg-emerald-500',
    text: 'text-emerald-300',
    glow: '0 0 10px 1px rgba(16,185,129,0.55)',
  },
  'user-speaking': {
    label: 'Hearing you',
    dot: 'bg-emerald-400',
    text: 'text-emerald-200',
    pulse: true,
    glow: '0 0 10px 1px rgba(52,211,153,0.6)',
  },
  processing: {
    label: 'Translating',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    pulse: true,
    glow: '0 0 10px 1px rgba(251,191,36,0.55)',
  },
  speaking: {
    label: 'Speaking EN',
    dot: 'bg-lime-400',
    text: 'text-lime-300',
    glow: '0 0 10px 1px rgba(163,230,53,0.6)',
  },
  reconnecting: {
    label: 'Reconnecting…',
    dot: 'bg-rose-500',
    text: 'text-rose-300',
    pulse: true,
    glow: '0 0 10px 1px rgba(244,63,94,0.55)',
  },
}

interface StatusPillProps {
  status: TranslatorStatus
  connected: boolean
}

export function StatusPill({ status, connected }: StatusPillProps) {
  const meta = STATUS_META[status]

  return (
    <div className="flex items-center gap-2">
      {/* Engine connection */}
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
          connected
            ? 'border-zinc-800 bg-zinc-900/80 text-zinc-400'
            : 'border-rose-900/60 bg-rose-950/30 text-rose-400'
        )}
        title={connected ? 'Realtime engine connected' : 'Realtime engine offline'}
      >
        {connected ? (
          <Wifi className="h-3 w-3 text-emerald-500" aria-hidden />
        ) : (
          <WifiOff className="h-3 w-3 animate-pulse text-rose-400" aria-hidden />
        )}
        <span className="hidden sm:inline">Engine</span>
      </span>

      {/* Session status */}
      <span
        className={cn(
          'inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-xs font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
          meta.text
        )}
        role="status"
        aria-live="polite"
      >
        <span className="relative flex h-2 w-2">
          {meta.pulse && (
            <span className={cn('lt-ping absolute inline-flex h-full w-full rounded-full opacity-70', meta.dot)} />
          )}
          <span
            className={cn('relative inline-flex h-2 w-2 rounded-full', meta.dot)}
            style={meta.glow ? { boxShadow: meta.glow } : undefined}
          />
        </span>
        <motion.span
          key={meta.label}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          {meta.label}
        </motion.span>
      </span>
    </div>
  )
}
