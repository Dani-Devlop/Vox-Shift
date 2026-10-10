'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, MessageSquare, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { ConversationData } from '@/types/translator'
import { LANG_META } from '@/types/translator'

interface ConversationsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversations: ConversationData[] | null
  loading: boolean
  activeThreadId: string | null
  onLoad: (q?: string) => void
  onOpenThread: (id: string) => void
  onCreate: (title?: string) => Promise<string | null>
  onRename: (id: string, title: string) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * Conversation browser (spec §5.1): create, rename, search, delete and reopen
 * persistent threads. Opening a thread loads its transcript and settings.
 */
export function ConversationsDrawer({
  open,
  onOpenChange,
  conversations,
  loading,
  activeThreadId,
  onLoad,
  onOpenThread,
  onCreate,
  onRename,
  onDelete,
}: ConversationsDrawerProps) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Debounced search — re-queries the server (title + transcript text).
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => onLoad(query.trim() || undefined), query ? 350 : 0)
    return () => clearTimeout(t)
     
  }, [query, open])

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const id = await onCreate()
      if (id) onOpenChange(false) // thread opened in the main view — close the drawer
    } finally {
      setCreating(false)
    }
  }

  const submitRename = async (id: string) => {
    if (renameValue.trim()) await onRename(id, renameValue)
    setRenamingId(null)
    setRenameValue('')
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-full flex-col gap-0 border-zinc-800 bg-zinc-950/95 p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-zinc-800 px-5 pb-4 pt-5">
          <SheetTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.2em] text-zinc-200">
            <MessageSquare className="h-4 w-4 text-emerald-400" aria-hidden />
            Conversations
          </SheetTitle>
          <SheetDescription className="text-xs text-zinc-500">
            Persistent threads — leave, come back, continue where you stopped.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 border-b border-zinc-800 px-5 py-3.5">
          {/* Search (spec §5.1) */}
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors focus-within:border-emerald-700/60">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and transcripts…"
              aria-label="Search conversations"
              className="h-9 w-full min-w-0 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-emerald-800/60 bg-emerald-950/40 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-900/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-60"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            New conversation
          </button>
        </div>

        {/* Thread list */}
        <div className="max-h-96 flex-1 overflow-y-auto px-3 py-2 lt-scroll">
          {loading && conversations === null && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading conversations…
            </div>
          )}
          {conversations !== null && conversations.length === 0 && (
            <div className="px-3 py-10 text-center">
              <p className="text-sm font-medium text-zinc-400">
                {query ? 'No conversations match' : 'No conversations yet'}
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                {query ? `Nothing found for “${query}”.` : 'Create one to keep a persistent, resumable transcript.'}
              </p>
            </div>
          )}
          {conversations?.map((c) => {
            const srcMeta = LANG_META[c.sourceLang] ?? LANG_META.fa
            const tgtMeta = LANG_META[c.targetLang] ?? LANG_META.en
            const isActive = c.id === activeThreadId
            return (
              <div
                key={c.id}
                className={`group mb-1 rounded-xl border px-3 py-2.5 transition-colors ${
                  isActive
                    ? 'border-emerald-800/70 bg-emerald-950/30'
                    : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900/60'
                }`}
              >
                {renamingId === c.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename(c.id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      aria-label="Conversation title"
                      className="h-8 w-full min-w-0 rounded-md border border-emerald-800/60 bg-zinc-900 px-2 text-sm text-zinc-200 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void submitRename(c.id)}
                      aria-label="Save title"
                      className="shrink-0 rounded-md p-1.5 text-emerald-400 hover:bg-emerald-950/50"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      aria-label="Cancel rename"
                      className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenThread(c.id)
                        onOpenChange(false)
                      }}
                      className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-200">{c.title}</span>
                        {isActive && (
                          <span className="shrink-0 rounded-full border border-emerald-700/60 bg-emerald-950/60 px-1.5 text-[9px] font-bold uppercase tracking-wide text-emerald-400">
                            open
                          </span>
                        )}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                        <span aria-hidden>
                          {srcMeta.flag}→{tgtMeta.flag}
                        </span>
                        <span>{c.messageCount} msgs</span>
                        <span>·</span>
                        <span>{relativeTime(c.lastActivityAt)}</span>
                        {c.hasOverrides && (
                          <>
                            <span>·</span>
                            <span className="text-teal-400/80">thread settings</span>
                          </>
                        )}
                      </span>
                    </button>
                    <span className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingId(c.id)
                          setRenameValue(c.title)
                        }}
                        aria-label={`Rename ${c.title}`}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                      >
                        <Pencil className="h-3 w-3" aria-hidden /> Rename
                      </button>
                      {confirmDeleteId === c.id ? (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={async () => {
                              await onDelete(c.id)
                              setConfirmDeleteId(null)
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-rose-950/60 px-2 py-1 text-[10px] font-semibold text-rose-300 hover:bg-rose-900/60"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden /> Really delete?
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            aria-label="Cancel delete"
                            className="rounded-md px-1.5 py-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                          >
                            <X className="h-3 w-3" aria-hidden />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(c.id)}
                          aria-label={`Delete ${c.title}`}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-rose-950/40 hover:text-rose-300"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden /> Delete
                        </button>
                      )}
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>

        <p className="border-t border-zinc-800 px-5 py-3 text-[10px] leading-relaxed text-zinc-600">
          Threads are saved per browser (anonymous cookie identity) — a conversation from days ago
          stays accessible until you delete it.
        </p>
      </SheetContent>
    </Sheet>
  )
}
