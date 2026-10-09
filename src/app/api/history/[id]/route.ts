import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * PATCH /api/history/{id} — update a saved entry's flags.
 * Body: { starred?: boolean }
 * Used by the phrasebook (star) toggle. Returns the updated flags so the
 * client can reconcile its optimistic state.
 * Ownership: legacy rows (userId null) stay editable by anyone (single-user
 * deployment heritage); owned rows are only editable by their user.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const userId = await getCurrentUserId()
    const body = await req.json().catch(() => ({}))

    const data: { starred?: boolean } = {}
    if (typeof body?.starred === 'boolean') data.starred = body.starred
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
    }

    const existing = await db.historyEntry.findUnique({ where: { id }, select: { id: true, userId: true } })
    if (!existing) {
      return NextResponse.json({ error: 'entry not found' }, { status: 404 })
    }
    if (existing.userId && existing.userId !== userId) {
      return NextResponse.json({ error: 'entry not found' }, { status: 404 }) // never leak existence
    }

    const updated = await db.historyEntry.update({
      where: { id },
      data,
      select: { id: true, starred: true },
    })
    return NextResponse.json(updated)
  } catch (error) {
    console.error('[history] PATCH failed:', error)
    return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 })
  }
}
