import { cookies } from 'next/headers'
import { db } from '@/lib/db'

// ── Anonymous cookie identity ────────────────────────────────────────────────
// The deployment has no account system yet. Per spec §4.1 we implement a
// secure, clearly scoped anonymous-user mechanism instead of treating browser
// state as identity: an httpOnly `vox_uid` cookie maps to a User row, and all
// owned records (conversations, preferences, profiles) are validated against
// it server-side. Swapping in a real auth provider later only changes this
// file — every route already resolves ownership through getOrCreateUser().

const COOKIE_NAME = 'vox_uid'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year

/** Shape of an id we accept from an incoming cookie (defensive). */
const UID_RE = /^[a-zA-Z0-9_-]{8,64}$/

/**
 * Resolve (or lazily create) the anonymous user for the current request.
 * Always returns a user id that exists in the DB. Call this at the top of
 * every API route that reads or writes owned data.
 */
export async function getOrCreateUserId(): Promise<string> {
  const jar = await cookies()
  const incoming = jar.get(COOKIE_NAME)?.value

  if (incoming && UID_RE.test(incoming)) {
    const user = await db.user.findUnique({ where: { id: incoming }, select: { id: true } })
    if (user) return user.id
    // Cookie points at a deleted/foreign row — fall through and reissue.
  }

  const user = await db.user.create({ data: {}, select: { id: true } })
  try {
    jar.set(COOKIE_NAME, user.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    })
  } catch {
    // cookies().set() can throw in non-mutable contexts (RSC render) — the
    // caller only uses the id for this request; the cookie will be issued by
    // the next mutating route.
  }
  return user.id
}

/**
 * Resolve the current user WITHOUT creating one — for read-only paths where
 * an anonymous visitor should simply see empty data instead of minting rows.
 * Returns null when no valid cookie is present.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const jar = await cookies()
  const incoming = jar.get(COOKIE_NAME)?.value
  if (!incoming || !UID_RE.test(incoming)) return null
  const user = await db.user.findUnique({ where: { id: incoming }, select: { id: true } })
  return user?.id ?? null
}
