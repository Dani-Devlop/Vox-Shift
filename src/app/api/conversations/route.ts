import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'

// ── Conversations: list + create ─────────────────────────────────────────────
// GET  /api/conversations?q=&limit=&cursor=  → threads sorted by recent activity
// POST /api/conversations { title?, sourceLang?, targetLang? } → new thread

export const dynamic = 'force-dynamic'

const MAX_LIMIT = 50

export async function GET(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') ?? '').trim().slice(0, 100)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get('limit')) || 20))
    const cursor = searchParams.get('cursor') // ISO lastActivityAt of the last visible thread

    // Case-insensitive search: SQLite `contains` is case-sensitive for non-ASCII
    // (Prisma offers no `mode: 'insensitive'` on SQLite), so when searching we
    // load a bounded recent window and filter in JavaScript — safe at personal
    // scale (≤400 conversations, ≤4000 messages scanned).
    if (q) {
      const needle = q.toLowerCase()
      const window = await db.conversation.findMany({
        where: { userId },
        orderBy: { lastActivityAt: 'desc' },
        take: 400,
        select: {
          id: true,
          title: true,
          sourceLang: true,
          targetLang: true,
          overridesJson: true,
          createdAt: true,
          lastActivityAt: true,
          _count: { select: { messages: true, sessions: true } },
          messages: { select: { sourceText: true, translatedText: true }, orderBy: { createdAt: 'desc' }, take: 20 },
        },
      })
      const matched = window.filter(
        (c) =>
          c.title.toLowerCase().includes(needle) ||
          c.messages.some(
            (m) => m.sourceText.toLowerCase().includes(needle) || m.translatedText.toLowerCase().includes(needle)
          )
      )
      const page = matched.slice(0, limit)
      return NextResponse.json({
        conversations: page.map((c) => ({
          id: c.id,
          title: c.title,
          sourceLang: c.sourceLang,
          targetLang: c.targetLang,
          hasOverrides: Boolean(c.overridesJson),
          messageCount: c._count.messages,
          sessionCount: c._count.sessions,
          createdAt: c.createdAt.toISOString(),
          lastActivityAt: c.lastActivityAt.toISOString(),
        })),
        nextCursor: matched.length > limit ? page[page.length - 1].lastActivityAt.toISOString() : null,
      })
    }

    const rows = await db.conversation.findMany({
      where: {
        userId,
        ...(cursor ? { lastActivityAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { lastActivityAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        title: true,
        sourceLang: true,
        targetLang: true,
        overridesJson: true,
        createdAt: true,
        lastActivityAt: true,
        _count: { select: { messages: true, sessions: true } },
      },
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return NextResponse.json({
      conversations: page.map((c) => ({
        id: c.id,
        title: c.title,
        sourceLang: c.sourceLang,
        targetLang: c.targetLang,
        hasOverrides: Boolean(c.overridesJson),
        messageCount: c._count.messages,
        sessionCount: c._count.sessions,
        createdAt: c.createdAt.toISOString(),
        lastActivityAt: c.lastActivityAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].lastActivityAt.toISOString() : null,
    })
  } catch (err) {
    console.error('[api/conversations] GET failed:', err)
    return NextResponse.json({ error: 'Could not load conversations' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown
      sourceLang?: unknown
      targetLang?: unknown
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
    const sourceLang = typeof body.sourceLang === 'string' ? body.sourceLang.slice(0, 8) : 'fa'
    const targetLang = typeof body.targetLang === 'string' ? body.targetLang.slice(0, 8) : 'en'

    const conversation = await db.conversation.create({
      data: {
        userId,
        title: title || 'New conversation',
        sourceLang,
        targetLang,
      },
      select: { id: true, title: true, sourceLang: true, targetLang: true, createdAt: true, lastActivityAt: true },
    })
    return NextResponse.json(
      {
        conversation: {
          ...conversation,
          createdAt: conversation.createdAt.toISOString(),
          lastActivityAt: conversation.lastActivityAt.toISOString(),
          messageCount: 0,
          sessionCount: 0,
        },
      },
      { status: 201 }
    )
  } catch (err) {
    console.error('[api/conversations] POST failed:', err)
    return NextResponse.json({ error: 'Could not create conversation' }, { status: 500 })
  }
}
