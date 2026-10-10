import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { analyzePcm, base64ToPcm } from '@/lib/voice/analysis'
import { mapVoiceToEngine } from '@/lib/voice/mapping'
import { pcmToWav } from '@/lib/voice/clone-provider'
import { mkdir, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { localCloneEnroll, localCloneDrop, localCloneHealth } from '@/lib/voice/local-clone'

/**
 * LOCAL voice-clone enrollment (v3.3.1) — OpenVoice v2 tone-color conversion.
 *
 * POST   /api/voice-profile/clone
 *   body: { audioBase64: raw PCM b64, sampleRate, consented: true, name? }
 *   → creates the profile, stores the reference WAV ON-BOX
 *     (db/audio/clone-ref/{profileId}.wav), extracts the tone-color embedding
 *     via mini-services/voice-clone-service (:3010), and flips the profile to
 *     mode 'clone' + providerModel 'local-openvoice'.
 *   → on ANY clone-service failure the profile creation is rolled back and the
 *     provider error is surfaced verbatim (no fake profile, no preset fallback).
 *
 * DELETE /api/voice-profile/clone?id={profileId}
 *   → right-to-erasure: drops the cached embedding, deletes the reference WAV,
 *     and reverts the profile to 'voice-match'.
 * GET    → clone-service health (model loaded? enrolled speaker count only).
 */

const MIN_DURATION_SEC = 3
const MAX_DURATION_SEC = 60
const MAX_SAMPLE_RATE = 48000
const REF_DIR = path.join(process.cwd(), 'db', 'audio', 'clone-ref')
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export async function GET() {
  try {
    const h = await localCloneHealth()
    return NextResponse.json({ ...h, speakerCount: h.speakers?.length ?? 0, speakers: undefined })
  } catch (err) {
    return NextResponse.json(
      { status: 'unreachable', error: err instanceof Error ? err.message : String(err) },
      { status: 503 }
    )
  }
}

export async function POST(req: NextRequest) {
  let created: { id: string } | null = null
  let refPath: string | null = null
  try {
    const body = await req.json()
    const audioBase64: string | undefined = body?.audioBase64
    const sampleRate = Number(body?.sampleRate) || 16000
    const consented = body?.consented === true
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''

    if (!consented) {
      return NextResponse.json(
        { error: 'Local voice cloning requires your explicit consent to store and process the reference sample on this machine.' },
        { status: 403 }
      )
    }
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return NextResponse.json({ error: 'audioBase64 (raw PCM) is required' }, { status: 400 })
    }
    if (sampleRate < 8000 || sampleRate > MAX_SAMPLE_RATE) {
      return NextResponse.json({ error: `sampleRate must be between 8000 and ${MAX_SAMPLE_RATE}` }, { status: 400 })
    }

    const pcm = base64ToPcm(audioBase64)
    const durSec = pcm.length / sampleRate // Int16Array length = sample count
    if (durSec < MIN_DURATION_SEC) {
      return NextResponse.json(
        { error: `Voice sample too short (${durSec.toFixed(1)}s). Local cloning needs at least ${MIN_DURATION_SEC}s of clean speech.` },
        { status: 400 }
      )
    }
    if (durSec > MAX_DURATION_SEC) {
      return NextResponse.json({ error: `Voice sample too long (max ${MAX_DURATION_SEC}s).` }, { status: 400 })
    }

    // Acoustic stats stay in the profile (used by the UI + voice-match fallback).
    const features = analyzePcm(pcm, sampleRate)
    if (features.voicedRatio < 0.08 || features.meanF0 <= 0) {
      return NextResponse.json(
        { error: 'The sample looks silent or non-speech. Record again in a quieter place.' },
        { status: 400 }
      )
    }
    const mapping = mapVoiceToEngine(features)

    // 1) create the profile row (id = speakerId for the clone service)
    created = await db.voiceProfile.create({
      data: {
        name: name || 'My Voice (local clone)',
        mode: 'clone',
        consentAt: new Date(),
        meanF0: features.meanF0,
        f0Std: features.f0Std,
        f0Min: features.f0Min,
        f0Max: features.f0Max,
        spectralCentroid: features.spectralCentroid,
        estimatedGender: mapping.estimatedGender,
        voiceCharacter: mapping.voiceCharacter,
        mappedVoice: mapping.mappedVoice,
        pitchRatio: mapping.pitchRatio,
        speakingRate: features.speakingRate,
        sampleDuration: durSec,
        sampleCount: 1,
        // provider fields set after successful enrollment
      },
      select: { id: true },
    })
    if (!ID_RE.test(created.id)) throw new Error('generated profile id not clone-safe')

    // 2) persist the reference WAV ON-BOX (never leaves the machine)
    const wav = pcmToWav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate)
    await mkdir(REF_DIR, { recursive: true })
    refPath = path.join(REF_DIR, `${created.id}.wav`)
    await writeFile(refPath, wav)

    // 3) extract + cache the tone-color embedding via the clone service
    const enrolled = await localCloneEnroll(created.id, wav)

    // 4) finalize the profile as a local-clone profile
    const profile = await db.voiceProfile.update({
      where: { id: created.id },
      data: {
        providerProfileId: created.id,
        providerModel: 'local-openvoice',
        engine: 'local-openvoice',
        refAudioPath: path.relative(process.cwd(), refPath),
      },
    })

    return NextResponse.json({
      ok: true,
      profile,
      clone: { refSeconds: enrolled.refSeconds, seDims: enrolled.seDims },
      honesty:
        'The generated audio carries your enrolled tone color on top of a local neural base voice (piper). This is an on-box conversion — your reference never leaves this machine.',
    })
  } catch (err) {
    // rollback: no fake profiles
    if (created?.id) {
      await db.voiceProfile.delete({ where: { id: created.id } }).catch(() => undefined)
    }
    if (refPath) await unlink(refPath).catch(() => undefined)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Local clone enrollment failed' },
      { status: 502 }
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    if (!ID_RE.test(id)) {
      return NextResponse.json({ error: 'invalid profile id' }, { status: 400 })
    }
    const profile = await db.voiceProfile.findUnique({ where: { id } })
    if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 404 })

    await localCloneDrop(id).catch(() => undefined) // best-effort service-side drop
    if (profile.refAudioPath) {
      await unlink(path.join(process.cwd(), profile.refAudioPath)).catch(() => undefined)
    }
    const updated = await db.voiceProfile.update({
      where: { id },
      data: {
        mode: 'voice-match',
        providerProfileId: null,
        providerModel: null,
        engine: 'zai-tts',
        refAudioPath: null,
      },
    })
    return NextResponse.json({ ok: true, profile: updated })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Local clone drop failed' },
      { status: 500 }
    )
  }
}
