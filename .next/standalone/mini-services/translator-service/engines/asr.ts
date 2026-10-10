import ZAI from 'z-ai-web-dev-sdk'

// ─────────────────────────────────────────────────────────────────────────────
// ASR Engine — Speech-to-Text layer
// Interface is intentionally generic so the implementation can be swapped
// (e.g. Whisper streaming, vendor ASR) without touching the pipeline.
// ─────────────────────────────────────────────────────────────────────────────

export interface ASREngine {
  readonly id: string
  /** @param wavBase64 base64-encoded complete WAV file */
  transcribe(wavBase64: string): Promise<string>
}

// Derive the client type from the factory — `InstanceType<typeof ZAI>` fails
// because the SDK class declares a private constructor.
type ZAIClient = Awaited<ReturnType<typeof ZAI.create>>
let zaiPromise: Promise<ZAIClient> | null = null

export function getZAI() {
  if (!zaiPromise) {
    zaiPromise = ZAI.create()
  }
  return zaiPromise
}

const RETRY_DELAYS_MS = [400, 1000, 2200, 4000]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Retry transient upstream errors (429 rate limit, 5xx, network) with a
 *  backoff ladder (~7.5 s max) — mirrors engines/voice.ts policy so EVERY
 *  cloud leg (ASR / LLM / TTS) survives provider rate-limit bursts instead
 *  of failing the whole utterance on the first 429. */
export async function withTransientRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const transient = /429|rate|too many|5\d\d|timeout|ECONN|fetch failed|network/i.test(msg)
      if (!transient || attempt === RETRY_DELAYS_MS.length) break
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${what} failed`)
}

export class ZaiASREngine implements ASREngine {
  readonly id = 'zai-asr'

  async transcribe(wavBase64: string): Promise<string> {
    const zai = await getZAI()
    const response = await withTransientRetry(
      () => zai.audio.asr.create({ file_base64: wavBase64 }),
      'ASR transcription'
    )
    const text = (response.text ?? '').trim()
    return text
  }
}
