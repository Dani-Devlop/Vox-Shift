import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId, getCurrentUserId } from '@/lib/user'

// ── Global user preferences (server-persisted) ───────────────────────────────
// GET /api/preferences → { preferences } (null when anonymous visitor w/o cookie)
// PUT /api/preferences { ...settings } → persisted per anonymous user
//
// Preferences survive page refreshes, browser restarts and redeployments for
// as long as the cookie survives. localStorage remains an offline fallback —
// the server copy wins on load when present.

export const dynamic = 'force-dynamic'

const PREFS_MAX_BYTES = 4096

/** Known preference keys with light validation — unknown keys are dropped. */
function sanitize(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input.mode === 'dub' || input.mode === 'interpreter') out.mode = input.mode
  if (typeof input.otherLang === 'string' && ['en', 'de', 'fr', 'es', 'ar', 'tr', 'it'].includes(input.otherLang)) out.otherLang = input.otherLang
  if (input.style === 'clean' || input.style === 'natural' || input.style === 'literal' || input.style === 'formal' || input.style === 'casual') out.style = input.style
  if (input.voiceMode === 'profile' || input.voiceMode === 'default') out.voiceMode = input.voiceMode
  if (typeof input.playbackRate === 'number' && input.playbackRate >= 0.5 && input.playbackRate <= 2) out.playbackRate = input.playbackRate
  if (typeof input.bigButton === 'boolean') out.bigButton = input.bigButton
  if (input.textSize === 'sm' || input.textSize === 'md' || input.textSize === 'lg') out.textSize = input.textSize
  if (typeof input.compact === 'boolean') out.compact = input.compact
  if (typeof input.showTranscript === 'boolean') out.showTranscript = input.showTranscript
  // Global behavior toggles (settings center, spec §6)
  if (typeof input.autoSaveHistory === 'boolean') out.autoSaveHistory = input.autoSaveHistory
  if (typeof input.useContext === 'boolean') out.useContext = input.useContext
  if (typeof input.showCaptions === 'boolean') out.showCaptions = input.showCaptions
  // AUTO direction + language availability + history retention (v1.2)
  if (typeof input.autoDetect === 'boolean') out.autoDetect = input.autoDetect
  if (typeof input.betaLangs === 'boolean') out.betaLangs = input.betaLangs
  if (typeof input.historyRetentionDays === 'number' && [0, 7, 30, 90].includes(input.historyRetentionDays)) {
    out.historyRetentionDays = input.historyRetentionDays
  }
  return out
}

export async function GET() {
  try {
    const userId = await getCurrentUserId()
    if (!userId) return NextResponse.json({ preferences: null })
    const user = await db.user.findUnique({ where: { id: userId }, select: { prefsJson: true } })
    if (!user?.prefsJson) return NextResponse.json({ preferences: null })
    try {
      const parsed = JSON.parse(user.prefsJson)
      return NextResponse.json({ preferences: parsed && typeof parsed === 'object' ? parsed : null })
    } catch {
      return NextResponse.json({ preferences: null })
    }
  } catch (err) {
    console.error('[api/preferences] GET failed:', err)
    return NextResponse.json({ error: 'Could not load preferences' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

    const clean = sanitize(body)
    const json = JSON.stringify(clean)
    if (json.length > PREFS_MAX_BYTES) {
      return NextResponse.json({ error: 'Preferences too large' }, { status: 413 })
    }

    await db.user.update({ where: { id: userId }, data: { prefsJson: json } })
    return NextResponse.json({ preferences: clean })
  } catch (err) {
    console.error('[api/preferences] PUT failed:', err)
    return NextResponse.json({ error: 'Could not save preferences' }, { status: 500 })
  }
}
