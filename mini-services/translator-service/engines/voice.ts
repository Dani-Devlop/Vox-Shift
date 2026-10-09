import { getZAI } from './asr'
import { resampleWav } from './audio-utils'
import { ElevenLabsCloneEngine, cloneProviderConfigured } from './voice-clone'

// ─────────────────────────────────────────────────────────────────────────────
// Voice Engine — Voice identity / synthesis layer (fully separate from translation)
//
// TWO implementations behind one router:
//   1. ElevenLabsCloneEngine — REAL cross-language voice cloning (IVC). Used
//      when the profile mode is 'clone' and ELEVENLABS_API_KEY is configured.
//      It NEVER silently falls back to a preset voice: failures surface as
//      pipeline errors (text still delivered, audio honestly absent).
//   2. ZaiVoiceEngine — pitch-conformed preset matching (the previous engine,
//      kept as the honest 'voice-match' mode when cloning is not configured).
// ─────────────────────────────────────────────────────────────────────────────

export const ENGINE_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'] as const
export type EngineVoice = (typeof ENGINE_VOICES)[number]

export const DEFAULT_VOICE: EngineVoice = 'kazi'

export interface VoiceEngine {
  readonly id: string
  /** @returns WAV audio buffer */
  synthesize(text: string, opts: { voice: string; speed: number; pitchRatio?: number }): Promise<Buffer>
}

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0
  return Math.min(2.0, Math.max(0.5, speed))
}

/** Pitch ratios beyond this band degrade intelligibility — quality first. */
function clampPitchRatio(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return 1.0
  return Math.min(1.33, Math.max(0.75, ratio))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Retry policy for transient upstream errors (429 rate limit, 5xx, network).
 *  Provider 429 windows vary from sub-second bursts to ~10s stretches — the
 *  ladder covers ~7.5s before surfacing an honest failure (the client keeps
 *  the text result and offers a manual retry). */
const RETRY_DELAYS_MS = [400, 1000, 2200, 4000]

export class ZaiVoiceEngine implements VoiceEngine {
  readonly id = 'zai-tts'

  async synthesize(text: string, opts: { voice: string; speed: number; pitchRatio?: number }): Promise<Buffer> {
    const voice = (ENGINE_VOICES as readonly string[]).includes(opts.voice) ? opts.voice : DEFAULT_VOICE
    const ratio = clampPitchRatio(opts.pitchRatio)

    // Pitch conformance: shifting output pitch by `ratio` while KEEPING the
    // natural speaking tempo. Resampling the WAV by `ratio` raises pitch and
    // shortens duration by the same factor — so the TTS stage is requested at
    // speed (base / ratio) and the resample restores the original duration:
    //   duration = (D₀ / (s/r)) / r = D₀  ✓   pitch = P₀ · r ✓
    const ttsSpeed = clampSpeed(opts.speed / ratio)

    const input = text.slice(0, 1000) // API hard limit 1024 chars

    let lastErr: unknown
    let wav: Buffer | null = null
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const zai = await getZAI()
        const response = await zai.audio.tts.create({
          input,
          voice,
          speed: ttsSpeed,
          response_format: 'wav',
          stream: false,
        })
        const arrayBuffer = await response.arrayBuffer()
        wav = Buffer.from(new Uint8Array(arrayBuffer))
        break
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        // Only retry transient upstream problems; surface anything else fast.
        const transient = /429|rate|too many|5\d\d|timeout|ECONN|fetch failed|network/i.test(msg)
        if (!transient || attempt === RETRY_DELAYS_MS.length) break
        await sleep(RETRY_DELAYS_MS[attempt])
      }
    }
    if (!wav) throw lastErr instanceof Error ? lastErr : new Error('TTS synthesis failed')

    // Apply the pitch shift (no-op when ratio ≈ 1).
    return resampleWav(wav, ratio)
  }
}

export interface IdentitySynthesisOptions {
  voice: string
  speed: number
  pitchRatio?: number
  profileMode?: 'clone' | 'voice-match'
  providerProfileId?: string
  providerModel?: string
  stability?: number
  /** Provider similarity boost 0..1 (clone mode only). */
  providerSimilarity?: number
  /** Provider style exaggeration 0..0.45 (clone mode only). */
  providerStyle?: number
}

/**
 * Router that dispatches synthesis to the right engine based on the profile's
 * declared mode. Cloned profiles go to the real cloning provider — always.
 */
export class VoiceIdentityEngine implements VoiceEngine {
  readonly id = 'voice-identity'
  private cloneEngine = new ElevenLabsCloneEngine()
  private matchEngine = new ZaiVoiceEngine()

  async synthesize(text: string, opts: IdentitySynthesisOptions): Promise<Buffer> {
    if (opts.profileMode === 'clone') {
      if (!opts.providerProfileId) {
        throw new Error(
          'This voice profile has no provider voice id (enrollment incomplete). Re-enroll the sample or switch profiles — no fallback voice was used.'
        )
      }
      if (!cloneProviderConfigured()) {
        throw new Error(
          'Voice cloning provider is not configured (ELEVENLABS_API_KEY missing) — your cloned profile was NOT used and the default voice was deliberately NOT substituted. Add the key to /home/z/my-project/.env and restart both services, or switch to a Voice Match profile.'
        )
      }
      return this.cloneEngine.synthesize(text, {
        providerProfileId: opts.providerProfileId,
        speed: opts.speed,
        providerModel: opts.providerModel,
        stability: opts.stability,
        similarityBoost: opts.providerSimilarity,
        styleExaggeration: opts.providerStyle,
      })
    }
    // 'voice-match' (and any legacy payload without a mode) → pitch-conformed preset.
    return this.matchEngine.synthesize(text, {
      voice: opts.voice,
      speed: opts.speed,
      pitchRatio: opts.pitchRatio,
    })
  }
}
