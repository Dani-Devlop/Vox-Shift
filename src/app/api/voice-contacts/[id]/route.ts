import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'
import { parseVoiceprintJson } from '@/lib/speaker/voiceprint'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── One Voice Contact: rename / disable / threshold / delete (spec §10) ─────
// PATCH /api/voice-contacts/{id}   { name?, disabled?, confidenceThreshold?, language? }
// DELETE /api/voice-contacts/{id}  → removes the profile AND the reference
//                                    audio file (right to deletion, §33).

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

function serialize(row: Record<string, unknown>) {
  const vector = parseVoiceprintJson(row.embeddingJson as string)
  let quality: unknown = null
  try {
    quality = row.qualityJson ? JSON.parse(row.qualityJson as string) : null
  } catch {
    quality = null
  }
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    vector,
    vectorDim: row.vectorDim,
    sampleDuration: row.sampleDuration,
    quality,
    confidenceThreshold: row.confidenceThreshold,
    matchCount: row.matchCount,
    lastMatchConfidence: row.lastMatchConfidence,
    lastMatchAt: row.lastMatchAt instanceof Date ? row.lastMatchAt.toISOString() : null,
    disabled: row.disabled,
    consentAt: row.consentAt instanceof Date ? row.consentAt.toISOString() : null,
    voiceProfileId: row.voiceProfileId,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
    hasReferenceAudio: true,
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getOrCreateUserId()
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null

    const data: Record<string, unknown> = {}
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 80)
    if (typeof body?.disabled === 'boolean') data.disabled = body.disabled
    if (typeof body?.language === 'string') data.language = body.language.slice(0, 8) || null
    if (typeof body?.confidenceThreshold === 'number' && body.confidenceThreshold >= 0.5 && body.confidenceThreshold <= 0.99) {
      data.confidenceThreshold = body.confidenceThreshold
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const updated = await db.voiceContact.updateMany({ where: { id, userId }, data })
    if (updated.count === 0) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    const row = await db.voiceContact.findUnique({ where: { id } })
    return NextResponse.json({ contact: row ? serialize(row as unknown as Record<string, unknown>) : null })
  } catch (err) {
    console.error('[api/voice-contacts/id] PATCH failed:', err)
    return NextResponse.json({ error: 'Could not update the contact' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getOrCreateUserId()
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const row = await db.voiceContact.findFirst({ where: { id, userId }, select: { referenceAudio: true } })
    if (!row) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    await db.voiceContact.delete({ where: { id } })

    // Best-effort file removal (right to deletion).
    let audioDeleted = false
    if (row.referenceAudio) {
      try {
        const { unlinkSync, existsSync } = await import('fs')
        const path = await import('path')
        const file = path.join(process.cwd(), 'db', 'audio', row.referenceAudio)
        if (existsSync(file)) {
          unlinkSync(file)
          audioDeleted = true
        }
      } catch {
        audioDeleted = false
      }
    }
    return NextResponse.json({ ok: true, audioDeleted })
  } catch (err) {
    console.error('[api/voice-contacts/id] DELETE failed:', err)
    return NextResponse.json({ error: 'Could not delete the contact' }, { status: 500 })
  }
}
