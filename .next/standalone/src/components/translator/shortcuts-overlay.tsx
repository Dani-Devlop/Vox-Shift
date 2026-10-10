'use client'

import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Command, Mic2, Presentation, RotateCcw, SendHorizonal, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ShortcutsOverlayProps {
  open: boolean
  onClose: () => void
}

interface ShortcutRow {
  keys: string[]
  label: string
  hint: string
  icon: React.ReactNode
}

const SHORTCUTS: ShortcutRow[] = [
  {
    keys: ['Space'],
    label: 'Push to talk',
    hint: 'Hold while a live session runs — release to send',
    icon: <Mic2 className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    keys: ['Enter'],
    label: 'Send typed phrase',
    hint: 'Submit the text box through the same pipeline',
    icon: <SendHorizonal className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    keys: ['R'],
    label: 'Replay last',
    hint: 'Hear the latest translation in your voice again',
    icon: <RotateCcw className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    keys: ['Esc'],
    label: 'Exit present mode',
    hint: 'Leave the jumbo-translation display',
    icon: <Presentation className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    keys: ['?'],
    label: 'Toggle this help',
    hint: 'Show or hide the shortcut cheat-sheet',
    icon: <Command className="h-3.5 w-3.5" aria-hidden />,
  },
]

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-7 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 px-1.5 font-mono text-[10px] font-bold text-zinc-300 shadow-[0_2px_0_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]">
      {children}
    </kbd>
  )
}

/** Modal cheat-sheet for the app's keyboard shortcuts (? toggles, Esc closes). */
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  // Esc closes the overlay (and only the overlay — present mode re-registers
  // its own Esc handler while open).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-4 backdrop-blur-sm"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="lt-card w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/95 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-emerald-400">
                  <Command className="h-3.5 w-3.5" aria-hidden />
                </span>
                <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">
                  Keyboard Shortcuts
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close shortcuts"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </header>

            <ul className="space-y-2.5">
              {SHORTCUTS.map((s, i) => (
                <motion.li
                  key={s.label}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: 0.05 + i * 0.05, ease: 'easeOut' }}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5',
                    'shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-500">
                    {s.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-zinc-200">{s.label}</p>
                    <p className="truncate text-[10px] leading-relaxed text-zinc-500">{s.hint}</p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </motion.li>
              ))}
            </ul>

            <p className="mt-3 border-t border-zinc-800 pt-3 text-center text-[10px] leading-relaxed text-zinc-600">
              Push-to-talk needs a live session — press START first.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
