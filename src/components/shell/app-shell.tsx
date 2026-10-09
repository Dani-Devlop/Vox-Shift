'use client'

// ─────────────────────────────────────────────────────────────────────────────
// AppShell — VoxShift v1.0.0 navigation (spec §4).
// Five destinations, each a real functional panel:
//   Translate · Sessions · Voice Identity · Settings · About/Diagnostics
// Desktop: icon+label left rail. Mobile: fixed bottom bar (safe-area aware).
// The active view syncs to the URL hash (#/sessions) so reloads restore it.
// ─────────────────────────────────────────────────────────────────────────────

import { Activity, AudioWaveform, Languages, MessagesSquare, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AppView = 'translate' | 'sessions' | 'voice' | 'settings' | 'about'

export const APP_VIEWS: { id: AppView; label: string; short: string; icon: typeof Languages }[] = [
  { id: 'translate', label: 'Translate', short: 'Talk', icon: Languages },
  { id: 'sessions', label: 'Sessions', short: 'History', icon: MessagesSquare },
  { id: 'voice', label: 'Voice Identity', short: 'Voice', icon: AudioWaveform },
  { id: 'settings', label: 'Settings', short: 'Setup', icon: Settings },
  { id: 'about', label: 'About · Diagnostics', short: 'Info', icon: Activity },
]

export function viewFromHash(hash: string): AppView {
  const id = hash.replace(/^#\/?/, '') as AppView
  return APP_VIEWS.some((v) => v.id === id) ? id : 'translate'
}

interface AppShellProps {
  view: AppView
  onViewChange: (view: AppView) => void
  /** Header content (brand, status pill, actions) rendered by the page. */
  header: React.ReactNode
  /** Main content for the active view. */
  children: React.ReactNode
  /** Footer rendered below everything (sticks to bottom via mt-auto). */
  footer: React.ReactNode
}

export function AppShell({ view, onViewChange, header, children, footer }: AppShellProps) {
  return (
    <div className="lt-bg-glow flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {header}

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-0 px-0 sm:px-6 lg:gap-6">
        {/* Desktop left rail */}
        <nav
          aria-label="Primary"
          className="sticky top-0 hidden h-screen shrink-0 flex-col gap-1 py-6 lg:flex lg:w-14 xl:w-44"
        >
          {APP_VIEWS.map(({ id, label, short, icon: Icon }) => {
            const active = view === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => onViewChange(id)}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={cn(
                  'group relative flex h-10 items-center gap-3 rounded-xl px-3 text-xs font-semibold transition-colors',
                  active
                    ? 'bg-emerald-500/10 text-emerald-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                    : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                )}
              >
                {/* Active accent bar */}
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                  />
                )}
                <Icon
                  className={cn('h-4 w-4 shrink-0', active ? 'text-emerald-400' : 'text-zinc-500 group-hover:text-zinc-300')}
                  aria-hidden
                />
                <span className="hidden xl:inline">{short}</span>
              </button>
            )
          })}
        </nav>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-0 sm:py-8">
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur lg:hidden"
      >
        <div className="mx-auto grid max-w-md grid-cols-5 px-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5">
          {APP_VIEWS.map(({ id, short, icon: Icon }) => {
            const active = view === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => onViewChange(id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[10px] font-semibold transition-colors',
                  active ? 'text-emerald-300' : 'text-zinc-500 active:text-zinc-300'
                )}
              >
                {/* Active top indicator */}
                {active && (
                  <span
                    aria-hidden
                    className="absolute -top-1.5 h-0.5 w-7 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
                  />
                )}
                <span
                  className={cn(
                    'flex h-7 w-9 items-center justify-center rounded-md transition-colors',
                    active && 'bg-emerald-500/10'
                  )}
                >
                  <Icon className={cn('h-4 w-4', active ? 'text-emerald-400' : '')} aria-hidden />
                </span>
                {short}
              </button>
            )
          })}
        </div>
      </nav>

      {/* Spacer so content never hides behind the mobile bottom bar */}
      <div aria-hidden className="h-16 lg:hidden" />

      {footer}
    </div>
  )
}
