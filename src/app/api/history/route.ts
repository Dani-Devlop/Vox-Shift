import { NextRequest, NextResponse } from 'next/server'
import { writeFile } from 'fs/promises'
import { db } from '@/lib/db'
import { getCurrentUserId, getOrCreateUserId } from '@/lib/user'
import {
  MAX_AUDIO_B64_LEN,
  audioFileExists,
  clearAudioFiles,
  ensureAudioDir,
  audioFilePath,
  pruneAudioFiles,
} from '@/lib/audio-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_TEXT_LEN = 4000
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 40

/**
 * GET /api/history?limit=60&before=<ISO> — most recent persisted translations.
 * `before` is a createdAt cursor for "load more" pagination (entries strictly
 * older than the cursor). Response carries `nextCursor` (null = end reached).
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getCurrentUserId()
    const limitParam = Number(req.nextUrl.searchParams.get('limit')) || DEFAULT_LIMIT
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitParam)))
    const beforeParam = req.nextUrl.searchParams.get('before')
    const beforeMs = beforeParam ? Date.parse(beforeParam) : NaN
    const before = Number.isFinite(beforeMs) ? new Date(beforeMs) : null

    const entries = await db.historyEntry.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      where: {
        // Anonymous visitors w/o cookie see legacy (userId null) rows only;
        // identified users see their own + legacy entries.
        ...(userId ? { OR: [{ userId }, { userId: null }] } : { userId: null }),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
    })

    return NextResponse.json({
      entries: entries.map((e) => ({
        id: e.id,
        source: e.sourceText,
        translated: e.translatedText,
        sourceLang: e.sourceLang,
        targetLang: e.targetLang,
        style: e.style,
        voice: e.voice,
        timings: safeParseTimings(e.timingsJson),
        // hasAudio reflects what is ACTUALLY replayable on disk (pre-feature
        // rows or pruned audio report false), so the UI never offers a dead
        // replay button.
        hasAudio: e.hasAudio && audioFileExists(e.id),
        starred: e.starred,
        sessionId: e.sessionId,
        createdAt: e.createdAt.toISOString(),
      })),
      // Full page = assume more exist; cursor is the oldest loaded createdAt.
      nextCursor: entries.length === limit && entries.length > 0
        ? entries[entries.length - 1].createdAt.toISOString()
        : null,
    })
  } catch (error) {
    console.error('[history] GET failed:', error)
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 })
  }
}

/**
 * POST /api/history — persist one translated utterance.
 * Body: { source, translated, sourceLang, targetLang, style, voice, timings, hasAudio, audioBase64?, sessionId? }
 * When a valid base64 WAV is included it is cached on disk (db/audio/{id}.wav)
 * so the phrase stays replayable across reloads, subject to a rolling cap.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = await req.json()
    const source = String(body?.source ?? '').slice(0, MAX_TEXT_LEN).trim()
    const translated = String(body?.translated ?? '').slice(0, MAX_TEXT_LEN).trim()

    if (!source || !translated) {
      return NextResponse.json({ error: 'source and translated text are required' }, { status: 400 })
    }

    const entry = await db.historyEntry.create({
      data: {
        userId,
        sourceText: source,
        translatedText: translated,
        sourceLang: String(body?.sourceLang ?? 'fa').slice(0, 12),
        targetLang: String(body?.targetLang ?? 'en').slice(0, 12),
        style: String(body?.style ?? 'natural').slice(0, 16),
        voice: String(body?.voice ?? 'default').slice(0, 32),
        timingsJson: JSON.stringify(
          body?.timings && typeof body.timings === 'object'
            ? {
                asrMs: Number(body.timings.asrMs) || 0,
                translateMs: Number(body.timings.translateMs) || 0,
                ttsMs: Number(body.timings.ttsMs) || 0,
                totalMs: Number(body.timings.totalMs) || 0,
              }
            : { asrMs: 0, translateMs: 0, ttsMs: 0, totalMs: 0 }
        ),
        hasAudio: Boolean(body?.hasAudio),
        sessionId: typeof body?.sessionId === 'string' ? body.sessionId.slice(0, 64) : null,
      },
    })

    // ── Optional audio cache (replay across reloads) ────────────────────────
    let audioSaved = false
    const audioBase64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : ''
    if (audioBase64.startsWith('UklGR') && audioBase64.length <= MAX_AUDIO_B64_LEN) {
      try {
        ensureAudioDir()
        await writeFile(audioFilePath(entry.id), Buffer.from(audioBase64, 'base64'))
        audioSaved = true
        pruneAudioFiles() // rolling cap — newest utterances win
      } catch (err) {
        console.error('[history] audio cache write failed:', err)
      }
    }

    return NextResponse.json({ id: entry.id, hasAudio: audioSaved }, { status: 201 })
  } catch (error) {
    console.error('[history] POST failed:', error)
    return NextResponse.json({ error: 'Failed to save history entry' }, { status: 500 })
  }
}

/** DELETE /api/history — clear the whole history (rows + cached audio). */
export async function DELETE() {
  try {
    const userId = await getCurrentUserId()
    if (userId) {
      // Legacy rows (userId null) are cleared too — matches the old behavior.
      await db.historyEntry.deleteMany({ where: { OR: [{ userId }, { userId: null }] } })
    } else {
      await db.historyEntry.deleteMany({ where: { userId: null } })
    }
    clearAudioFiles()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[history] DELETE failed:', error)
    return NextResponse.json({ error: 'Failed to clear history' }, { status: 500 })
  }
}

function safeParseTimings(json: string): { asrMs: number; translateMs: number; ttsMs: number; totalMs: number } {
  try {
    const t = JSON.parse(json)
    return {
      asrMs: Number(t?.asrMs) || 0,
      translateMs: Number(t?.translateMs) || 0,
      ttsMs: Number(t?.ttsMs) || 0,
      totalMs: Number(t?.totalMs) || 0,
    }
  } catch {
    return { asrMs: 0, translateMs: 0, ttsMs: 0, totalMs: 0 }
  }
}
