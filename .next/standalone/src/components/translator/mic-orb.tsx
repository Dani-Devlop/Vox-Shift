'use client'

import { Mic, Square } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { TranslatorStatus } from '@/hooks/use-translator'

interface MicOrbProps {
  status: TranslatorStatus
  level: number
  onStart: () => void
  onStop: () => void
  disabled?: boolean
}

const ACTIVE_STATUSES: TranslatorStatus[] = ['listening', 'user-speaking', 'processing', 'speaking', 'reconnecting']

export function MicOrb({ status, level, onStart, onStop, disabled }: MicOrbProps) {
  const active = ACTIVE_STATUSES.includes(status)
  const speakingOut = status === 'speaking'
  const isDisabled = disabled || status === 'starting'
  const idle = !active && !isDisabled
  const scale = 1 + (active ? level * 0.12 : 0)

  return (
    <div className="relative flex flex-col items-center gap-4">
      {/* Orb cluster: halo + rings + button */}
      <div className="relative flex items-center justify-center">
        {/* Idle breathing halo */}
        {idle && (
          <span
            aria-hidden
            className="lt-breath pointer-events-none absolute inset-0 rounded-full bg-emerald-500/15 blur-2xl"
          />
        )}

        {/* Pulse rings while live */}
        {active && (
          <>
            <span
              aria-hidden
              className={cn(
                'lt-ping pointer-events-none absolute inset-0 rounded-full border',
                speakingOut ? 'border-lime-400/40' : 'border-emerald-500/40'
              )}
            />
            <span
              aria-hidden
              className={cn(
                'lt-ping pointer-events-none absolute inset-0 rounded-full border',
                speakingOut ? 'border-lime-400/25' : 'border-emerald-500/25'
              )}
              style={{ animationDelay: '0.6s' }}
            />
          </>
        )}

        {/* Hover/tap wrapper — keeps the level-driven inner scale untouched */}
        <motion.div
          whileHover={isDisabled ? undefined : { scale: 1.04 }}
          whileTap={isDisabled ? undefined : { scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 320, damping: 20 }}
          className="rounded-full"
        >
          <button
            type="button"
            onClick={active ? onStop : onStart}
            disabled={isDisabled}
            aria-label={active ? 'Stop live translation' : 'Start live translation'}
            className={cn(
              'group relative flex h-36 w-36 items-center justify-center rounded-full outline-none transition-all duration-300 sm:h-40 sm:w-40',
              'focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-4 focus-visible:ring-offset-zinc-950',
              speakingOut
                ? 'bg-gradient-to-br from-lime-300 via-lime-400 to-emerald-500 shadow-[0_0_70px_-8px_rgba(163,230,53,0.6)]'
                : active
                  ? 'bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_60px_-10px_rgba(16,185,129,0.7)]'
                  : 'bg-gradient-to-br from-zinc-800 to-zinc-900 shadow-[0_0_40px_-18px_rgba(255,255,255,0.4)]',
              idle && 'hover:from-zinc-700 hover:to-zinc-800',
              isDisabled && 'cursor-not-allowed opacity-45 saturate-50'
            )}
            style={{ transform: `scale(${scale.toFixed(3)})` }}
          >
            {/* Inner rings + top sheen */}
            <span aria-hidden className="pointer-events-none absolute inset-[7px] rounded-full border border-white/10" />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-[13px] rounded-full border border-dashed"
              style={{ borderColor: active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)' }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-3 top-1 h-7 rounded-[50%] bg-white/10 blur-md"
            />

            {/* Rotating conic ring while active */}
            {active && (
              <span
                className="pointer-events-none absolute -inset-2 rounded-full opacity-70"
                style={{
                  background: speakingOut
                    ? 'conic-gradient(from 0deg, transparent 0 70deg, rgba(163,230,53,0.6) 90deg, transparent 130deg 360deg)'
                    : 'conic-gradient(from 0deg, transparent 0 70deg, rgba(16,185,129,0.55) 90deg, transparent 130deg 360deg)',
                  mask: 'radial-gradient(farthest-side, transparent calc(100% - 4px), black calc(100% - 3px))',
                  WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 4px), black calc(100% - 3px))',
                  animation: 'spin 2.6s linear infinite',
                }}
              />
            )}
            {active ? (
              <Square className="relative h-10 w-10 text-zinc-950" fill="currentColor" aria-hidden />
            ) : (
              <Mic
                className="relative h-12 w-12 text-emerald-400 drop-shadow-[0_0_14px_rgba(16,185,129,0.45)] transition-colors group-hover:text-emerald-300"
                aria-hidden
              />
            )}
          </button>
        </motion.div>
      </div>

      <div className="text-center">
        <p
          className={cn(
            'text-sm font-bold uppercase tracking-[0.22em]',
            speakingOut ? 'text-lime-300' : active ? 'text-emerald-400' : 'text-zinc-300'
          )}
        >
          {status === 'starting' ? 'Starting…' : active ? 'Stop' : 'Start'}
        </p>
        <p className="mt-1.5 text-xs text-zinc-500">
          {active ? 'Tap to end the live session' : 'Tap and speak in Persian'}
        </p>
      </div>
    </div>
  )
}
