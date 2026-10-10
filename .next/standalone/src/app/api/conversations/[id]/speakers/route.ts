import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Per-conversation speaker registry (master prompt v2 §5/§12/§17) ─────────
// GET /api/conversations/{id}/speakers → stored cluster labels + embeddings
// PUT /api/conversations/{id}/speakers → replace the snapshot (client sends
//      the tracker's registry when a session ends or a speaker is identified)
//
// This keeps temporary speaker ids (spk_001…) STABLE across app restarts and
// lets identified names survive on the same conversation — "Unknown 1" spoken
// yesterday is still "Unknown 1" (or the assigned contact) today.

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getOrCreateUserId()
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    const conversation = await db.conversation.findFirst({ where: { id, userId }, select: { id: true } })
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    const rows = await db.conversationSpeaker.findMany({
      where: { conversationId: id },
      orderBy: { clusterKey: 'asc' },
    })
    return NextResponse.json({
      speakers: rows.map((r) => ({
        clusterKey: r.clusterKey,
        contactId: r.contactId,
        displayName: r.displayName,
        vector: r.embeddingJson ? JSON.parse(r.embeddingJson) : null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    })
  } catch (err) {
    console.error('[api/conversations/id/speakers] GET failed:', err)
    return NextResponse.json({ error: 'Could not load speakers' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getOrCreateUserId()
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    const conversation = await db.conversation.findFirst({ where: { id, userId }, select: { id: true } })
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const body = (await req.json().catch(() => null)) as { speakers?: unknown } | null
    const list = Array.isArray(body?.speakers) ? body!.speakers.slice(0, 50) : []

    const wanted: Array<{ clusterKey: string; contactId: string | null; displayName: string | null; vector: number[] | null }> = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const clusterKey = typeof o.clusterKey === 'string' ? o.clusterKey.slice(0, 24) : ''
      if (!/^spk_\d{1,6}$/.test(clusterKey)) continue
      const contactId = typeof o.contactId === 'string' && o.contactId.length <= 64 ? o.contactId : null
      const displayName = typeof o.displayName === 'string' ? o.displayName.slice(0, 80) : null
      let vector: number[] | null = null
      if (Array.isArray(o.vector) && o.vector.length > 0 && o.vector.length <= 256) {
        const arr = o.vector.map((v) => Number(v))
        if (arr.every((v) => Number.isFinite(v))) vector = arr
      }
      wanted.push({ clusterKey, contactId, displayName, vector })
    }

    await db.$transaction(async (tx) => {
      await tx.conversationSpeaker.deleteMany({ where: { conversationId: id } })
      for (const s of wanted) {
        await tx.conversationSpeaker.create({
          data: {
            conversationId: id,
            clusterKey: s.clusterKey,
            contactId: s.contactId,
            displayName: s.displayName,
            embeddingJson: s.vector ? JSON.stringify(s.vector) : null,
          },
        })
      }
    })
    return NextResponse.json({ ok: true, count: wanted.length })
  } catch (err) {
    console.error('[api/conversations/id/speakers] PUT failed:', err)
    return NextResponse.json({ error: 'Could not save the speaker registry' }, { status: 500 })
  }
}
