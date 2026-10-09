// ─────────────────────────────────────────────────────────────────────────────
// Server-side ElevenLabs voice-cloning client (Next.js API routes).
// REAL cross-language voice cloning: a Persian-speaking reference sample is
// enrolled once → a persistent provider voice id → English (and other target)
// speech that carries the speaker's timbre, pitch register and style.
//
// SECURITY: the API key lives ONLY on the server (process.env.ELEVENLABS_API_KEY
// loaded from /home/z/my-project/.env). It is never sent to the client, never
// logged, never returned by any route.
// ─────────────────────────────────────────────────────────────────────────────

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1'

export const CLONE_ENGINE_ID = 'elevenlabs-ivc'

/** Models exposed as the profile "engine" choice (all cross-language). */
export const CLONE_MODEL_KEYS = {
  balanced: 'eleven_turbo_v2_5',
  quality: 'eleven_multilingual_v2',
} as const

export type CloneModelKey = keyof typeof CLONE_MODEL_KEYS

export function resolveCloneModel(key?: string | null): string {
  if (key && key in CLONE_MODEL_KEYS) return CLONE_MODEL_KEYS[key as CloneModelKey]
  return CLONE_MODEL_KEYS.balanced
}

/** Is real voice cloning available on this deployment? */
export function cloneConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY)
}

/** Honest, actionable setup steps rendered by the UI when cloning is unavailable. */
export function cloneSetupInstructions() {
  return {
    envVar: 'ELEVENLABS_API_KEY',
    envFile: '/home/z/my-project/.env',
    steps: [
      'Create an account at elevenlabs.io (free tier includes Instant Voice Cloning).',
      'Copy your API key: Profile → API Keys.',
      `Add a line to ${cloneSetupEnvFile()}: ELEVENLABS_API_KEY=your-key-here`,
      'Restart the app and the translator service, then re-enroll your voice.',
    ],
  }
}

function cloneSetupEnvFile(): string {
  return '/home/z/my-project/.env'
}

interface ElevenErrorShape {
  detail?: { message?: string; status?: string } | string
}

async function elevenError(res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as ElevenErrorShape
    if (typeof body.detail === 'string') detail = body.detail
    else detail = body.detail?.message ?? body.detail?.status ?? ''
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401) return 'ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY in /home/z/my-project/.env and restart the services.'
  if (res.status === 429) return `ElevenLabs rate limit reached (429). ${detail}`.trim()
  if (res.status === 422) return `ElevenLabs rejected the sample (422): ${detail || 'audio invalid or too short'}`
  if (res.status === 404) return `ElevenLabs resource not found (404): ${detail || 'the enrolled voice no longer exists — re-enroll the profile'}`
  return `ElevenLabs error ${res.status}: ${detail || res.statusText}`
}

function authHeaders(): HeadersInit {
  return { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' }
}

/** Enroll a WAV sample → provider voice id (Instant Voice Cloning). */
export async function enrollCloneVoice(
  name: string,
  wav: Buffer
): Promise<{ providerProfileId: string; requiresVerification: boolean }> {
  const form = new FormData()
  form.append('name', name.slice(0, 60) || 'VoxShift voice')
  form.append('files', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice-sample.wav')

  const res = await fetch(`${ELEVEN_BASE}/voices/add`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(await elevenError(res))
  const body = (await res.json()) as { voice_id?: string; requires_verification?: boolean }
  if (!body.voice_id) throw new Error('ElevenLabs enrollment returned no voice id — the sample may be too short or too noisy.')
  return { providerProfileId: body.voice_id, requiresVerification: Boolean(body.requires_verification) }
}

/**
 * Synthesize text with a cloned voice. Returns raw PCM s16le 24 kHz wrapped
 * into a RIFF/WAV buffer. Cross-language: any supported target language.
 */
export async function synthesizeCloneVoice(
  text: string,
  opts: { providerProfileId: string; modelKey?: string | null; speed: number; stability: number }
): Promise<Buffer> {
  const payload = {
    text: text.slice(0, 2500),
    model_id: resolveCloneModel(opts.modelKey),
    voice_settings: {
      stability: Math.min(1, Math.max(0, opts.stability || 0.5)),
      similarity_boost: 0.8,
      style: 0.0,
      use_speaker_boost: true,
      speed: Math.min(1.2, Math.max(0.7, Number.isFinite(opts.speed) ? opts.speed : 1)),
    },
  }
  let lastErr: unknown
  const backoff = [500, 1200, 2600]
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const res = await fetch(
        `${ELEVEN_BASE}/text-to-speech/${opts.providerProfileId}?output_format=pcm_24000`,
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (!res.ok) throw new Error(await elevenError(res))
      const pcm = Buffer.from(await res.arrayBuffer())
      if (pcm.length < 1000) throw new Error('ElevenLabs returned empty audio')
      return pcmToWav(pcm, 24000)
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!/429|rate|5\d\d|timeout|ECONN|fetch failed|network/i.test(msg) || attempt === backoff.length) break
      await new Promise((r) => setTimeout(r, backoff[attempt]))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Cloned-voice synthesis failed')
}

/** Delete the provider-side voice. Best-effort; returns success. */
export async function deleteCloneVoice(providerProfileId: string): Promise<boolean> {
  try {
    const res = await fetch(`${ELEVEN_BASE}/voices/${providerProfileId}`, {
      method: 'DELETE',
      headers: authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Does the provider voice still exist? null = unknown (no key / network). */
export async function cloneVoiceExists(providerProfileId: string): Promise<boolean | null> {
  if (!cloneConfigured()) return null
  try {
    const res = await fetch(`${ELEVEN_BASE}/voices/${providerProfileId}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return false
    return res.ok
  } catch {
    return null
  }
}

/** Minimal RIFF/WAV writer for raw 16-bit mono PCM. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + pcm.length)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + pcm.length, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(pcm.length, 40)
  pcm.copy(buffer, 44)
  return buffer
}
