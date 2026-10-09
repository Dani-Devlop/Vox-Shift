import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'

// ── Append a message to a thread ─────────────────────────────────────────────
// POST /api/messages
// { conversationId, sessionId?, source, translated, sourceLang, targetLang,
//   style?, voice?, timings?, historyEntryId?, processingStatus? }
//
// Called by the client after each pipeline result while a thread is open.
// Ownership is enforced: the conversation must belong to the cookie user.

export const dynamic = 'force-dynamic'

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
const TEXT_MAX = 4000

export async function POST(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId || !ID_RE.test(conversationId)) {
      return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
    }

    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    })
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    // Session must belong to this conversation when provided.
    let sessionId: string | null = null
    if (typeof body.sessionId === 'string' && ID_RE.test(body.sessionId)) {
      const session = await db.conversationSession.findFirst({
        where: { id: body.sessionId, conversationId },
        select: { id: true },
      })
      sessionId = session?.id ?? null
    }

    const source = typeof body.source === 'string' ? body.source.trim().slice(0, TEXT_MAX) : ''
    const translated = typeof body.translated === 'string' ? body.translated.trim().slice(0, TEXT_MAX) : ''
    if (!source && !translated) {
      return NextResponse.json({ error: 'source or translated text is required' }, { status: 400 })
    }

    const seq = await db.message.aggregate({
      where: { conversationId },
      _max: { sequenceNo: true },
    })
    const nextSeq = (seq._max.sequenceNo ?? 0) + 1

    const timings =
      body.timings && typeof body.timings === 'object'
        ? JSON.stringify({
            asrMs: Number((body.timings as Record<string, unknown>).asrMs) || 0,
            translateMs: Number((body.timings as Record<string, unknown>).translateMs) || 0,
            ttsMs: Number((body.timings as Record<string, unknown>).ttsMs) || 0,
            totalMs: Number((body.timings as Record<string, unknown>).totalMs) || 0,
          })
        : null

    const message = await db.message.create({
      data: {
        conversationId,
        sessionId,
        sequenceNo: nextSeq,
        speakerRole: body.speakerRole === 'other' ? 'other' : 'user',
        sourceLang: typeof body.sourceLang === 'string' ? body.sourceLang.slice(0, 8) : 'fa',
        targetLang: typeof body.targetLang === 'string' ? body.targetLang.slice(0, 8) : 'en',
        sourceText: source,
        translatedText: translated,
        style: typeof body.style === 'string' ? body.style.slice(0, 16) : 'natural',
        voice: typeof body.voice === 'string' ? body.voice.slice(0, 32) : 'default',
        timingsJson: timings,
        historyEntryId:
          typeof body.historyEntryId === 'string' && ID_RE.test(body.historyEntryId) ? body.historyEntryId : null,
        processingStatus: body.processingStatus === 'failed' ? 'failed' : 'complete',
      },
      select: { id: true, sequenceNo: true, createdAt: true },
    })

    // Touch the thread for recency ordering.
    await db.conversation.update({ where: { id: conversationId }, data: { lastActivityAt: new Date() } })

    return NextResponse.json(
      { message: { id: message.id, sequenceNo: message.sequenceNo, createdAt: message.createdAt.toISOString() } },
      { status: 201 }
    )
  } catch (err) {
    console.error('[api/messages] POST failed:', err)
    return NextResponse.json({ error: 'Could not save message' }, { status: 500 })
  }
}
