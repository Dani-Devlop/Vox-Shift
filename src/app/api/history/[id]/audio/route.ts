import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { audioFileExists, audioFilePath, isValidHistoryId } from '@/lib/audio-store'
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/[id]/audio — stream the cached TTS WAV for a saved phrase so
// translations stay replayable across page reloads (the client keeps only the
// last 12 utterances in memory). Ids are validated against a strict charset to
// rule out path traversal; responses are immutable (entry audio never changes).
// Ownership: the requesting user must own the entry (legacy null-user rows stay
// shared on this single-user deployment); unknown users get 404 — never 403 —
// so the existence of another user's audio is not leaked.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  if (!isValidHistoryId(id)) {
    return NextResponse.json({ error: 'Invalid entry id' }, { status: 400 })
  }

  // Ownership check before touching the disk.
  try {
    const userId = await getCurrentUserId()
    const entry = await db.historyEntry.findUnique({ where: { id }, select: { userId: true } })
    if (!entry || (entry.userId && entry.userId !== userId)) {
      return NextResponse.json({ error: 'Audio not available for this entry' }, { status: 404 })
    }
  } catch (error) {
    console.error('[history-audio] ownership check failed:', error)
    return NextResponse.json({ error: 'Failed to read audio' }, { status: 500 })
  }

  if (!audioFileExists(id)) {
    return NextResponse.json({ error: 'Audio not available for this entry' }, { status: 404 })
  }

  try {
    const wav = await readFile(audioFilePath(id))
    return new NextResponse(new Uint8Array(wav), {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    console.error('[history-audio] GET failed:', error)
    return NextResponse.json({ error: 'Failed to read audio' }, { status: 500 })
  }
}
