import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { audioFileExists, audioFilePath, isValidHistoryId } from '@/lib/audio-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/[id]/audio — stream the cached TTS WAV for a saved phrase so
// translations stay replayable across page reloads (the client keeps only the
// last 12 utterances in memory). Ids are validated against a strict charset to
// rule out path traversal; responses are immutable (entry audio never changes).
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  if (!isValidHistoryId(id)) {
    return NextResponse.json({ error: 'Invalid entry id' }, { status: 400 })
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
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    console.error('[history-audio] GET failed:', error)
    return NextResponse.json({ error: 'Failed to read audio' }, { status: 500 })
  }
}
