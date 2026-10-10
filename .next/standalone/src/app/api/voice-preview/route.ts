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
// audition their voice profile ("Test my voice", Voice A/B).
//
// v3.6.0 FIX: the old implementation called the built-in z-ai SDK directly,
// which on deployments without /etc/.z-ai-config threw
// "configuration file not found or invalid …" for EVERY preview — "Test my
// voice" was broken there. The route now forwards the (ownership-checked)
// profile fields to the translator service's loopback REST endpoint, which
// runs the REAL synthesis chains:
//   clone mode     → local-first priority chain (Fish Speech → F5-TTS →
//                    Chatterbox → ElevenLabs IVC → pitch-conformed, labeled)
//   voice-match    → routed TTS (local piper → user endpoints → built-in z-ai)
// The legacy paths below are honest LAST-RESORT fallbacks for deployments
// where the translator service is down but a cloud key exists.
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

/** Loopback REST endpoint of the translator mini-service (v3.6.0). */
const TRANSLATOR_REST_URL = process.env.TRANSLATOR_REST_URL ?? 'http://127.0.0.1:3004'

// Derive the client type from the factory — `InstanceType<typeof ZAI>` fails
// because the SDK class declares a private constructor.
type ZAIClient = Awaited<ReturnType<typeof ZAI.create>>
let zaiPromise: Promise<ZAIClient> | null = null
function getZAI() {
  if (!zaiPromise) zaiPromise = ZAI.create()
  return zaiPromise
}

/** True when the error is the honest "no z-ai config on this box" failure. */
function isBuiltinUnconfiguredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /configuration file not found|\.z-ai config|z-ai config/i.test(msg)
}

interface TranslatorPreviewResult {
  ok: boolean
  audioBase64?: string
  providerId?: string
  degraded?: boolean
  voiceMode?: string
  cloneAttempts?: Array<{ engine: string; ok: boolean; ms?: number; error?: string }>
  error?: string
}

/**
 * Forward the preview to the translator's full synthesis chain. Returns null
 * when the service is unreachable (caller falls back to the legacy legs).
 */
async function viaTranslator(payload: Record<string, unknown>): Promise<TranslatorPreviewResult | null> {
  try {
    const res = await fetch(`${TRANSLATOR_REST_URL}/preview-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55_000),
      cache: 'no-store',
    })
    const body = (await res.json()) as TranslatorPreviewResult
    if (!res.ok || !body.ok || !body.audioBase64) {
      return { ok: false, error: body.error ?? `translator service returned HTTP ${res.status}` }
    }
    return body
  } catch {
    return null // translator down / timeout — legacy fallback decides
  }
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

    // ── Cloned / voice-match profile preview ────────────────────────────────
    // Resolve by profileId (ownership-checked) — the client never picks the
    // provider voice id itself.
    const profileId = typeof body?.profileId === 'string' ? body.profileId : ''
    if (profileId) {
      const userId = await getOrCreateUserId()
      const profile = await db.voiceProfile.findFirst({ where: { id: profileId, OR: [{ userId }, { userId: null }] } })
      if (!profile) return NextResponse.json({ error: 'Voice profile not found' }, { status: 404 })

      // PRIMARY: the translator's full chain (works with ONLY local engines).
      const via = await viaTranslator({
        lang,
        text,
        profileMode: profile.mode,
        voice: profile.mappedVoice,
        speed: Math.min(2, Math.max(0.5, profile.speedAdjust || 1)),
        pitchRatio: clampPitchRatio(profile.pitchRatio),
        providerProfileId: profile.providerProfileId ?? undefined,
        providerModel: profile.providerModel ?? undefined,
        stability: profile.stability ?? 0.5,
        providerSimilarity: profile.providerSimilarity ?? 0.8,
        providerStyle: profile.providerStyle ?? 0,
      })
      if (via?.audioBase64) {
        return NextResponse.json({
          audioBase64: via.audioBase64,
          voice: via.providerId,
          voiceMode: profile.mode,
          voiceUsed: via.degraded
            ? `${profile.name} · pitch-conformed match (NOT a clone)`
            : `${profile.name} · ${via.providerId}`,
          degraded: via.degraded === true,
          cloneAttempts: via.cloneAttempts,
          lang,
        })
      }
      if (via && !via.audioBase64) {
        // The chain answered but could not synthesize — surface WHY verbatim.
        return NextResponse.json({ error: via.error ?? 'Voice preview unavailable' }, { status: 502 })
      }

      // FALLBACK (translator service down): clone → ElevenLabs direct;
      // voice-match → z-ai direct with the honest unconfigured message.
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
        const message = isBuiltinUnconfiguredError(err)
          ? 'The built-in cloud voice engine is not configured on this deployment, and the translator service (local piper / pitch-conformed engines) is unreachable. Start the translator service to preview your voice locally.'
          : err instanceof Error
            ? err.message
            : 'Voice synthesis unavailable'
        console.error('[voice-preview] voice-match synthesis failed:', message)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // ── Legacy explicit-voice preview (A/B "default" leg + quick auditions) ──
    const voice = ENGINE_VOICES.includes(body?.voice) ? body.voice : DEFAULT_VOICE
    const ratio = clampPitchRatio(Number.isFinite(Number(body?.pitchRatio)) ? Number(body.pitchRatio) : 1)
    const speed = Math.min(2, Math.max(0.5, (Number(body?.speed) || 1) / ratio))
    // PRIMARY: translator chain (local piper serves without any cloud config).
    const via = await viaTranslator({ lang, text, voice, speed: speed * ratio, pitchRatio: ratio })
    if (via?.audioBase64) {
      return NextResponse.json({
        audioBase64: via.audioBase64,
        voice,
        voiceMode: ratio === 1 ? ('default' as const) : ('voice-match' as const),
        voiceUsed: `${voice} ×${ratio.toFixed(2)}${via.providerId ? ` · ${via.providerId}` : ''}`,
        speed,
        lang,
        pitchRatio: ratio,
      })
    }
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
    const message = isBuiltinUnconfiguredError(error)
      ? 'The built-in cloud voice engine is not configured on this deployment, and the local preview engines are unreachable (translator service down). The failover chain usually serves previews locally — check that the translator service is running.'
      : error instanceof Error
        ? error.message
        : 'Voice preview failed'
    console.error('[voice-preview] failed:', message)
    return NextResponse.json({ error: message }, { status: 502 })
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
