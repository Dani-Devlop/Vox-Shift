import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'

// ── Conversation detail: read / update / delete ──────────────────────────────
// GET    /api/conversations/[id] → thread + sessions + messages (chronological)
// PATCH  /api/conversations/[id] { title?, overrides?, sourceLang?, targetLang? }
// DELETE /api/conversations/[id] → cascade sessions + messages (Prisma cascade)

export const dynamic = 'force-dynamic'

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

async function ownedConversation(id: string, userId: string) {
  if (!ID_RE.test(id)) return null
  return db.conversation.findFirst({ where: { id, userId } })
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const userId = await getOrCreateUserId()
    const conversation = await ownedConversation(id, userId)
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const [sessions, messages] = await Promise.all([
      db.conversationSession.findMany({
        where: { conversationId: conversation.id },
        orderBy: { startedAt: 'asc' },
        select: { id: true, status: true, startedAt: true, endedAt: true },
      }),
      db.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { sequenceNo: 'asc' },
        take: 500,
      }),
    ])

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        sourceLang: conversation.sourceLang,
        targetLang: conversation.targetLang,
        overrides: safeJson(conversation.overridesJson),
        createdAt: conversation.createdAt.toISOString(),
        lastActivityAt: conversation.lastActivityAt.toISOString(),
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
      })),
      messages: messages.map(messageShape),
    })
  } catch (err) {
    console.error('[api/conversations/[id]] GET failed:', err)
    return NextResponse.json({ error: 'Could not load conversation' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const userId = await getOrCreateUserId()
    const conversation = await ownedConversation(id, userId)
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown
      overrides?: unknown
      sourceLang?: unknown
      targetLang?: unknown
    }

    const data: Record<string, unknown> = { lastActivityAt: new Date() }
    if (typeof body.title === 'string') {
      const title = body.title.trim().slice(0, 120)
      if (title) data.title = title
    }
    if (body.overrides === null) {
      data.overridesJson = null // explicit reset to inherit global settings
    } else if (body.overrides && typeof body.overrides === 'object') {
      data.overridesJson = JSON.stringify(sanitizeOverrides(body.overrides as Record<string, unknown>))
    }
    if (typeof body.sourceLang === 'string') data.sourceLang = body.sourceLang.slice(0, 8)
    if (typeof body.targetLang === 'string') data.targetLang = body.targetLang.slice(0, 8)

    const updated = await db.conversation.update({
      where: { id: conversation.id },
      data,
      select: { id: true, title: true, overridesJson: true, lastActivityAt: true },
    })
    return NextResponse.json({
      conversation: {
        id: updated.id,
        title: updated.title,
        overrides: safeJson(updated.overridesJson),
        lastActivityAt: updated.lastActivityAt.toISOString(),
      },
    })
  } catch (err) {
    console.error('[api/conversations/[id]] PATCH failed:', err)
    return NextResponse.json({ error: 'Could not update conversation' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const userId = await getOrCreateUserId()
    const conversation = await ownedConversation(id, userId)
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    // Messages + sessions cascade via Prisma relations; audio blobs stay in the
    // HistoryEntry cache (owned by the phrasebook, not the thread).
    await db.conversation.delete({ where: { id: conversation.id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/conversations/[id]] DELETE failed:', err)
    return NextResponse.json({ error: 'Could not delete conversation' }, { status: 500 })
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Only known thread-setting keys survive; values are type-checked. */
function sanitizeOverrides(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input.style === 'clean' || input.style === 'natural' || input.style === 'literal' || input.style === 'formal' || input.style === 'casual') out.style = input.style
  if (input.mode === 'dub' || input.mode === 'interpreter') out.mode = input.mode
  if (typeof input.otherLang === 'string' && ['en', 'de', 'fr', 'es', 'ar', 'tr', 'it'].includes(input.otherLang)) out.otherLang = input.otherLang
  if (input.voiceMode === 'profile' || input.voiceMode === 'default') out.voiceMode = input.voiceMode
  // Per-thread voice profile choice — validated as an id-shaped string; the
  // client falls back to the global active profile when the id is stale.
  if (typeof input.profileId === 'string' && input.profileId.length >= 8 && input.profileId.length <= 40) out.profileId = input.profileId
  if (typeof input.playbackRate === 'number' && input.playbackRate >= 0.5 && input.playbackRate <= 2) out.playbackRate = input.playbackRate
  if (typeof input.bigButton === 'boolean') out.bigButton = input.bigButton
  return out
}

function messageShape(m: {
  id: string
  sessionId: string | null
  sequenceNo: number
  speakerRole: string
  sourceLang: string
  targetLang: string
  sourceText: string
  translatedText: string
  style: string
  voice: string
  timingsJson: string | null
  historyEntryId: string | null
  processingStatus: string
  createdAt: Date
}) {
  return {
    id: m.id,
    sessionId: m.sessionId,
    sequenceNo: m.sequenceNo,
    speakerRole: m.speakerRole,
    sourceLang: m.sourceLang,
    targetLang: m.targetLang,
    source: m.sourceText,
    translated: m.translatedText,
    style: m.style,
    voice: m.voice,
    timings: safeJson(m.timingsJson),
    historyEntryId: m.historyEntryId,
    processingStatus: m.processingStatus,
    createdAt: m.createdAt.toISOString(),
  }
}
