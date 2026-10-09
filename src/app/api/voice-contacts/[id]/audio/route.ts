import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'
import { existsSync, readFileSync, statSync } from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Play a contact's reference recording (spec §7/§10) ──────────────────────
// GET /api/voice-contacts/{id}/audio → WAV bytes. OWNERSHIP CHECKED: only the
// enrolling user's cookie can fetch the sample (foreign ids → 404).

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getOrCreateUserId()
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const row = await db.voiceContact.findFirst({ where: { id, userId }, select: { referenceAudio: true } })
    if (!row?.referenceAudio) return NextResponse.json({ error: 'Contact or audio not found' }, { status: 404 })

    const file = path.join(process.cwd(), 'db', 'audio', row.referenceAudio)
    if (!existsSync(file)) return NextResponse.json({ error: 'Audio file missing' }, { status: 404 })

    const data = readFileSync(file)
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(data.length),
        'Last-Modified': statSync(file).mtime.toUTCString(),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    console.error('[api/voice-contacts/id/audio] GET failed:', err)
    return NextResponse.json({ error: 'Could not read the audio' }, { status: 500 })
  }
}
