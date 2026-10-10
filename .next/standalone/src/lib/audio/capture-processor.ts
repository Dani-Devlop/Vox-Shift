// ─────────────────────────────────────────────────────────────────────────────
// AudioWorklet processor source — captures raw mic PCM in fixed-size chunks
// and posts them to the main thread for VAD segmentation + resampling.
// Loaded at runtime via Blob URL (keeps everything in one TS module).
// ─────────────────────────────────────────────────────────────────────────────

export const CAPTURE_PROCESSOR_NAME = 'live-capture-processor'

export const CAPTURE_PROCESSOR_SOURCE = /* js */ `
class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._chunks = []
    this._buffered = 0
    this._chunkSize = 2048 // ~42ms @48kHz
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input[0] && input[0].length > 0) {
      // Downmix to mono (first channel) — mic is mono anyway
      const channel = input[0]
      this._chunks.push(new Float32Array(channel))
      this._buffered += channel.length

      if (this._buffered >= this._chunkSize) {
        const merged = new Float32Array(this._buffered)
        let offset = 0
        for (const c of this._chunks) {
          merged.set(c, offset)
          offset += c.length
        }
        this.port.postMessage(merged, [merged.buffer])
        this._chunks = []
        this._buffered = 0
      }
    }
    return true
  }
}
registerProcessor('${CAPTURE_PROCESSOR_NAME}', LiveCaptureProcessor)
`
