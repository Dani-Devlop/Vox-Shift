import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { resampleWav, clampPitchRatio } from '@/lib/voice/pitch-shift'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'
import {
  synthesizeCloneVoice,
  CLONE_ENGINE_ID,
  type CloneModelKey,
} from '@/lib/voice/clone-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/voice-preview — synthesize a short sample sentence so the user can
// audition their voice profile ("Hear my voice", Voice A/B).
//   mode 'clone'       → REAL cloned voice via ElevenLabs (profile's voice id)
//   mode 'voice-match' → pitch-conformed preset (mirrors the realtime engine)
// Lives in the Next.js backend because it is a one-shot REST call, not part of
// the streaming pipeline. API keys stay server-side.
// ─────────────────────────────────────────────────────────────────────────────

const ENGINE_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']
const DEFAULT_VOICE = 'kazi'

/** Custom-text previews (real translated content) are capped to keep TTS fast. */
const MAX_CUSTOM_TEXT_LEN = 500

/** Direction-aware preview sentence so the audition sounds like real usage. */
const PREVIEW_LINES: Record<string, string> = {
  en: "Hi! This is how your voice sounds in the translation. Pretty close, right?",
  fa: 'سلام! این هم صدای شما در ترجمهٔ زنده است. حالا می‌توانید صحبت کنید و انگلیسی را با همین صدا بشنوید.',
  de: 'Hallo! So klingt deine Stimme in der Übersetzung. Ganz nah dran, oder?',
  fr: "Salut ! Voilà comment ta voix sonne dans la traduction. Plutôt proche, non ?",
  es: '¡Hola! Así suena tu voz en la traducción. Bastante parecida, ¿verdad?',
  ar: 'مرحباً! هكذا تبدو صوتك في الترجمة. قريب جداً، أليس كذلك؟',
  tr: 'Merhaba! Çeviride sesin böyle görünüyor. Oldukça yakın, değil mi?',
  it: "Ciao! Questo è come suona la tua voce nella traduzione. Molto simile, vero?",
}

const RETRIES = 3
const BACKOFF_MS = [400, 1200]

// Derive the client type from the factory — `InstanceType<typeof ZAI>` fails
// because the SDK class declares a private constructor.
type ZAIClient = Awaited<ReturnType<typeof ZAI.create>>
let zaiPromise: Promise<ZAIClient> | null = null
function getZAI() {
  if (!zaiPromise) zaiPromise = ZAI.create()
  return zaiPromise
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const lang = typeof body?.lang === 'string' && PREVIEW_LINES[body.lang] ? body.lang : 'en'
    // Optional custom text (Voice A/B on real translated content). Falls back
    // to the canned preview sentence when absent/empty.
    const rawCustom = typeof body?.text === 'string' ? body.text : ''
    const custom = rawCustom
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CUSTOM_TEXT_LEN)
    const text = custom || PREVIEW_LINES[lang]

    // ── Cloned profile preview ───────────────────────────────────────────────
    // Resolve by profileId (ownership-checked) — the client never picks the
    // provider voice id itself.
    const profileId = typeof body?.profileId === 'string' ? body.profileId : ''
    if (profileId) {
      const userId = await getOrCreateUserId()
      const profile = await db.voiceProfile.findFirst({ where: { id: profileId, OR: [{ userId }, { userId: null }] } })
      if (!profile) return NextResponse.json({ error: 'Voice profile not found' }, { status: 404 })
      if (profile.mode === 'clone' && profile.providerProfileId) {
        try {
          const wav = await synthesizeCloneVoice(text, {
            providerProfileId: profile.providerProfileId,
            modelKey: (profile.providerModel ?? 'balanced') as CloneModelKey | null,
            speed: 1.0,
            stability: profile.stability ?? 0.5,
            similarityBoost: profile.providerSimilarity ?? 0.8,
            style: profile.providerStyle ?? 0,
          })
          return NextResponse.json({
            audioBase64: wav.toString('base64'),
            voice: CLONE_ENGINE_ID,
            voiceMode: 'clone' as const,
            voiceUsed: `${profile.name} (cloned)`,
            lang,
          })
        } catch (err) {
          // Honest failure — do NOT fall back to a preset voice here either.
          const message = err instanceof Error ? err.message : 'Cloned-voice synthesis failed'
          console.error('[voice-preview] clone synthesis failed:', message)
          return NextResponse.json({ error: message }, { status: 502 })
        }
      }
      // voice-match profile: fall through using its stored mapping.
      const speedMatch = Math.min(2, Math.max(0.5, (profile.speedAdjust || 1)))
      const ratioMatch = clampPitchRatio(profile.pitchRatio)
      try {
        const wav = await synthPreset(profile.mappedVoice, speedMatch / ratioMatch, text, ratioMatch)
        return NextResponse.json({
          audioBase64: wav.toString('base64'),
          voice: profile.mappedVoice,
          voiceMode: 'voice-match' as const,
          voiceUsed: `${profile.mappedVoice} ×${ratioMatch.toFixed(2)} (pitch-conformed)`,
          lang,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Voice synthesis unavailable'
        console.error('[voice-preview] voice-match synthesis failed:', message)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // ── Legacy explicit-voice preview (A/B "default" leg + quick auditions) ──
    const voice = ENGINE_VOICES.includes(body?.voice) ? body.voice : DEFAULT_VOICE
    const ratio = clampPitchRatio(Number.isFinite(Number(body?.pitchRatio)) ? Number(body.pitchRatio) : 1)
    const speed = Math.min(2, Math.max(0.5, (Number(body?.speed) || 1) / ratio))
    const wav = await synthPreset(voice, speed, text, ratio)
    return NextResponse.json({
      audioBase64: wav.toString('base64'),
      voice,
      voiceMode: ratio === 1 ? ('default' as const) : ('voice-match' as const),
      voiceUsed: `${voice} ×${ratio.toFixed(2)}`,
      speed,
      lang,
      pitchRatio: ratio,
    })
  } catch (error) {
    console.error('[voice-preview] failed:', error)
    return NextResponse.json({ error: 'Voice preview failed' }, { status: 500 })
  }
}

/** Pitch-conformed preset synthesis with retry (the z-ai engine mirror). */
async function synthPreset(voice: string, speed: number, text: string, ratio: number): Promise<Buffer> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const zai = await getZAI()
      const response = await zai.audio.tts.create({
        input: text,
        voice,
        speed,
        response_format: 'wav',
        stream: false,
      })
      return resampleWav(Buffer.from(await response.arrayBuffer()), ratio)
    } catch (err) {
      lastErr = err
      if (attempt < RETRIES - 1) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Voice synthesis unavailable')
}
