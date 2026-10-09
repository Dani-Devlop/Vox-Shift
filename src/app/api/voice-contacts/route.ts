import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'
import { computeVoiceprint, parseVoiceprintJson, VOICEPRINT_DIM } from '@/lib/speaker/voiceprint'
import { decodeAudioInput, pcmToInt16 } from '@/lib/speaker/audio-input'
import { pcmToWav } from '@/lib/voice/pitch-shift'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ─────────────────────────────────────────────────────────────────────────────
// Voice Contacts (master prompt v2 §8/§10/§17).
//
// GET  /api/voice-contacts        → the user's contacts (embedding included —
//                                   it is the user's own data and is relayed
//                                   to the local recognizer by the client).
// POST /api/voice-contacts        → create a contact from a voice sample.
//      { name, audioBase64, sampleRate?, consented, language?, fromCluster? }
//      The sample may be RAW PCM (browser recorder) or a complete WAV (the
//      ~10 s live-captured enrollment sample from the mini-service).
//      The voiceprint is computed SERVER-SIDE (local DSP) — recognition data
//      never depends on a third-party service.
//
// Consent is mandatory (§33). Identity data stays on this machine: reference
// audio is written to db/audio/contacts/ (gitignored), embeddings to SQLite.
// ─────────────────────────────────────────────────────────────────────────────

const NAME_MAX = 80
const MIN_SPEECH_SEC = 2.5 // same gate as the live enrollment assembler

function serialize(row: {
  id: string
  name: string
  language: string | null
  embeddingJson: string
  vectorDim: number
  sampleDuration: number
  qualityJson: string | null
  confidenceThreshold: number
  matchCount: number
  lastMatchConfidence: number | null
  lastMatchAt: Date | null
  disabled: boolean
  consentAt: Date | null
  voiceProfileId: string | null
  createdAt: Date
  updatedAt: Date
}) {
  const vector = parseVoiceprintJson(row.embeddingJson)
  let quality: Record<string, unknown> | null = null
  try {
    quality = row.qualityJson ? JSON.parse(row.qualityJson) : null
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
    lastMatchAt: row.lastMatchAt?.toISOString() ?? null,
    disabled: row.disabled,
    consentAt: row.consentAt?.toISOString() ?? null,
    voiceProfileId: row.voiceProfileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasReferenceAudio: true,
  }
}

export async function GET() {
  try {
    const userId = await getOrCreateUserId()
    const rows = await db.voiceContact.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({ contacts: rows.map(serialize) })
  } catch (err) {
    console.error('[api/voice-contacts] GET failed:', err)
    return NextResponse.json({ error: 'Could not load voice contacts' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : ''
    if (!name) return NextResponse.json({ error: 'A name is required to save a contact' }, { status: 400 })
    if (body.consented !== true) {
      return NextResponse.json(
        { error: 'Explicit consent is required before enrolling a person’s voice.' },
        { status: 400 }
      )
    }

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
    if (!vp || vp.quality.speechSec < MIN_SPEECH_SEC) {
      return NextResponse.json(
        {
          error:
            'Not enough clear speech in this sample to build a voiceprint. Collect at least ~10 seconds of the person talking (silence does not count).',
          measured: vp ? { speechSec: vp.quality.speechSec, snrDb: vp.quality.snrDb } : null,
        },
        { status: 422 }
      )
    }

    const language = typeof body.language === 'string' ? body.language.slice(0, 8) : null
    const threshold =
      typeof body.confidenceThreshold === 'number' && body.confidenceThreshold >= 0.5 && body.confidenceThreshold <= 0.99
        ? body.confidenceThreshold
        : 0.9

    const contact = await db.voiceContact.create({
      data: {
        userId,
        name,
        language,
        embeddingJson: JSON.stringify(Array.from(vp.vector)),
        vectorDim: VOICEPRINT_DIM,
        referenceAudio: null, // set right below
        sampleDuration: vp.quality.speechSec,
        qualityJson: JSON.stringify(vp.quality),
        confidenceThreshold: threshold,
        consentAt: new Date(),
      },
      select: { id: true },
    })

    // Reference audio on disk (contacts subfolder — never pruned by history).
    const { mkdirSync, writeFileSync } = await import('fs')
    const path = await import('path')
    const dir = path.join(process.cwd(), 'db', 'audio', 'contacts')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${contact.id}.wav`)
    writeFileSync(file, pcmToWav(decoded.pcm, decoded.sampleRate))

    const saved = await db.voiceContact.update({
      where: { id: contact.id },
      data: { referenceAudio: `contacts/${contact.id}.wav` },
    })

    return NextResponse.json({ contact: serialize(saved) }, { status: 201 })
  } catch (err) {
    console.error('[api/voice-contacts] POST failed:', err)
    return NextResponse.json({ error: 'Could not create the voice contact' }, { status: 500 })
  }
}
