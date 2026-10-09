'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Braces, ChevronDown, Clock3, Copy, Check, Download, History, Loader2, RotateCcw, Search, Share2, SlidersHorizontal, Star, Trash2, Volume2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HistoryEntryData } from '@/types/translator'
import { LANG_META } from '@/types/translator'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────────────────
// HistoryCard — persisted translations (SQLite) with disk-cached TTS audio.
// Entries with `hasAudio` stay replayable across page reloads via
// GET /api/history/{id}/audio (rolling cache of the 40 newest phrases).
// Export: copy-all (readable text) or download as .json.
// ─────────────────────────────────────────────────────────────────────────────

interface HistoryCardProps {
  history: HistoryEntryData[] | null
  loading: boolean
  onLoad: () => Promise<void>
  onClear: () => Promise<void>
  /** Output playback speed (0.75–1.5) applied to history replays too. */
  playbackRate?: number
  /** Server cursor of the oldest loaded entry (null = everything loaded). */
  cursor?: string | null
  /** Load the next older page of history. */
  onLoadMore?: () => Promise<void>
  /** Share a saved phrase (Web Share API, clipboard fallback). */
  onShare?: (entry: HistoryEntryData) => void
  /** Star / unstar a saved phrase (phrasebook). */
  onToggleStar?: (entryId: string) => void
  /** Delete ONE saved entry (text + audio). */
  onDelete?: (entryId: string) => void
  /** Re-run a saved source phrase through the pipeline with current settings. */
  onReuse?: (entry: HistoryEntryData) => void
}

/** Collapsible with lazy first load; stays in sync as new results autosave. */
export function HistoryCard({ history, loading, onLoad, onClear, playbackRate = 1, cursor = null, onLoadMore, onShare, onToggleStar, onDelete, onReuse }: HistoryCardProps) {
  const [open, setOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [copiedAll, setCopiedAll] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  /** Client-side search over source + translated text. */
  const [query, setQuery] = useState('')
  /** Language filter: 'all' or a language code present in history. */
  const [langFilter, setLangFilter] = useState('all')
  /** Phrasebook mode — only starred entries. */
  const [starredOnly, setStarredOnly] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rateRef = useRef(playbackRate)

  // Keep the rate ref in sync (refs must be written outside render).
  useEffect(() => {
    rateRef.current = playbackRate
  }, [playbackRate])

  // Stop any history playback when the card collapses (deferred macrotask —
  // avoids the synchronous setState-in-effect lint trap used repo-wide).
  useEffect(() => {
    if (open) return
    const t = setTimeout(() => {
      audioRef.current?.pause()
      setPlayingId(null)
    }, 0)
    return () => clearTimeout(t)
  }, [open])
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  // Lazy-load on first expand
  useEffect(() => {
    if (open && history === null && !loading) {
      void onLoad()
    }
  }, [open, history, loading, onLoad])

  const toggle = useCallback(() => setOpen((v) => !v), [])

  const handleClear = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      window.setTimeout(() => setConfirmClear(false), 2500)
      return
    }
    setConfirmClear(false)
    await onClear()
  }, [confirmClear, onClear])

  /** Replay a saved phrase from the server-side audio cache. */
  const replayEntry = useCallback((entryId: string) => {
    if (playingId === entryId) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    audioRef.current?.pause()
    const a = new Audio(`/api/history/${entryId}/audio`)
    a.playbackRate = rateRef.current
    a.onended = () => setPlayingId((cur) => (cur === entryId ? null : cur))
    a.onerror = () => setPlayingId((cur) => (cur === entryId ? null : cur))
    audioRef.current = a
    void a.play().catch(() => setPlayingId(null))
    setPlayingId(entryId)
  }, [playingId])

  const count = history?.length ?? 0
  const replayable = history?.filter((e) => e.hasAudio).length ?? 0
  const starredCount = history?.filter((e) => e.starred).length ?? 0

  // ── Search + language/starred filter (client-side over the loaded page) ──
  const langs = useMemo(() => {
    const set = new Set<string>()
    for (const e of history ?? []) {
      set.add(e.sourceLang)
      set.add(e.targetLang)
    }
    return Array.from(set).sort()
  }, [history])

  const filtered = useMemo(() => {
    if (!history) return null
    const q = query.trim().toLowerCase()
    return history.filter((e) => {
      if (starredOnly && !e.starred) return false
      if (langFilter !== 'all' && e.sourceLang !== langFilter && e.targetLang !== langFilter) return false
      if (!q) return true
      return (
        e.source.toLowerCase().includes(q) ||
        e.translated.toLowerCase().includes(q)
      )
    })
  }, [history, langFilter, query, starredOnly])

  const filtering = query.trim() !== '' || langFilter !== 'all' || starredOnly

  // Export respects the active search/star/language filters — what you see is
  // what you copy/download.
  const copyAll = useCallback(async () => {
    const list = filtered
    if (!list?.length) return
    const lines = list
      .slice()
      .reverse()
      .map((e) => {
        const when = new Date(e.createdAt).toLocaleString()
        return `[${when}] ${e.sourceLang} → ${e.targetLang}\n  ${e.source}\n  → ${e.translated}`
      })
    try {
      await navigator.clipboard.writeText(lines.join('\n\n'))
      setCopiedAll(true)
      window.setTimeout(() => setCopiedAll(false), 1600)
    } catch {
      // clipboard unavailable — ignore
    }
  }, [filtered])

  const downloadJson = useCallback(() => {
    const list = filtered
    if (!list?.length) return
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `translator-history-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [filtered])

  return (
    <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="flex flex-wrap items-center justify-between gap-y-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="group flex flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors group-hover:border-emerald-900/60 group-hover:text-emerald-400">
            <History className="h-3.5 w-3.5" aria-hidden />
          </span>
          <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300 transition-colors group-hover:text-zinc-100">
            Saved History
          </h2>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-zinc-600 transition-transform duration-200',
              open && 'rotate-180 text-emerald-500'
            )}
            aria-hidden
          />
        </button>
        {count > 0 && (
          <span className="flex items-center gap-1.5">
            {starredCount > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-900/50 bg-amber-950/30 px-2 py-0.5 text-[10px] font-semibold text-amber-400"
                title="Starred phrases (phrasebook)"
              >
                <Star className="h-2.5 w-2.5 fill-amber-400" aria-hidden />
                {starredCount}
              </span>
            )}
            {replayable > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-emerald-900/50 bg-emerald-950/30 px-2 py-0.5 text-[10px] font-semibold text-emerald-400"
                title="Phrases whose audio is still cached and replayable"
              >
                <Volume2 className="h-2.5 w-2.5" aria-hidden />
                {replayable} audio
              </span>
            )}
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
              {count}
            </span>
          </span>
        )}
      </header>

      {open && (
        <div className="mt-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin text-emerald-500" aria-hidden /> Loading…
            </div>
          ) : !history || history.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center">
              <History className="h-5 w-5 text-zinc-600" aria-hidden />
              <p className="max-w-[230px] text-xs leading-relaxed text-zinc-600">
                Nothing saved yet. Every translated phrase is stored here automatically.
              </p>
            </div>
          ) : (
            <>
              {/* Export toolbar */}
              <div className="mb-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyAll()}
                  aria-label="Copy all saved translations to clipboard"
                  title="Copy all (readable text)"
                  className={cn(
                    'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[11px] font-semibold transition-colors',
                    copiedAll
                      ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-700/60 hover:text-emerald-300'
                  )}
                >
                  {copiedAll ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                  {copiedAll ? 'Copied all' : 'Copy all'}
                </button>
                <button
                  type="button"
                  onClick={downloadJson}
                  aria-label="Download history as JSON"
                  title="Download .json"
                  className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-[11px] font-semibold text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
                >
                  <Braces className="h-3 w-3" aria-hidden /> .json
                </button>
              </div>
              <p className="mb-2 text-[10px] leading-relaxed text-zinc-600">
                Audio is kept for the <span className="font-semibold text-zinc-500">{replayable}</span>{' '}
                newest phrase{replayable === 1 ? '' : 's'} shown — older entries downgrade to text only.
              </p>

              {/* Search + language filter */}
              <div className="mb-2 space-y-2">
                <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-emerald-800/70">
                  <Search className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
                  <label htmlFor="history-search" className="sr-only">
                    Search saved translations
                  </label>
                  <input
                    id="history-search"
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search phrases…"
                    autoComplete="off"
                    className="h-7 min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </div>
                {langs.length > 1 || starredCount > 0 ? (
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by language or starred">
                    <SlidersHorizontal className="mr-0.5 h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
                    {starredCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setStarredOnly((v) => !v)}
                        aria-pressed={starredOnly}
                        title="Show only starred phrases"
                        className={cn(
                          'inline-flex h-5 items-center gap-1 rounded-full border px-1.5 font-mono text-[9px] font-bold uppercase tracking-wide transition-colors',
                          starredOnly
                            ? 'border-amber-700/60 bg-amber-950/40 text-amber-300'
                            : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-amber-900/60 hover:text-amber-300'
                        )}
                      >
                        <Star className={cn('h-2.5 w-2.5', starredOnly && 'fill-amber-400')} aria-hidden />
                        starred
                      </button>
                    )}
                    {[{ code: 'all', flag: '•' }, ...langs.map((code) => ({ code, flag: LANG_META[code]?.flag ?? '·' }))].map(
                      ({ code, flag }) => (
                        <button
                          key={code}
                          type="button"
                          onClick={() => setLangFilter(code)}
                          aria-pressed={langFilter === code}
                          className={cn(
                            'inline-flex h-5 items-center gap-1 rounded-full border px-1.5 font-mono text-[9px] font-bold uppercase tracking-wide transition-colors',
                            langFilter === code
                              ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                              : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                          )}
                        >
                          <span aria-hidden>{flag}</span>
                          {code}
                        </button>
                      )
                    )}
                  </div>
                ) : null}
              </div>
              {filtering && (
                <p className="mb-2 text-[10px] font-medium text-zinc-500" role="status">
                  {filtered?.length ?? 0} of {count} phrase{(count === 1 ? '' : 's')} match
                  {(filtered?.length === 1 ? 'es' : '')}
                </p>
              )}
              <ul className="lt-scroll max-h-80 space-y-2 overflow-y-auto pr-1" aria-label="Saved translations">
                {(filtered ?? []).length === 0 ? (
                  <li
                    className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-center"
                    role="status"
                  >
                    {starredOnly ? (
                      <>
                        <Star className="h-4 w-4 text-amber-700" aria-hidden />
                        <p className="text-xs leading-relaxed text-zinc-600">
                          No starred phrases here yet — tap the star on any saved phrase to keep it handy.
                        </p>
                      </>
                    ) : (
                      <>
                        <Search className="h-4 w-4 text-zinc-600" aria-hidden />
                        <p className="text-xs leading-relaxed text-zinc-600">
                          No phrases match “{query.trim() || langFilter}”.
                        </p>
                      </>
                    )}
                  </li>
                ) : (
                (filtered ?? []).map((entry, idx) => {
                  const srcMeta = LANG_META[entry.sourceLang]
                  const tgtMeta = LANG_META[entry.targetLang]
                  const group = dateGroup(entry.createdAt)
                  const prevEntry = idx > 0 ? filtered![idx - 1] : null
                  const prevGroup = prevEntry ? dateGroup(prevEntry.createdAt) : null
                  // Session divider: first entry of a client session group.
                  const newSession = Boolean(entry.sessionId) && entry.sessionId !== prevEntry?.sessionId
                  return (
                    <motion.li
                      key={entry.id}
                      initial={idx === 0 ? { opacity: 0, y: -6 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                      className="space-y-2"
                    >
                      {group !== prevGroup && (
                        <div className="flex items-center gap-2 pt-1" role="separator" aria-label={group}>
                          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600">
                            {group}
                          </span>
                          <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-zinc-800 to-transparent" />
                        </div>
                      )}
                      {newSession && (
                        <div
                          className="flex items-center gap-2 pt-0.5"
                          role="separator"
                          aria-label={`Session starting ${sessionTime(entry.createdAt)}`}
                        >
                          <span className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-teal-500/80">
                            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-teal-500/70" />
                            session · {sessionTime(entry.createdAt)}
                          </span>
                          <span
                            aria-hidden
                            className="h-px flex-1 bg-gradient-to-r from-teal-900/50 via-zinc-800/60 to-transparent"
                          />
                        </div>
                      )}
                      <div
                        className={cn(
                          'rounded-xl border bg-zinc-900/60 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-zinc-700',
                          entry.starred ? 'border-amber-900/50 border-l-2 border-l-amber-500/70' : 'border-zinc-800'
                        )}
                      >
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                          <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-zinc-500">
                            <span aria-hidden>{srcMeta?.flag ?? '·'}</span>
                            {entry.sourceLang}
                            <span className="text-zinc-700">→</span>
                            <span aria-hidden>{tgtMeta?.flag ?? '·'}</span>
                            {entry.targetLang}
                            <span className="text-zinc-700">·</span>
                            <span className="text-emerald-500/70">{entry.style}</span>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            {onToggleStar && (
                              <button
                                type="button"
                                onClick={() => onToggleStar(entry.id)}
                                aria-pressed={Boolean(entry.starred)}
                                aria-label={entry.starred ? 'Remove from starred phrases' : 'Star this phrase'}
                                title={entry.starred ? 'Unstar' : 'Star (phrasebook)'}
                                className={cn(
                                  'inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
                                  entry.starred
                                    ? 'border-amber-700/60 bg-amber-950/40 text-amber-300'
                                    : 'border-zinc-800 bg-zinc-900 text-zinc-600 hover:border-amber-900/60 hover:text-amber-300'
                                )}
                              >
                                <Star
                                  className={cn(
                                    'h-2.5 w-2.5 transition-transform duration-150',
                                    entry.starred && 'scale-110 fill-amber-400 drop-shadow-[0_0_4px_rgba(251,191,36,0.5)]'
                                  )}
                                  aria-hidden
                                />
                              </button>
                            )}
                            {onDelete && (
                              <button
                                type="button"
                                onClick={() => onDelete(entry.id)}
                                aria-label={`Delete this saved phrase`}
                                title="Delete entry (text + audio)"
                                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-600 transition-colors hover:border-rose-900/60 hover:text-rose-300"
                              >
                                <Trash2 className="h-2.5 w-2.5" aria-hidden />
                              </button>
                            )}
                            {onReuse && (
                              <button
                                type="button"
                                onClick={() => onReuse(entry)}
                                aria-label="Translate this phrase again with current settings"
                                title="Re-run with current language & style"
                                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
                              >
                                <RotateCcw className="h-2.5 w-2.5" aria-hidden />
                              </button>
                            )}
                            {entry.hasAudio && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => replayEntry(entry.id)}
                                  aria-label={playingId === entry.id ? 'Stop playback' : 'Replay this saved phrase'}
                                  title={playingId === entry.id ? 'Stop playback' : 'Replay saved audio'}
                                  className={cn(
                                    'inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
                                    playingId === entry.id
                                      ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                                      : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-emerald-700/60 hover:text-emerald-300'
                                  )}
                                >
                                  <Volume2
                                    className={cn('h-2.5 w-2.5', playingId === entry.id && 'animate-pulse')}
                                    aria-hidden
                                  />
                                </button>
                                <a
                                  href={`/api/history/${entry.id}/audio`}
                                  download={`translation-${entry.id}.wav`}
                                  aria-label="Download this phrase as a WAV file"
                                  title="Download .wav"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
                                >
                                  <Download className="h-2.5 w-2.5" aria-hidden />
                                </a>
                              </>
                            )}
                            {onShare && (
                              <button
                                type="button"
                                onClick={() => onShare(entry)}
                                aria-label="Share this saved phrase"
                                title="Share (text + audio where supported)"
                                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
                              >
                                <Share2 className="h-2.5 w-2.5" aria-hidden />
                              </button>
                            )}
                            <span className="inline-flex items-center gap-1 font-mono text-[9px] text-zinc-600">
                              <Clock3 className="h-2.5 w-2.5" aria-hidden />
                              {relativeTime(entry.createdAt)}
                            </span>
                          </span>
                        </div>
                        <p
                          dir={srcMeta?.rtl ? 'rtl' : 'ltr'}
                          lang={entry.sourceLang}
                          className={cn(
                            'text-[13px] leading-relaxed text-zinc-400',
                            srcMeta?.rtl && 'font-fa'
                          )}
                        >
                          {entry.source}
                        </p>
                        <p
                          dir={tgtMeta?.rtl ? 'rtl' : 'ltr'}
                          lang={entry.targetLang}
                          className={cn(
                            'mt-1 border-t border-zinc-800/70 pt-1.5 text-sm font-medium leading-relaxed text-zinc-100',
                            tgtMeta?.rtl && 'font-fa'
                          )}
                        >
                          {entry.translated}
                        </p>
                      </div>
                    </motion.li>
                  )
                })
                )}
              </ul>
              {/* Load more — older pages via the server cursor (hidden while
                  filtering so the loaded subset stays coherent). */}
              {!filtering && cursor && onLoadMore && (
                <button
                  type="button"
                  onClick={() => void onLoadMore()}
                  disabled={loading}
                  aria-label="Load older saved phrases"
                  className="group mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 text-xs font-semibold text-zinc-400 transition-colors hover:border-emerald-800/60 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" aria-hidden />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-y-0.5" aria-hidden />
                  )}
                  {loading ? 'Loading older phrases…' : 'Load older phrases'}
                </button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleClear()}
                className={cn(
                  'mt-3 h-8 w-full gap-1.5 border-zinc-700 bg-zinc-900 text-xs',
                  confirmClear
                    ? 'border-rose-800 bg-rose-950/40 text-rose-300 hover:bg-rose-950/60'
                    : 'text-zinc-400 hover:bg-zinc-800'
                )}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {confirmClear ? 'Tap again to confirm' : 'Clear all'}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.round((Date.now() - then) / 1000)
  if (sec < 45) return 'now'
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

/** "14:32" label for session dividers. */
function sessionTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Coarse day bucket for the date separators in the list. */
function dateGroup(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'Earlier'
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const dayMs = 86400000
  if (then.getTime() >= startOfToday.getTime()) return 'Today'
  if (then.getTime() >= startOfToday.getTime() - dayMs) return 'Yesterday'
  if (then.getTime() >= startOfToday.getTime() - 7 * dayMs) return 'This week'
  return 'Earlier'
}
