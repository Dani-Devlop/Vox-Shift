import { getZAI } from './asr'
import { resampleWav } from './audio-utils'
import { openAICompatibleTTS, routedCall } from '../providers/router'
import { ElevenLabsCloneEngine, cloneProviderConfigured } from './voice-clone'
import { detectCloneChain, type CloneEngineId } from '../../../src/lib/voice/clone-chain'
import { cloneRefWavPath, isLocalCloneEngine, localCloneSynthesize } from './clone-workers'

// ─────────────────────────────────────────────────────────────────────────────
// Voice Engine — Voice identity / synthesis layer (fully separate from translation)
//
// Engines behind one router:
//   1. LOCAL-FIRST CLONE CHAIN (v3.5.0) — clone-mode profiles are served in
//      priority order: Fish Speech → F5-TTS → Chatterbox (all zero-shot LOCAL
//      engines, gated by real package+weights+RAM detection) → ElevenLabs IVC
//      (cloud) → pitch-conformed match (local DSP, terminal level, always
//      LABELED as not-a-clone via degraded: true). Every attempt is recorded
//      and the ACTUAL engine id is returned — no silent substitutions.
//   2. local-openvoice — the explicit on-box OpenVoice tone-color conversion
//      (v3.3.1) stays the honored choice when a profile selected it.
//   3. ZaiVoiceEngine — pitch-conformed preset matching for 'voice-match'
//      profiles and the multi-provider TTS chain (local piper/espeak → user
//      endpoints → built-in z-ai) for preset/default voices.
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
  /** Target language (drives the LOCAL espeak/piper voice, v3 §22). */
  lang?: string
}

/** One recorded attempt inside the clone chain (honest failover trail). */
export interface CloneChainAttempt {
  engine: string
  ok: boolean
  ms?: number
  error?: string
}

export interface IdentitySynthesisResult {
  buffer: Buffer
  format: 'wav' | 'mp3'
  /** WHO actually served — one of: local-openvoice, fish-speech, f5-tts,
   *  chatterbox, elevenlabs-ivc, pitch-conformed, or the routed TTS ids. */
  providerId: string
  /** TRUE when a clone-mode request was served by the terminal DSP level
   *  (pitch-conformed preset match) — the UI must label it as NOT a clone. */
  degraded?: boolean
  /** Real failover trail across the clone chain (present in clone mode). */
  cloneAttempts?: CloneChainAttempt[]
}

/**
 * Router that dispatches synthesis to the right engine based on the profile's
 * declared mode. Cloned profiles are served by the LOCAL-FIRST priority chain
 * (v3.5.0): Fish Speech → F5-TTS → Chatterbox → ElevenLabs IVC → pitch-
 * conformed match — every attempt recorded, the ACTUAL engine reported.
 * Preset/default voices go through the multi-provider TTS chain first
 * (user-registered OpenAI-compatible endpoints) with the built-in z-ai
 * engine as the honest final fallback. Every result records WHO served it.
 */
export class VoiceIdentityEngine {
  readonly id = 'voice-identity'
  private cloneEngine = new ElevenLabsCloneEngine()
  private matchEngine = new ZaiVoiceEngine()

  async synthesize(
    text: string,
    opts: IdentitySynthesisOptions
  ): Promise<IdentitySynthesisResult> {
    if (opts.profileMode === 'clone') {
      // Enrollment completeness is a PROFILE problem, not an availability
      // problem — it still refuses honestly (no reference → nothing to clone).
      if (!opts.providerProfileId) {
        throw new Error(
          'This voice profile has no provider voice id (enrollment incomplete). Re-enroll the sample or switch profiles — no fallback voice was used.'
        )
      }
      // Explicit on-box engine choice (v3.3.1) is honored first: base TTS →
      // OpenVoice tone-color conversion toward the enrolled speaker.
      if (opts.providerModel === 'local-openvoice') {
        const { localCloneConvert } = await import('../../../src/lib/voice/local-clone')
        // base synthesis reuses the routed LOCAL branch (piper → espeak) so the
        // base acoustics match the target language; conversion adds the timbre.
        const base = await routedCall<{ buffer: Buffer; format: 'wav' | 'mp3'; conformed: boolean }>('tts', {
          local: async () => {
            const { localTTS } = await import('./local-tts')
            const out = await localTTS(text, { lang: opts.lang ?? 'en', speed: opts.speed })
            return { buffer: out.buffer, format: 'wav' as const, conformed: false }
          },
          user: async (p) => {
            const { bytes, format } = await openAICompatibleTTS(p, text, opts.speed)
            return { buffer: bytes, format, conformed: false }
          },
          builtin: async () => {
            const buffer = await this.matchEngine.synthesize(text, {
              voice: opts.voice,
              speed: opts.speed,
            })
            return { buffer, format: 'wav' as const, conformed: true }
          },
        })
        const converted = await localCloneConvert(opts.providerProfileId, base.value.buffer)
        return { buffer: converted, format: 'wav', providerId: 'local-openvoice' }
      }
      // Everything else → the local-first priority chain.
      return this.synthesizeCloneChain(text, opts)
    }
    // 'voice-match' (and any legacy payload without a mode) → multi-provider
    // TTS chain with policy ordering (LOCAL/SERVER/CLOUD/CUSTOM, v3 §25):
    // local espeak/piper → user endpoints → built-in z-ai, per active policy.
    const routed = await routedCall<{ buffer: Buffer; format: 'wav' | 'mp3'; conformed: boolean }>('tts', {
      local: async () => {
        const { localTTS } = await import('./local-tts')
        const out = await localTTS(text, { lang: opts.lang ?? 'en', speed: opts.speed })
        return { buffer: out.buffer, format: 'wav' as const, conformed: false }
      },
      user: async (p) => {
        const { bytes, format } = await openAICompatibleTTS(p, text, opts.speed)
        return { buffer: bytes, format, conformed: false }
      },
      builtin: async () => {
        const buffer = await this.matchEngine.synthesize(text, {
          voice: opts.voice,
          speed: opts.speed,
          pitchRatio: opts.pitchRatio,
        })
        return { buffer, format: 'wav' as const, conformed: true }
      },
    })
    return { buffer: routed.value.buffer, format: routed.value.format, providerId: routed.providerId }
  }

  /**
   * LOCAL-FIRST clone chain (v3.5.0). Serves a clone-mode profile by walking
   * the detected availability chain and reporting the ACTUAL engine. A local
   * engine that fails AT SYNTHESIS TIME is recorded and the next level gets
   * the request — automatic failover, the same contract as every other
   * category in the router. The terminal level (pitch-conformed) serves with
   * degraded: true so the UI can label the result as NOT a clone.
   */
  private async synthesizeCloneChain(
    text: string,
    opts: IdentitySynthesisOptions
  ): Promise<IdentitySynthesisResult> {
    const attempts: CloneChainAttempt[] = []
    const chain = await detectCloneChain()

    // ── Priorities 1-3: LOCAL zero-shot engines (reference audio required) ──
    for (const entry of chain.chain.filter((e) => e.available && isLocalCloneEngine(e.id))) {
      const engine = entry.id as Extract<CloneEngineId, 'fish-speech' | 'f5-tts' | 'chatterbox'>
      const refPath = cloneRefWavPath(opts.providerProfileId)
      if (!refPath) {
        attempts.push({ engine, ok: false, error: 'no reference WAV on disk for this profile — re-enroll to use local engines' })
        continue
      }
      const t0 = Date.now()
      try {
        const out = await localCloneSynthesize(engine, text, refPath)
        attempts.push({ engine, ok: true, ms: Date.now() - t0 })
        return { buffer: out.buffer, format: 'wav', providerId: engine, degraded: false, cloneAttempts: attempts }
      } catch (err) {
        attempts.push({ engine, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // ── Priority 4: ElevenLabs IVC (cloud) — the existing real clone path ──
    if (cloneProviderConfigured()) {
      const t1 = Date.now()
      try {
        const buffer = await this.cloneEngine.synthesize(text, {
          providerProfileId: opts.providerProfileId!,
          speed: opts.speed,
          providerModel: opts.providerModel,
          stability: opts.stability,
          similarityBoost: opts.providerSimilarity,
          styleExaggeration: opts.providerStyle,
        })
        attempts.push({ engine: 'elevenlabs-ivc', ok: true, ms: Date.now() - t1 })
        return { buffer, format: 'wav', providerId: 'elevenlabs-ivc', degraded: false, cloneAttempts: attempts }
      } catch (err) {
        attempts.push({ engine: 'elevenlabs-ivc', ok: false, ms: Date.now() - t1, error: err instanceof Error ? err.message : String(err) })
      }
    } else {
      attempts.push({ engine: 'elevenlabs-ivc', ok: false, error: 'ELEVENLABS_API_KEY not configured' })
    }

    // ── Priority 5 (terminal): pitch-conformed preset match — LABELED ──────
    // Not a clone: the result is honest DSP conformance of a preset voice and
    // every consumer sees degraded: true + providerId 'pitch-conformed'.
    try {
      const buffer = await this.matchEngine.synthesize(text, {
        voice: opts.voice,
        speed: opts.speed,
        pitchRatio: opts.pitchRatio,
      })
      return { buffer, format: 'wav', providerId: 'pitch-conformed', degraded: true, cloneAttempts: attempts }
    } catch (err) {
      // Terminal level failed too — surface the WHOLE trail on the error so
      // server logs/diagnostics can show exactly how far the chain walked.
      const e = err instanceof Error ? err : new Error(String(err))
      ;(e as Error & { cloneAttempts?: CloneChainAttempt[] }).cloneAttempts = attempts
      throw e
    }
  }
}
