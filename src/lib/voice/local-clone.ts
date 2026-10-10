// ─────────────────────────────────────────────────────────────────────────────
// LOCAL voice-clone client (v3.3.1, Architecture C) — talks to
// mini-services/voice-clone-service (:3010, 127.0.0.1 only).
//
// RECONSTRUCTED after platform reset #3: the original was never committed
// (lost before `git add`), rebuilt to the exact call sites:
//   - src/app/api/voice-profile/clone/route.ts  → localCloneEnroll / Drop / Health
//   - translator-service engines/voice.ts       → localCloneConvert
// Env (see VOICE_CLONING_IMPLEMENTATION.md §Configuration):
//   VOXSHIFT_CLONE_URL          default http://127.0.0.1:3010
//   VOXSHIFT_CLONE_DISABLED     set → every call throws (honest, no fallback)
//   VOXSHIFT_CLONE_TIMEOUT_MS   default 120000
//
// Design rules honored from VOICE_CLONING_AUDIT.md:
//   - honest errors verbatim (no silent fallback to preset voices)
//   - audio is only sent to 127.0.0.1, never logged, never leaves the machine
// ─────────────────────────────────────────────────────────────────────────────

const CLONE_URL = process.env.VOXSHIFT_CLONE_URL || 'http://127.0.0.1:3010'
const TIMEOUT_MS = Number(process.env.VOXSHIFT_CLONE_TIMEOUT_MS) || 120_000

function assertEnabled(): void {
  if (process.env.VOXSHIFT_CLONE_DISABLED) {
    throw new Error(
      'Local voice cloning is disabled on this server (VOXSHIFT_CLONE_DISABLED is set) — no fallback voice was used.'
    )
  }
}

async function callCloneService<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  assertEnabled()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${CLONE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        `voice-clone-service returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`
      )
    }
    const payload = parsed as { error?: string } & Record<string, unknown>
    if (!res.ok) {
      throw new Error(
        typeof payload.error === 'string'
          ? payload.error
          : `voice-clone-service HTTP ${res.status}`
      )
    }
    return payload as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `voice-clone-service timed out after ${TIMEOUT_MS}ms (${method} ${path})`
      )
    }
    if (err instanceof Error && (err.cause as { code?: string } | undefined)?.code === 'ECONNREFUSED') {
      throw new Error(
        'voice-clone-service is not reachable on 127.0.0.1:3010 — start it with bash .zscripts/voice-clone-service.sh (no fallback voice was used).'
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export interface LocalCloneHealth {
  status: string
  modelLoaded: boolean
  device: string
  speakers: string[]
}

export interface LocalCloneEnrollResult {
  ok: boolean
  speakerId: string
  refSeconds: number
  seDims: number
}

/**
 * Extract + persist the tone-color embedding (SE) for `speakerId` from a
 * complete WAV buffer. The audio goes ONLY to the on-box clone service.
 */
export async function localCloneEnroll(
  speakerId: string,
  wav: Buffer
): Promise<LocalCloneEnrollResult> {
  return callCloneService<LocalCloneEnrollResult>('POST', '/enroll', {
    speakerId,
    wavBase64: wav.toString('base64'),
  })
}

/**
 * Convert a base-synthesis WAV buffer to the enrolled speaker's tone color.
 * Returns the converted 22.05 kHz mono WAV buffer.
 */
export async function localCloneConvert(
  speakerId: string,
  wav: Buffer,
  tau?: number
): Promise<Buffer> {
  const res = await callCloneService<{
    wavBase64: string
    sr: number
    convertMs: number
  }>('POST', '/convert', {
    speakerId,
    wavBase64: wav.toString('base64'),
    ...(tau !== undefined ? { tau } : {}),
  })
  return Buffer.from(res.wavBase64, 'base64')
}

/** Right-to-erasure: drop the cached embedding for `speakerId`. */
export async function localCloneDrop(speakerId: string): Promise<void> {
  await callCloneService<{ ok: boolean }>('POST', '/drop', { speakerId })
}

/** Clone-service health (model loaded? enrolled speakers?). */
export async function localCloneHealth(): Promise<LocalCloneHealth> {
  return callCloneService<LocalCloneHealth>('GET', '/health')
}
