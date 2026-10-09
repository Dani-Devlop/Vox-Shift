'use client'

import { useState } from 'react'
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  Download,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Settings2,
  Undo2,
  Users,
} from 'lucide-react'
import type { ThreadDetailData, ThreadMessageData, ThreadOverrides } from '@/types/translator'
import { LANG_META, OTHER_LANGS } from '@/types/translator'
import type { Mode, OtherLang, StyleMode } from '@/types/translator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface ThreadViewProps {
  thread: ThreadDetailData
  /** Enrolled voice profiles — lets a thread pick its own voice. */
  voiceProfiles?: { id: string; name: string; mode: 'clone' | 'voice-match' }[]
  /** Effective settings currently in the hook — shown as the inherit baseline. */
  globalSettingsLabel: string
  loading?: boolean
  liveSessionActive: boolean
  onClose: () => void
  onRename: (id: string, title: string) => Promise<boolean>
  onSaveOverrides: (overrides: ThreadOverrides | null) => Promise<boolean>
  onReplay: (message: ThreadMessageData) => void
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  if (isToday) return 'Today'
  const yesterday = new Date(today.getTime() - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/**
 * Thread view (spec §5.4): chronological transcript of a persisted
 * conversation. Each message shows speaker, both languages, source text,
 * translation, voice used and a play control when audio exists.
 */
export function ThreadView({
  thread,
  voiceProfiles,
  globalSettingsLabel,
  liveSessionActive,
  onClose,
  onRename,
  onSaveOverrides,
  onReplay,
}: ThreadViewProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(thread.conversation.title)
  const [showSettings, setShowSettings] = useState(false)
  const [copied, setCopied] = useState(false)
  const overrides = thread.conversation.overrides ?? {}

  const submitRename = async () => {
    if (title.trim() && title.trim() !== thread.conversation.title) {
      await onRename(thread.conversation.id, title)
    }
    setEditing(false)
  }

  const copyTranscript = async () => {
    const lines = thread.messages.map((m) => {
      const src = LANG_META[m.sourceLang]?.name ?? m.sourceLang
      const tgt = LANG_META[m.targetLang]?.name ?? m.targetLang
      return `[${timeLabel(m.createdAt)}] ${src}: ${m.source}\n→ ${tgt}: ${m.translated}`
    })
    try {
      await navigator.clipboard.writeText(
        [`# ${thread.conversation.title}`, `(${globalSettingsLabel})`, '', ...lines].join('\n')
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard unavailable — ignore
    }
  }

  const setOverride = (patch: ThreadOverrides) => {
    // Keys set to undefined must be REMOVED (inherit), not stored as null —
    // JSON.stringify would silently drop them, so delete explicitly.
    const next: Record<string, unknown> = { ...overrides }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k]
      else next[k] = v
    }
    void onSaveOverrides(Object.keys(next).length > 0 ? (next as ThreadOverrides) : null)
  }

  const lastSession = thread.sessions[thread.sessions.length - 1]

  return (
    <section className="lt-card overflow-hidden rounded-2xl border border-teal-900/50 bg-zinc-900/40">
      {/* Thread header */}
      <header className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-400 transition-colors hover:border-teal-700/60 hover:text-teal-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Back
          </button>
          {editing ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename()
                  if (e.key === 'Escape') setEditing(false)
                }}
                aria-label="Conversation title"
                autoFocus
                className="h-8 w-full min-w-0 rounded-md border border-teal-800/60 bg-zinc-900 px-2 text-sm text-zinc-200 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void submitRename()}
                aria-label="Save title"
                className="shrink-0 rounded-md p-1.5 text-emerald-400 hover:bg-emerald-950/50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Click to rename"
              className="min-w-0 flex-1 truncate text-left text-sm font-bold text-zinc-100 hover:text-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/60"
            >
              {thread.conversation.title}
            </button>
          )}
          <span className="flex shrink-0 items-center gap-1">
            {liveSessionActive && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-800/60 bg-rose-950/40 px-2 py-1 text-[10px] font-semibold text-rose-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" aria-hidden />
                recording
              </span>
            )}
            <button
              type="button"
              onClick={() => void copyTranscript()}
              aria-label="Copy conversation transcript"
              title="Copy transcript"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:border-teal-700/60 hover:text-teal-300"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Thread settings"
              aria-expanded={showSettings}
              title="Thread settings"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
                showSettings || Object.keys(overrides).length > 0
                  ? 'border-teal-700/60 bg-teal-950/40 text-teal-300'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-teal-700/60 hover:text-teal-300'
              }`}
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
          <span>{thread.messages.length} messages</span>
          <span>·</span>
          <span>{thread.sessions.length} sessions</span>
          {lastSession && (
            <>
              <span>·</span>
              <span>
                last session {lastSession.status === 'live' ? 'in progress' : 'ended'} ·{' '}
                {dayLabel(lastSession.startedAt)}
              </span>
            </>
          )}
          {Object.keys(overrides).length > 0 && (
            <>
              <span>·</span>
              <span className="text-teal-400/90">
                thread settings: {Object.keys(overrides).join(', ')}
              </span>
            </>
          )}
        </p>
      </header>

      {/* Thread settings (spec §4.2): overrides inherit global by default */}
      {showSettings && (
        <div className="border-b border-zinc-800 bg-teal-950/20 px-4 py-3.5 sm:px-5">
          <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-wider text-teal-300/90">
            Thread settings — inherit global ({globalSettingsLabel}) until overridden
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Direction
              </label>
              <Select
                value={overrides.mode ?? 'inherit'}
                onValueChange={(v) => setOverride(v === 'inherit' ? { mode: undefined } : { mode: v as Mode })}
              >
                <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="inherit" className="text-xs">
                    Inherit global
                  </SelectItem>
                  <SelectItem value="dub" className="text-xs">
                    Dub (fa → other)
                  </SelectItem>
                  <SelectItem value="interpreter" className="text-xs">
                    Interpreter (other → fa)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Other language
              </label>
              <Select
                value={overrides.otherLang ?? 'inherit'}
                onValueChange={(v) =>
                  setOverride(v === 'inherit' ? { otherLang: undefined } : { otherLang: v as OtherLang })
                }
              >
                <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="inherit" className="text-xs">
                    Inherit global
                  </SelectItem>
                  {OTHER_LANGS.map((code) => (
                    <SelectItem key={code} value={code} className="text-xs">
                      {LANG_META[code].flag} {LANG_META[code].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Content style
              </label>
              <Select
                value={overrides.style ?? 'inherit'}
                onValueChange={(v) => setOverride(v === 'inherit' ? { style: undefined } : { style: v as StyleMode })}
              >
                <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="inherit" className="text-xs">
                    Inherit global
                  </SelectItem>
                  <SelectItem value="natural" className="text-xs">Natural</SelectItem>
                  <SelectItem value="clean" className="text-xs">Clean</SelectItem>
                  <SelectItem value="formal" className="text-xs">Formal</SelectItem>
                  <SelectItem value="casual" className="text-xs">Casual</SelectItem>
                  <SelectItem value="literal" className="text-xs">Literal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Voice profile
              </label>
              <Select
                value={overrides.profileId ?? 'inherit'}
                onValueChange={(v) =>
                  setOverride(
                    v === 'inherit'
                      ? { profileId: undefined, voiceMode: overrides.voiceMode }
                      : { profileId: v, voiceMode: 'profile' }
                  )
                }
              >
                <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="inherit" className="text-xs">
                    Inherit global
                  </SelectItem>
                  {(voiceProfiles ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-xs">
                      {p.mode === 'clone' ? '🎙' : '🎚'} {p.name}
                      {p.mode === 'clone' ? ' (clone)' : ''}
                    </SelectItem>
                  ))}
                  {(voiceProfiles ?? []).length === 0 && (
                    <SelectItem value="__none__" disabled className="text-xs">
                      No profiles enrolled yet
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                This thread only — your global default stays unchanged.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Playback speed
              </label>
              <Select
                value={overrides.playbackRate !== undefined ? String(overrides.playbackRate) : 'inherit'}
                onValueChange={(v) =>
                  setOverride(v === 'inherit' ? { playbackRate: undefined } : { playbackRate: Number(v) })
                }
              >
                <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="inherit" className="text-xs">
                    Inherit global
                  </SelectItem>
                  {[0.75, 1, 1.25, 1.5].map((r) => (
                    <SelectItem key={r} value={String(r)} className="text-xs">
                      ×{r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Big-button talk
              </label>
              <Select
                value={overrides.bigButton === undefined ? 'inherit' : overrides.bigButton ? 'on' : 'off'}
                onValueChange={(v) =>
                  setOverride(v === 'inherit' ? { bigButton: undefined } : { bigButton: v === 'on' })
                }
              >
                <SelectTrigger className="h-9 border-zinc-800 bg-zinc-900/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="inherit" className="text-xs">
                    Inherit global
                  </SelectItem>
                  <SelectItem value="on" className="text-xs">
                    On (oversized PTT)
                  </SelectItem>
                  <SelectItem value="off" className="text-xs">
                    Off
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {Object.keys(overrides).length > 0 && (
            <button
              type="button"
              onClick={() => void onSaveOverrides(null)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-teal-700/60 hover:text-teal-300"
            >
              <Undo2 className="h-3 w-3" aria-hidden />
              Reset to global settings
            </button>
          )}
        </div>
      )}

      {/* Messages (chronological — oldest first, spec §5.4) */}
      <div className="max-h-96 space-y-1 overflow-y-auto px-3 py-3 lt-scroll sm:px-4">
        {thread.messages.length === 0 && (
          <div className="px-2 py-8 text-center">
            <p className="text-sm font-medium text-zinc-400">This conversation is empty</p>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-zinc-600">
              Start a live session or type a phrase below — everything you translate lands here and
              stays here.
            </p>
          </div>
        )}
        {thread.messages.map((m, idx) => (
          <ThreadMessageRow
            key={m.id}
            message={m}
            showDayBreak={
              idx === 0 || dayLabel(thread.messages[idx - 1].createdAt) !== dayLabel(m.createdAt)
            }
            onReplay={() => onReplay(m)}
          />
        ))}
      </div>
    </section>
  )
}

function ThreadMessageRow({
  message: m,
  showDayBreak,
  onReplay,
}: {
  message: ThreadMessageData
  showDayBreak: boolean
  onReplay: () => void
}) {
  const [copied, setCopied] = useState(false)
  const srcMeta = LANG_META[m.sourceLang] ?? LANG_META.fa
  const tgtMeta = LANG_META[m.targetLang] ?? LANG_META.en
  const isUser = m.speakerRole === 'user'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.translated)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // ignore
    }
  }

  return (
    <div>
      {showDayBreak && (
        <p className="flex items-center gap-3 px-2 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 first:pt-1">
          <span className="h-px flex-1 bg-zinc-800/80" aria-hidden />
          {dayLabel(m.createdAt)}
          <span className="h-px flex-1 bg-zinc-800/80" aria-hidden />
        </p>
      )}
      <article
        className={`group rounded-xl border px-3.5 py-3 transition-colors ${
          isUser ? 'border-zinc-800/80 bg-zinc-900/50 hover:border-zinc-700' : 'border-teal-900/40 bg-teal-950/20'
        }`}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
          <span
            className={`inline-flex items-center gap-1 font-semibold uppercase tracking-wide ${
              isUser ? 'text-emerald-400/90' : 'text-teal-300/90'
            }`}
          >
            {isUser ? <Mic className="h-3 w-3" aria-hidden /> : <Users className="h-3 w-3" aria-hidden />}
            {isUser ? 'You' : 'Other side'}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-500">
            {srcMeta.flag} {srcMeta.name}
          </span>
          <span aria-hidden className="text-zinc-600">
            →
          </span>
          <span className="text-zinc-500">
            {tgtMeta.flag} {tgtMeta.name}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="font-mono text-zinc-600">{timeLabel(m.createdAt)}</span>
          {m.voice && m.voice !== 'default' && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="font-mono text-[9px] text-zinc-600">voice: {m.voice}</span>
            </>
          )}
          {m.processingStatus === 'failed' && (
            <span className="inline-flex items-center gap-1 text-rose-400">
              <CircleAlert className="h-3 w-3" aria-hidden /> failed
            </span>
          )}
        </header>
        {m.source && (
          <p
            dir={srcMeta.rtl ? 'rtl' : 'ltr'}
            className={`mt-1.5 break-words text-[13px] leading-relaxed text-zinc-400 ${srcMeta.rtl ? 'text-right' : ''}`}
          >
            {m.source}
          </p>
        )}
        <p
          dir={tgtMeta.rtl ? 'rtl' : 'ltr'}
          className={`mt-0.5 break-words font-medium leading-relaxed text-zinc-100 ${tgtMeta.rtl ? 'text-right' : ''}`}
        >
          {m.translated}
        </p>
        <footer className="mt-2 flex items-center gap-1">
          {m.historyEntryId && (
            <button
              type="button"
              onClick={onReplay}
              aria-label="Play translation audio"
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300 transition-colors hover:border-emerald-700/60 hover:text-emerald-300"
            >
              <Play className="h-3 w-3" aria-hidden /> Play
            </button>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy translation"
            className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {m.historyEntryId && (
            <a
              href={`/api/history/${m.historyEntryId}/audio`}
              download
              aria-label="Download audio"
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
            >
              <Download className="h-3 w-3" aria-hidden /> WAV
            </a>
          )}
        </footer>
      </article>
    </div>
  )
}
