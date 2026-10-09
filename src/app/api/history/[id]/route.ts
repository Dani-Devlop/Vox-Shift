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

/**
 * DELETE /api/history/{id} — delete ONE saved entry (text row + its cached
 * audio file, and unlink any thread messages pointing at it). Ownership rules
 * match PATCH: owned rows only for their user; legacy null-user rows remain
 * deletable on this single-user deployment.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const userId = await getCurrentUserId()

    const existing = await db.historyEntry.findUnique({ where: { id }, select: { id: true, userId: true } })
    if (!existing) {
      return NextResponse.json({ error: 'entry not found' }, { status: 404 })
    }
    if (existing.userId && existing.userId !== userId) {
      return NextResponse.json({ error: 'entry not found' }, { status: 404 }) // never leak existence
    }

    await db.message.updateMany({ where: { historyEntryId: id }, data: { historyEntryId: null } })
    await db.historyEntry.delete({ where: { id } })
    // Best-effort audio cleanup (the file may already be pruned).
    try {
      const { deleteAudioFile } = await import('@/lib/audio-store')
      deleteAudioFile(id)
    } catch {
      /* audio file already gone */
    }
    return NextResponse.json({ ok: true, id })
  } catch (error) {
    console.error('[history] DELETE failed:', error)
    return NextResponse.json({ error: 'Failed to delete entry' }, { status: 500 })
  }
}
