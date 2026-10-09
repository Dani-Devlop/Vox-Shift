'use client'

// ─────────────────────────────────────────────────────────────────────────────
// SessionsView (spec §8.1) — polished conversation history page:
// thread cards with title, language pair, message/session counts, activity,
// override badge + search / create / open / rename / delete, followed by the
// Saved Phrases archive (phrasebook with search, filters, export).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { CalendarClock, Loader2, MessagesSquare, Pencil, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HistoryCard } from '@/components/translator/history-card'
import { LANG_META } from '@/types/translator'
import type { ConversationData, HistoryEntryData } from '@/types/translator'
import { cn } from '@/lib/utils'

interface SessionsViewProps {
  conversations: ConversationData[] | null
  conversationsLoading: boolean
  activeThreadId: string | null
  onLoad: (q?: string) => Promise<void>
  onOpenThread: (id: string) => Promise<void>
  onCreate: (title?: string) => Promise<string | null>
  onRename: (id: string, title: string) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
  // Saved phrases (HistoryCard passthrough)
  history: HistoryEntryData[] | null
  historyLoading: boolean
  historyCursor: string | null
  onLoadHistory: () => Promise<void>
  onLoadMoreHistory: () => Promise<void>
  onClearHistory: () => Promise<void>
  onToggleStar: (id: string) => Promise<void>
  onShareSaved: (entry: HistoryEntryData) => void
  onReuse: (entry: HistoryEntryData) => void
  playbackRate: number
  historyCount: number
}

export function SessionsView(p: SessionsViewProps) {
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)

  // Debounced search (server-side across title + transcript text)
  useEffect(() => {
    const t = setTimeout(() => void p.onLoad(query.trim() || undefined), 350)
    return () => clearTimeout(t)
  }, [query])

  const create = async () => {
    setCreating(true)
    try {
      const id = await p.onCreate(newTitle.trim() || undefined)
      if (id) setNewTitle('')
    } finally {
      setCreating(false)
    }
  }

  const conversations = p.conversations ?? []

  return (
    <div className="lt-enter mx-auto flex max-w-3xl flex-col gap-6">
      {/* ── Conversations (threads) ───────────────────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
              <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Conversations</h2>
          </div>
          <span className="font-mono text-[10px] text-zinc-500">{conversations.length} threads</span>
        </header>

        {/* Search + create */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations and transcripts…"
              className="h-9 border-zinc-800 bg-zinc-900 pl-9 pr-8 text-sm placeholder:text-zinc-600 focus-visible:ring-emerald-500/60"
              aria-label="Search conversations"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              placeholder="New conversation title…"
              maxLength={120}
              className="h-9 flex-1 border-zinc-800 bg-zinc-900 text-sm placeholder:text-zinc-600 focus-visible:ring-emerald-500/60 sm:w-44"
              aria-label="New conversation title"
            />
            <Button size="sm" onClick={() => void create()} disabled={creating} className="h-9 gap-1.5 bg-emerald-600 px-3 text-xs hover:bg-emerald-500">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
              New
            </Button>
          </div>
        </div>

        {/* Thread list */}
        {p.conversationsLoading && conversations.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading conversations…
          </div>
        ) : conversations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center">
            <MessagesSquare className="mx-auto mb-2 h-6 w-6 text-zinc-700" aria-hidden />
            <p className="text-sm font-medium text-zinc-400">
              {query ? 'No conversations match your search' : 'No conversations yet'}
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              {query ? 'Try a different search term.' : 'Start one above — every live session inside it is saved and resumable.'}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {conversations.map((c) => {
              const src = LANG_META[(c.sourceLang as keyof typeof LANG_META) ?? 'fa'] ?? LANG_META.fa
              const tgt = LANG_META[(c.targetLang as keyof typeof LANG_META) ?? 'en'] ?? LANG_META.en
              const isActive = c.id === p.activeThreadId
              return (
                <li key={c.id}>
                  {renamingId === c.id ? (
                    <form
                      className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 p-3"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void p.onRename(c.id, renameValue).then(() => setRenamingId(null))
                      }}
                    >
                      <Input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={120} className="h-8 border-zinc-800 bg-zinc-950 text-sm focus-visible:ring-emerald-500/60" aria-label="Conversation title" />
                      <Button type="submit" size="sm" className="h-8 bg-emerald-600 px-3 text-xs hover:bg-emerald-500">Save</Button>
                      <Button type="button" size="sm" variant="outline" className="h-8 border-zinc-700 px-3 text-xs" onClick={() => setRenamingId(null)}>Cancel</Button>
                    </form>
                  ) : deletingId === c.id ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-900/50 bg-rose-950/20 p-3">
                      <span className="flex-1 text-xs text-rose-200">Delete “{c.title}” and its {c.messageCount} messages?</span>
                      <Button size="sm" onClick={() => { void p.onDelete(c.id).then(() => setDeletingId(null)) }} className="h-8 bg-rose-600 px-3 text-xs hover:bg-rose-500">Delete</Button>
                      <Button size="sm" variant="outline" onClick={() => setDeletingId(null)} className="h-8 border-zinc-700 px-3 text-xs">Cancel</Button>
                    </div>
                  ) : (
                    <div
                      className={cn(
                        'group flex items-center gap-3 rounded-xl border p-3 transition-colors',
                        isActive ? 'border-teal-800/60 bg-teal-950/20' : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => void p.onOpenThread(c.id)}
                        className="min-w-0 flex-1 text-left"
                        aria-label={`Open conversation ${c.title}`}
                      >
                        <span className="flex items-center gap-2">
                          <span className={cn('truncate text-sm font-semibold', isActive ? 'text-teal-200' : 'text-zinc-200')}>{c.title}</span>
                          {c.hasOverrides && (
                            <span title="This conversation has its own settings overrides" aria-label="Has settings overrides">
                              <SlidersHorizontal className="h-3 w-3 shrink-0 text-amber-400" aria-hidden />
                            </span>
                          )}
                          {isActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.9)]" aria-label="Currently open" />}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-zinc-500">
                          <span>{src.flag} {c.sourceLang} → {tgt.flag} {c.targetLang}</span>
                          <span aria-hidden>·</span>
                          <span>{c.messageCount} messages</span>
                          <span aria-hidden>·</span>
                          <span>{c.sessionCount} sessions</span>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="h-2.5 w-2.5" aria-hidden />
                            {new Date(c.lastActivityAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </span>
                        </span>
                      </button>
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button size="sm" variant="ghost" onClick={() => { setRenamingId(c.id); setRenameValue(c.title) }} className="h-7 w-7 px-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" aria-label={`Rename ${c.title}`}>
                          <Pencil className="h-3 w-3" aria-hidden />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeletingId(c.id)} className="h-7 w-7 px-0 text-zinc-500 hover:bg-rose-950/40 hover:text-rose-300" aria-label={`Delete ${c.title}`}>
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </Button>
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ── Saved phrases (the recording archive) ─────────────────────────── */}
      <HistoryCard
        history={p.history}
        loading={p.historyLoading}
        onLoad={p.onLoadHistory}
        onClear={p.onClearHistory}
        playbackRate={p.playbackRate}
        cursor={p.historyCursor}
        onLoadMore={p.onLoadMoreHistory}
        onShare={p.onShareSaved}
        onToggleStar={p.onToggleStar}
        onReuse={p.onReuse}
      />
    </div>
  )
}
