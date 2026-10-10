import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'

// ── Sessions inside a thread ─────────────────────────────────────────────────
// POST /api/conversations/[id]/sessions → open a new live session record
// PATCH /api/conversations/[id]/sessions { sessionId, status: 'ended' } → close it
//
// A completed historical session must never look live merely because the
// thread was reopened — only status:'live' rows count as ongoing.

export const dynamic = 'force-dynamic'

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })
    const userId = await getOrCreateUserId()
    const conversation = await db.conversation.findFirst({ where: { id, userId }, select: { id: true } })
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const session = await db.conversationSession.create({
      data: { conversationId: conversation.id, status: 'live' },
      select: { id: true, status: true, startedAt: true },
    })

    // Touch the thread so it sorts to the top of the history list.
    await db.conversation.update({ where: { id: conversation.id }, data: { lastActivityAt: new Date() } })

    return NextResponse.json(
      { session: { id: session.id, status: session.status, startedAt: session.startedAt.toISOString() } },
      { status: 201 }
    )
  } catch (err) {
    console.error('[api/conversations/[id]/sessions] POST failed:', err)
    return NextResponse.json({ error: 'Could not start session' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })
    const userId = await getOrCreateUserId()
    const conversation = await db.conversation.findFirst({ where: { id, userId }, select: { id: true } })
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; status?: unknown }
    if (typeof body.sessionId !== 'string' || !ID_RE.test(body.sessionId)) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }
    const session = await db.conversationSession.findFirst({
      where: { id: body.sessionId, conversationId: conversation.id },
    })
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

    const updated = await db.conversationSession.update({
      where: { id: session.id },
      data: { status: 'ended', endedAt: new Date() },
      select: { id: true, status: true, endedAt: true },
    })
    return NextResponse.json({
      session: { id: updated.id, status: updated.status, endedAt: updated.endedAt?.toISOString() ?? null },
    })
  } catch (err) {
    console.error('[api/conversations/[id]/sessions] PATCH failed:', err)
    return NextResponse.json({ error: 'Could not end session' }, { status: 500 })
  }
}
