import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'
import { computeVoiceprint, parseVoiceprintJson, VOICEPRINT_DIM } from '@/lib/speaker/voiceprint'
import { decodeAudioInput, pcmToInt16 } from '@/lib/speaker/audio-input'
import { pcmToWav } from '@/lib/voice/pitch-shift'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Re-enroll a contact with a fresh voice sample (spec §10 "Re-enroll") ────
// POST /api/voice-contacts/{id}/reenroll
// { audioBase64, sampleRate?, consented, merge?: boolean }
//   merge=false → replace the voiceprint + reference audio
//   merge=true  → average the old and new voiceprints (sturdier recognition)
// The new sample's quality is measured and returned honestly.

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getOrCreateUserId()
    const { id } = await ctx.params
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    if (body.consented !== true) {
      return NextResponse.json({ error: 'Explicit consent is required to update a voice profile.' }, { status: 400 })
    }

    const row = await db.voiceContact.findFirst({ where: { id, userId } })
    if (!row) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
    if (!audioBase64 || audioBase64.length < 1000) {
      return NextResponse.json({ error: 'A voice sample is required' }, { status: 400 })
    }
    const sampleRate =
      typeof body.sampleRate === 'number' && body.sampleRate >= 8000 && body.sampleRate <= 48000
        ? Math.round(body.sampleRate)
        : 16000

    const decoded = decodeAudioInput(Buffer.from(audioBase64, 'base64'), sampleRate)
    if (!decoded || decoded.durationSec < 0.5) {
      return NextResponse.json({ error: 'The audio sample could not be decoded or is too short' }, { status: 400 })
    }
    const vp = computeVoiceprint(pcmToInt16(decoded.pcm), decoded.sampleRate)
    if (!vp || vp.quality.speechSec < 2.5) {
      return NextResponse.json(
        {
          error: 'Not enough clear speech in the new sample (need ≥ 2.5 s of actual speech).',
          measured: vp ? { speechSec: vp.quality.speechSec, snrDb: vp.quality.snrDb } : null,
        },
        { status: 422 }
      )
    }

    // Optional merge with the existing print (same vector dim required).
    const merge = body.merge === true
    const oldVector = parseVoiceprintJson(row.embeddingJson)
    let vector: number[] = Array.from(vp.vector)
    let mergedWith = 1
    if (merge && oldVector && oldVector.length === vector.length) {
      vector = vector.map((v, i) => Number(((v + oldVector[i]) / 2).toFixed(6)))
      mergedWith = 2
      // Re-normalize (L2).
      const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) || 1
      vector = vector.map((v) => Number((v / norm).toFixed(6)))
    }

    // Replace the reference audio file.
    const { mkdirSync, writeFileSync } = await import('fs')
    const path = await import('path')
    const dir = path.join(process.cwd(), 'db', 'audio', 'contacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${row.id}.wav`), pcmToWav(decoded.pcm, decoded.sampleRate))

    const updated = await db.voiceContact.update({
      where: { id: row.id },
      data: {
        embeddingJson: JSON.stringify(vector),
        vectorDim: VOICEPRINT_DIM,
        sampleDuration: vp.quality.speechSec,
        qualityJson: JSON.stringify(vp.quality),
        consentAt: row.consentAt ?? new Date(),
      },
    })

    return NextResponse.json({
      ok: true,
      mergedWith,
      quality: vp.quality,
      contact: {
        id: updated.id,
        name: updated.name,
        sampleDuration: updated.sampleDuration,
        updatedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (err) {
    console.error('[api/voice-contacts/id/reenroll] POST failed:', err)
    return NextResponse.json({ error: 'Could not re-enroll the contact' }, { status: 500 })
  }
}
