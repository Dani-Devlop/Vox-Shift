import { readFileSync } from 'fs'
import { pcmToWav } from './audio-utils'

// ─────────────────────────────────────────────────────────────────────────────
// Real voice cloning engine — ElevenLabs Instant Voice Cloning (IVC).
//
// Why ElevenLabs: it is a reputable provider whose cloning is REFERENCE-AUDIO
// BASED and CROSS-LANGUAGE: a Persian-speaking reference sample produces a
// speaker embedding that carries over to English (and 30+ other languages)
// synthesis, preserving timbre, pitch register and speaking style.
//
// Credential contract (kept 100% server-side):
//   ELEVENLABS_API_KEY in /home/z/my-project/.env  (or the service env)
//   → create at elevenlabs.io → Profile → API Keys
//   → restart both `bun run dev` (Next.js) and this mini-service afterwards.
//
// When the key is missing this engine REFUSES to synthesize (it never falls
// back silently to a preset voice) — the pipeline surfaces the exact error and
// the text-only result still reaches the UI.
// ─────────────────────────────────────────────────────────────────────────────

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1'

/** Models exposed as the profile "engine" choice (all cross-language). */
export const CLONE_MODELS = {
  balanced: 'eleven_turbo_v2_5', // lower latency, 32 languages (incl. fa/en)
  quality: 'eleven_multilingual_v2', // highest fidelity, slower
} as const

export type CloneModelKey = keyof typeof CLONE_MODELS

const DEFAULT_MODEL_KEY: CloneModelKey = 'balanced'

const SYNTH_RETRIES_MS = [500, 1200, 2600]
const ENROLL_TIMEOUT_MS = 45_000
const SYNTH_TIMEOUT_MS = 30_000

/** ElevenLabs voice_settings.speed accepts 0.7–1.2 on the v2.5 models. */
function clampCloneSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0
  return Math.min(1.2, Math.max(0.7, speed))
}

function clampStability(stability: number | undefined): number {
  if (stability === undefined || !Number.isFinite(stability)) return 0.5
  return Math.min(1, Math.max(0, stability))
}

function clamp01(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/** Provider accepts style 0..0.45 for most models — clamp defensively. */
function clampStyle(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(0.45, Math.max(0, value))
}

/** Resolve the API key from the service env, falling back to the project .env. */
export function getElevenLabsApiKey(): string | null {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    // The mini-service runs with its own cwd — the shared project .env lives
    // one level up. Parse only this one variable; never log its value.
    const envText = readFileSync('/home/z/my-project/.env', 'utf8')
    const match = envText.match(/^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"\r\n#]+)"?\s*$/m)
    if (match) return match[1].trim()
  } catch {
    /* .env absent — not configured */
  }
  return null
}

export function cloneProviderConfigured(): boolean {
  return Boolean(getElevenLabsApiKey())
}

interface ElevenErrorShape {
  detail?: { message?: string; status?: string } | string
}

/** Normalize an ElevenLabs error into an actionable, honest message. */
async function elevenError(res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as ElevenErrorShape
    if (typeof body.detail === 'string') detail = body.detail
    else detail = body.detail?.message ?? body.detail?.status ?? ''
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) return 'ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY in /home/z/my-project/.env and restart the services.'
  if (res.status === 429) return `ElevenLabs rate limit reached (429). ${detail}`.trim()
  if (res.status === 422) return `ElevenLabs rejected the request (422): ${detail || 'invalid audio or parameters'}`
  if (res.status === 404) return `ElevenLabs resource not found (404): ${detail || 'the enrolled voice no longer exists — re-enroll the profile'}`
  return `ElevenLabs error ${res.status}: ${detail || res.statusText}`
}

export interface EnrollResult {
  providerProfileId: string
  requiresVerification: boolean
}

export class ElevenLabsCloneEngine {
  readonly id = 'elevenlabs-ivc'

  /**
   * Create a provider-side cloned voice from one or more WAV samples (Instant
   * Voice Cloning). Multiple takes improve the speaker embedding when the
   * provider merges them — each file must be a valid RIFF/WAV buffer.
   */
  async enroll(name: string, wavs: Buffer | Buffer[]): Promise<EnrollResult> {
    const key = getElevenLabsApiKey()
    if (!key) {
      throw new Error(
        'Voice cloning provider is not configured. Add ELEVENLABS_API_KEY to /home/z/my-project/.env (get a key at elevenlabs.io → API Keys) and restart the app.'
      )
    }

    const samples = (Array.isArray(wavs) ? wavs : [wavs]).slice(0, 3)
    if (samples.length === 0) throw new Error('No voice samples provided for enrollment.')

    const form = new FormData()
    form.append('name', name.slice(0, 60) || 'VoxShift voice')
    samples.forEach((wav, i) => {
      form.append('files', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), `voice-sample-${i + 1}.wav`)
    })

    const res = await fetch(`${ELEVEN_BASE}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(await elevenError(res))
    const body = (await res.json()) as { voice_id?: string; requires_verification?: boolean }
    if (!body.voice_id) throw new Error('ElevenLabs enrollment returned no voice id — the sample may be too short or too noisy.')
    return { providerProfileId: body.voice_id, requiresVerification: Boolean(body.requires_verification) }
  }

  /** Check a provider voice still exists (used to give honest profile status). */
  async voiceExists(providerProfileId: string): Promise<boolean | null> {
    const key = getElevenLabsApiKey()
    if (!key) return null
    try {
      const res = await fetch(`${ELEVEN_BASE}/voices/${providerProfileId}`, {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 404) return false
      return res.ok
    } catch {
      return null // unknown — never claim it is gone
    }
  }

  /**
   * Cross-language synthesis: text (any supported target language) spoken with
   * the enrolled speaker embedding. Returns a 24 kHz WAV buffer.
   */
  async synthesize(
    text: string,
    opts: {
      providerProfileId: string
      speed: number
      providerModel?: string | null
      stability?: number
      /** 0..1 — how strongly to match the enrolled speaker (provider-supported). */
      similarityBoost?: number
      /** 0..0.45 — style exaggeration (provider-supported range). */
      styleExaggeration?: number
      /** Provider speaker-boost flag (default true). */
      useSpeakerBoost?: boolean
    }
  ): Promise<Buffer> {
    const key = getElevenLabsApiKey()
    if (!key) {
      throw new Error(
        'Voice cloning provider is not configured — the profile was NOT used and the default voice was intentionally NOT substituted. Add ELEVENLABS_API_KEY to /home/z/my-project/.env and restart.'
      )
    }
    const modelKey = (opts.providerModel && opts.providerModel in CLONE_MODELS ? opts.providerModel : DEFAULT_MODEL_KEY) as CloneModelKey
    const modelId = CLONE_MODELS[modelKey]
    const payload = {
      text: text.slice(0, 2500),
      model_id: modelId,
      voice_settings: {
        stability: clampStability(opts.stability),
        similarity_boost: clamp01(opts.similarityBoost, 0.8), // favor similarity to the enrolled speaker
        style: clampStyle(opts.styleExaggeration),
        use_speaker_boost: opts.useSpeakerBoost !== false, // +embedding strength at ~100ms latency cost
        speed: clampCloneSpeed(opts.speed),
      },
    }

    let lastErr: unknown
    for (let attempt = 0; attempt <= SYNTH_RETRIES_MS.length; attempt++) {
      try {
        const res = await fetch(
          `${ELEVEN_BASE}/text-to-speech/${opts.providerProfileId}?output_format=pcm_24000`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
          }
        )
        if (!res.ok) throw new Error(await elevenError(res)) // transient→retry below, permanent→honest failure
        const pcm = Buffer.from(await res.arrayBuffer())
        if (pcm.length < 1000) throw new Error('ElevenLabs returned empty audio')
        // Raw PCM s16le mono 24 kHz → wrap into the RIFF/WAV the player expects.
        return pcmToWav(pcm, 24000)
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        const transient = /429|rate|5\d\d|timeout|ECONN|fetch failed|network/i.test(msg)
        if (!transient || attempt === SYNTH_RETRIES_MS.length) break
        await new Promise((r) => setTimeout(r, SYNTH_RETRIES_MS[attempt]))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Cloned-voice synthesis failed')
  }

  /** Delete the provider-side voice (sample + embedding). Best-effort. */
  async deleteVoice(providerProfileId: string): Promise<boolean> {
    const key = getElevenLabsApiKey()
    if (!key) return false
    try {
      const res = await fetch(`${ELEVEN_BASE}/voices/${providerProfileId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(10_000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
