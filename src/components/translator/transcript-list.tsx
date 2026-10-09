'use client'

import { motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, History, List, MessagesSquare, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TranscriptEntry } from '@/hooks/use-translator'
import { LANG_META } from '@/types/translator'

interface TranscriptListProps {
  entries: TranscriptEntry[]
  onClear: () => void
  onReplay: (utteranceId: string) => void
}

type TranscriptView = 'list' | 'dialogue'

const VIEW_KEY = 'lt-transcript-view'

/** Copy-to-clipboard micro-button with a transient ✓ state. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // clipboard unavailable — ignore
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-full border bg-zinc-900 transition-colors',
        copied
          ? 'border-emerald-700/60 text-emerald-400'
          : 'border-zinc-800 text-zinc-500 hover:border-emerald-700/60 hover:text-emerald-300'
      )}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
    </button>
  )
}

/** Compact clock chip (HH:MM) used in dialogue view. */
function TimeChip({ iso }: { iso: number }) {
  const time = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800/80 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
      {time}
    </span>
  )
}

export function TranscriptList({ entries, onClear, onReplay }: TranscriptListProps) {
  const [view, setView] = useState<TranscriptView>('list')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Restore the persisted view after mount (deferred macrotask — hydration-safe).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const raw = localStorage.getItem(VIEW_KEY)
        if (raw === 'dialogue' || raw === 'list') setView(raw)
      } catch {
        // unavailable — keep default
      }
    }, 0)
    return () => clearTimeout(t)
  }, [])

  const toggleView = useCallback((next: TranscriptView) => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // unavailable — session-only
    }
  }, [])

  // Dialogue mode reads bottom-up: keep the newest phrase in view as it lands.
  useEffect(() => {
    if (view !== 'dialogue' || !scrollRef.current) return
    const el = scrollRef.current
    const t = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 60)
    return () => clearTimeout(t)
  }, [entries.length, view])

  /** Chronological order for the chat-like dialogue view. */
  const chronological = view === 'dialogue' ? [...entries].reverse() : entries

  return (
    <section className="lt-card overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
      <header className="flex flex-wrap items-center justify-between gap-y-1 border-b border-zinc-800 bg-zinc-900/60 px-3 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
            <History className="h-3.5 w-3.5" aria-hidden />
          </span>
          <h2 className="min-w-0 text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">
            Session Transcript
          </h2>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            {entries.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle — console list ↔ chat dialogue */}
          <div
            role="group"
            aria-label="Transcript view"
            className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/70 p-0.5"
          >
            {(
              [
                { key: 'list', icon: List, label: 'List view' },
                { key: 'dialogue', icon: MessagesSquare, label: 'Dialogue view' },
              ] as const
            ).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleView(key)}
                aria-pressed={view === key}
                aria-label={label}
                title={label}
                className={cn(
                  'inline-flex h-6 w-7 items-center justify-center rounded-md transition-colors',
                  view === key
                    ? 'bg-emerald-500/15 text-emerald-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                    : 'text-zinc-500 hover:text-zinc-300'
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={entries.length === 0}
            aria-label="Clear session transcript"
            className="h-7 gap-1 px-2 text-xs text-zinc-500 hover:text-zinc-300"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="lt-scroll max-h-96 overflow-y-auto p-3"
      >
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-4 py-10 text-center">
            <MessagesSquare className="h-5 w-5 text-zinc-600" aria-hidden />
            <p className="lt-text-gradient text-sm font-semibold">No phrases yet</p>
            <p className="max-w-xs text-xs leading-relaxed text-zinc-600">
              Recognized phrases and their translations appear here — spoken or typed.
            </p>
          </div>
        ) : view === 'dialogue' ? (
          /* ── DIALOGUE VIEW — chat bubbles, one pair per phrase ───────────── */
          <ul className="space-y-4" aria-label="Translation dialogue">
            {chronological.map((entry, idx) => {
              const srcMeta = LANG_META[entry.sourceLang]
              const tgtMeta = LANG_META[entry.targetLang]
              return (
                <motion.li
                  key={entry.id}
                  initial={{ opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 28, delay: idx === chronological.length - 1 ? 0.04 : 0 }}
                  className="space-y-1.5"
                >
                  {/* Pair header — flags + clock */}
                  <div className="flex items-center gap-1.5 pl-1">
                    <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-zinc-500">
                      <span aria-hidden>{srcMeta?.flag ?? '·'}</span>
                      <span className="text-zinc-700">→</span>
                      <span aria-hidden>{tgtMeta?.flag ?? '·'}</span>
                    </span>
                    <TimeChip iso={entry.createdAt} />
                  </div>

                  {/* Source bubble — the speaker's side (left) */}
                  {entry.source && (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-zinc-800 bg-zinc-900 px-3.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-zinc-700">
                        <p
                          dir={srcMeta?.rtl ? 'rtl' : 'ltr'}
                          lang={entry.sourceLang}
                          className={cn(
                            'whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-400',
                            srcMeta?.rtl && 'font-fa text-right'
                          )}
                        >
                          {entry.source}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Translation bubble — the other side (right, emerald) */}
                  {entry.translated && (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-emerald-900/50 bg-emerald-950/20 px-3.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_0_20px_-10px_rgba(16,185,129,0.5)] transition-colors hover:border-emerald-800/70">
                        <p
                          dir={tgtMeta?.rtl ? 'rtl' : 'ltr'}
                          lang={entry.targetLang}
                          className={cn(
                            'whitespace-pre-wrap text-sm font-medium leading-relaxed text-zinc-100',
                            tgtMeta?.rtl && 'font-fa text-right'
                          )}
                        >
                          {entry.translated}
                        </p>
                      </div>
                    </div>
                  )}
                </motion.li>
              )
            })}
          </ul>
        ) : (
          /* ── LIST VIEW — compact console rows ──────────────────────────── */
          <ul className="space-y-2">
            {entries.map((entry) => (
              <motion.li
                key={entry.id}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
              >
                {(() => {
                  const srcRtl = entry.sourceLang === 'fa'
                  const tgtRtl = entry.targetLang === 'fa'
                  return (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        {entry.source && (
                          <p
                            dir={srcRtl ? 'rtl' : 'ltr'}
                            lang={entry.sourceLang}
                            className={cn(
                              'line-clamp-1 break-words text-sm text-zinc-500',
                              srcRtl ? 'font-fa text-right' : 'text-left'
                            )}
                          >
                            {entry.source}
                          </p>
                        )}
                        <p
                          dir={tgtRtl ? 'rtl' : 'ltr'}
                          lang={entry.targetLang}
                          className={cn(
                            'line-clamp-1 break-words text-sm font-medium text-zinc-200',
                            tgtRtl && 'font-fa text-right'
                          )}
                        >
                          {entry.translated || '—'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {entry.translated && <CopyButton text={entry.translated} label="translation" />}
                        <span
                          className="rounded-full border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-zinc-500"
                          title={`${entry.sourceLang} → ${entry.targetLang}`}
                        >
                          {entry.sourceLang}→{entry.targetLang}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            entry.timings.totalMs < 4000
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-zinc-800 text-zinc-400'
                          )}
                        >
                          {(entry.timings.totalMs / 1000).toFixed(1)}s
                        </span>
                        {entry.hasAudio && (
                          <button
                            type="button"
                            onClick={() => onReplay(entry.id)}
                            aria-label="Replay this phrase"
                            title="Replay this phrase"
                            className="group inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
                          >
                            <RotateCcw
                              className="h-3 w-3 transition-transform duration-300 group-hover:-rotate-180"
                              aria-hidden
                            />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </motion.li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
