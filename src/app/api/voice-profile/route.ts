import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { analyzePcm, base64ToPcm, type VoiceFeatures } from '@/lib/voice/analysis'
import { mapVoiceToEngine, describeProfile } from '@/lib/voice/mapping'
import { getCurrentUserId, getOrCreateUserId } from '@/lib/user'
import {
  cloneConfigured,
  cloneSetupInstructions,
  enrollCloneVoice,
  deleteCloneVoice,
  cloneVoiceExists,
  pcmToWav,
  CLONE_ENGINE_ID,
} from '@/lib/voice/clone-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MIN_DURATION_SEC = 3
const CLONE_MIN_DURATION_SEC = 8 // cloning needs more signal than pitch analysis
const MAX_DURATION_SEC = 60
const MAX_SAMPLE_RATE = 48000
const MAX_PROFILES = 8

/**
 * GET /api/voice-profile — list the user's voice profiles + the active one.
 * Scopes to the anonymous cookie user; legacy global profiles (userId null)
 * are claimed by the first visitor so existing data survives the upgrade.
 * The response includes the honest capability report: whether REAL cloning
 * (provider-backed) is configured on this deployment.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getCurrentUserId()
    if (!userId) return NextResponse.json({ profiles: [], profile: null, capabilities: capabilities() })

    // One-time migration: claim legacy global profiles.
    await db.voiceProfile.updateMany({ where: { userId: null }, data: { userId } })

    const profiles = await db.voiceProfile.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })

    // ?verify=1 → genuinely check each cloned profile against the provider
    // (does the voice still exist there?). 'ok' | 'missing' | 'unknown'.
    // Never called implicitly — an explicit UI action to stay cheap and honest.
    let providerStatus: Record<string, string> | undefined
    if (req.nextUrl.searchParams.get('verify') === '1' && cloneConfigured()) {
      const clones = profiles.filter((p) => p.mode === 'clone' && p.providerProfileId)
      const results = await Promise.all(
        clones.map(async (p) => [p.id, await cloneVoiceExists(p.providerProfileId!)] as const)
      )
      providerStatus = Object.fromEntries(
        results.map(([id, exists]) => [id, exists === true ? 'ok' : exists === false ? 'missing' : 'unknown'])
      )
    }

    return NextResponse.json({
      profiles,
      profile: profiles.find((p) => p.isActive) ?? null,
      capabilities: capabilities(),
      providerStatus,
    })
  } catch (error) {
    console.error('[voice-profile] GET failed:', error)
    return NextResponse.json({ error: 'Failed to load voice profiles' }, { status: 500 })
  }
}

/**
 * POST /api/voice-profile
 * Body: { audioBase64: string (raw PCM Int16 LE), sampleRate: number, consented?: boolean,
 *         name?: string, providerModel?: 'balanced'|'quality', stability?: number }
 *
 * Analyzes the sample acoustically, then:
 *  - when the cloning provider is configured → uploads the sample for REAL
 *    cross-language voice cloning (ElevenLabs IVC) and stores the returned
 *    provider voice id (mode 'clone'). The provider error is surfaced
 *    verbatim on failure — no profile is faked.
 *  - otherwise → creates the honest pitch-conformed 'voice-match' profile and
 *    the response explains exactly how to enable real cloning.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const audioBase64: string | undefined = body?.audioBase64
    const sampleRate = Number(body?.sampleRate) || 16000
    const consented = body?.consented === true
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''
    const providerModel = body?.providerModel === 'quality' || body?.providerModel === 'balanced' ? body.providerModel : 'balanced'
    const stability = Number.isFinite(Number(body?.stability)) ? Math.min(1, Math.max(0, Number(body.stability))) : 0.5

    if (!consented) {
      return NextResponse.json(
        { error: 'Voice enrollment requires your explicit consent to analyze the sample.' },
        { status: 403 }
      )
    }
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return NextResponse.json({ error: 'audioBase64 (raw PCM) is required' }, { status: 400 })
    }
    if (sampleRate < 8000 || sampleRate > MAX_SAMPLE_RATE) {
      return NextResponse.json({ error: 'sampleRate must be between 8000 and 48000' }, { status: 400 })
    }

    const pcm = base64ToPcm(audioBase64)
    const durationSec = pcm.length / sampleRate
    const minSec = cloneConfigured() ? CLONE_MIN_DURATION_SEC : MIN_DURATION_SEC
    if (durationSec < minSec) {
      return NextResponse.json(
        {
          error: cloneConfigured()
            ? `Voice sample too short (${durationSec.toFixed(1)}s). Cloning needs at least ${CLONE_MIN_DURATION_SEC}s — speak longer for a faithful clone.`
            : `Voice sample too short (${durationSec.toFixed(1)}s). Record at least ${MIN_DURATION_SEC}s.`,
        },
        { status: 400 }
      )
    }
    if (durationSec > MAX_DURATION_SEC) {
      return NextResponse.json(
        { error: `Voice sample too long (${durationSec.toFixed(0)}s). Max ${MAX_DURATION_SEC}s.` },
        { status: 400 }
      )
    }

    const features: VoiceFeatures = analyzePcm(pcm, sampleRate)

    // Reject samples that are essentially silence
    if (features.voicedRatio < 0.08 || features.meanF0 <= 0) {
      return NextResponse.json(
        { error: 'No clear voice detected. Record the sample in a quiet place, speaking normally.' },
        { status: 422 }
      )
    }

    const mapping = mapVoiceToEngine(features)
    const userId = await getOrCreateUserId()

    const existingCount = await db.voiceProfile.count({ where: { userId } })
    if (existingCount >= MAX_PROFILES) {
      return NextResponse.json(
        { error: `Profile limit reached (${MAX_PROFILES}). Delete one to enroll a new voice.` },
        { status: 409 }
      )
    }

    // ── REAL VOICE CLONING: enroll the sample with the provider ─────────────
    let clone: { providerProfileId: string; requiresVerification: boolean } | null = null
    if (cloneConfigured()) {
      try {
        const wav = pcmToWav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate)
        clone = await enrollCloneVoice(name || 'My Voice', wav)
      } catch (err) {
        // Honest failure — never create a profile that pretends to be a clone.
        const message = err instanceof Error ? err.message : 'Cloning provider enrollment failed'
        console.error('[voice-profile] clone enrollment failed:', message)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // The new profile becomes the active default; previous ones are kept.
    await db.voiceProfile.updateMany({ where: { userId }, data: { isActive: false } })
    const profile = await db.voiceProfile.create({
      data: {
        userId,
        name: name || `My Voice ${existingCount + 1}`,
        isActive: true,
        mode: clone ? 'clone' : 'voice-match',
        consentAt: new Date(),
        meanF0: round(features.meanF0, 1),
        f0Std: round(features.f0Std, 1),
        f0Min: round(features.f0Min, 1),
        f0Max: round(features.f0Max, 1),
        spectralCentroid: round(features.spectralCentroid, 0),
        estimatedGender: mapping.estimatedGender,
        voiceCharacter: describeProfile(features, mapping),
        mappedVoice: mapping.mappedVoice,
        speedAdjust: mapping.speedAdjust,
        pitchRatio: mapping.pitchRatio,
        speakingRate: round(features.speakingRate, 2),
        sampleDuration: round(features.durationSec, 1),
        clippingRatio: round(features.clippingRatio, 4),
        snrDb: round(features.snrDb, 1),
        engine: clone ? CLONE_ENGINE_ID : 'zai-tts',
        providerProfileId: clone?.providerProfileId ?? null,
        providerModel: clone ? providerModel : null,
        stability,
      },
    })
    const profiles = await db.voiceProfile.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })

    return NextResponse.json({ profile, profiles, capabilities: capabilities() }, { status: 201 })
  } catch (error) {
    console.error('[voice-profile] POST failed:', error)
    return NextResponse.json({ error: 'Failed to create voice profile' }, { status: 500 })
  }
}

/**
 * PATCH /api/voice-profile — rename, set default, or update the cloning
 * advanced settings (providerModel, stability) of one profile.
 * Body: { id: string, name?: string, isActive?: boolean, providerModel?: string, stability?: number }
 */
export async function PATCH(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = await req.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: 'Profile id is required' }, { status: 400 })

    const profile = await db.voiceProfile.findFirst({ where: { id, OR: [{ userId }, { userId: null }] } })
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

    const data: { name?: string; isActive?: boolean; providerModel?: string; stability?: number } = {}
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 60)
    if (body?.isActive === true) {
      await db.voiceProfile.updateMany({ where: { userId }, data: { isActive: false } })
      data.isActive = true
    }
    if (profile.mode === 'clone') {
      if (body?.providerModel === 'balanced' || body?.providerModel === 'quality') {
        data.providerModel = body.providerModel
      }
      if (Number.isFinite(Number(body?.stability))) {
        data.stability = Math.min(1, Math.max(0, Number(body.stability)))
      }
    }
    const updated = await db.voiceProfile.update({ where: { id }, data })
    const profiles = await db.voiceProfile.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })
    return NextResponse.json({ profile: updated, profiles })
  } catch (error) {
    console.error('[voice-profile] PATCH failed:', error)
    return NextResponse.json({ error: 'Failed to update voice profile' }, { status: 500 })
  }
}

/**
 * DELETE /api/voice-profile?id=<id> — delete one profile (if it was active the
 * most recent remaining one becomes active). No id → delete ALL profiles.
 * Cloned profiles also delete the provider-side voice (sample + embedding) —
 * deletion behavior is explicit, and the response reports whether the
 * provider deletion succeeded so failures are never silent.
 */
export async function DELETE(req: NextRequest) {
  try {
    const userId = await getCurrentUserId()
    if (!userId) return NextResponse.json({ ok: true, activeId: null })

    const id = req.nextUrl.searchParams.get('id')
    const providerDeletions: Array<{ id: string; deleted: boolean }> = []

    if (id) {
      const profile = await db.voiceProfile.findFirst({ where: { id, OR: [{ userId }, { userId: null }] } })
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
      if (profile.mode === 'clone' && profile.providerProfileId) {
        providerDeletions.push({ id: profile.id, deleted: await deleteCloneVoice(profile.providerProfileId) })
      }
      await db.voiceProfile.delete({ where: { id } })
      if (profile.isActive) {
        const next = await db.voiceProfile.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        })
        if (next) {
          await db.voiceProfile.update({ where: { id: next.id }, data: { isActive: true } })
        }
      }
    } else {
      const clones = await db.voiceProfile.findMany({
        where: { OR: [{ userId }, { userId: null }], mode: 'clone', providerProfileId: { not: null } },
      })
      for (const p of clones) {
        providerDeletions.push({ id: p.id, deleted: await deleteCloneVoice(p.providerProfileId!) })
      }
      await db.voiceProfile.deleteMany({ where: { OR: [{ userId }, { userId: null }] } })
    }

    const profiles = await db.voiceProfile.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })
    return NextResponse.json({
      ok: true,
      profiles,
      activeId: profiles.find((p) => p.isActive)?.id ?? null,
      providerDeletions,
    })
  } catch (error) {
    console.error('[voice-profile] DELETE failed:', error)
    return NextResponse.json({ error: 'Failed to delete voice profile' }, { status: 500 })
  }
}

/**
 * Honest capability report. canClone reflects whether a REAL cloning provider
 * is configured on this deployment — the UI renders the exact setup steps
 * when it is not, and never presents voice-match output as a clone.
 */
function capabilities() {
  const configured = cloneConfigured()
  return {
    canClone: configured,
    cloneConfigured: configured,
    canConvert: false,
    canMatch: true,
    canPitchConform: true,
    engine: configured ? CLONE_ENGINE_ID : 'zai-tts',
    mode: configured ? ('clone' as const) : ('voice-match' as const),
    note: configured
      ? 'Real voice cloning is active: your sample is enrolled with ElevenLabs Instant Voice Cloning and the generated English audio is synthesized from YOUR enrolled voice (cross-language, Persian reference → English speech).'
      : 'Your sample is analyzed for pitch, brightness and tempo. The closest studio voice is chosen, its pitch is shifted toward your register, and its tempo is matched — your sample genuinely shapes the output. This is an estimated match, NOT a vocal clone.',
    setup: configured ? null : cloneSetupInstructions(),
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
