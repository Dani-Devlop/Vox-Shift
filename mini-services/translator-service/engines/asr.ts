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

export class ZaiASREngine implements ASREngine {
  readonly id = 'zai-asr'

  async transcribe(wavBase64: string): Promise<string> {
    const zai = await getZAI()
    const response = await zai.audio.asr.create({ file_base64: wavBase64 })
    const text = (response.text ?? '').trim()
    return text
  }
}
