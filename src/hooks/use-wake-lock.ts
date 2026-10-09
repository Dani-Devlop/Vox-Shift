'use client'

// ─────────────────────────────────────────────────────────────────────────────
// useWakeLock — keeps the phone screen awake while a live translation session
// is running (the user is speaking, not touching the screen). Uses the
// Screen Wake Lock API when available; silently no-ops elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'

type WakeLockSentinelLike = {
  released: boolean
  addEventListener: (type: 'release', listener: () => void) => void
  release: () => Promise<void>
}
type WakeLockApiLike = { request: (type: 'screen') => Promise<WakeLockSentinelLike> }

export function useWakeLock(active: boolean) {
  const [held, setHeld] = useState(false)
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null)

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    setHeld(false)
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release()
      } catch {
        // already released
      }
    }
  }, [])

  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: WakeLockApiLike }
    if (!nav.wakeLock || !active) {
      // Defer release to a macrotask so no setState runs synchronously in the effect body
      const timer = window.setTimeout(() => void release(), 0)
      return () => window.clearTimeout(timer)
    }

    let cancelled = false

    const acquire = async () => {
      try {
        const sentinel = await nav.wakeLock!.request('screen')
        if (cancelled) {
          void sentinel.release()
          return
        }
        sentinelRef.current = sentinel
        setHeld(true)
        // Re-acquire automatically when visibility returns (mobile OS behavior)
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) {
            sentinelRef.current = null
            setHeld(false)
          }
        })
      } catch {
        // Permission denied / unsupported — not critical
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !sentinelRef.current) void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void release()
    }
  }, [active, release])

  return held
}
