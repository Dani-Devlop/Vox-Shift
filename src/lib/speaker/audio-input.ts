// ─────────────────────────────────────────────────────────────────────────────
// PCM/WAV helpers shared by the voice-contact APIs. Handles both raw PCM
// (browser recorder output, Int16 LE mono) and complete WAV payloads (the
// enrollment sample assembled by the mini-service).
// ─────────────────────────────────────────────────────────────────────────────

export function isWav(bytes: Buffer): boolean {
  return bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
}

export interface DecodedAudio {
  pcm: Buffer // Int16 LE mono
  sampleRate: number
  durationSec: number
}

/**
 * Decode a WAV buffer (16-bit PCM mono/stereo) or treat the input as raw
 * Int16 LE mono PCM at `fallbackSampleRate`. Returns null for junk input.
 */
export function decodeAudioInput(input: Buffer, fallbackSampleRate: number): DecodedAudio | null {
  if (input.length < 32) return null
  if (isWav(input)) {
    const sampleRate = input.readUInt32LE(24) || fallbackSampleRate
    const channels = input.readUInt16LE(22) || 1
    const bits = input.readUInt16LE(34) || 16
    const dataIdx = input.indexOf('data', 12, 'ascii')
    if (dataIdx < 0 || bits !== 16) return null
    let pcm = input.subarray(dataIdx + 8)
    if (channels > 1) {
      // Downmix to mono by averaging channel pairs.
      const frames = Math.floor(pcm.length / 2 / channels)
      const mono = Buffer.allocUnsafe(frames * 2)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2)
        mono.writeInt16LE(Math.round(sum / channels), i * 2)
      }
      pcm = mono
    }
    return { pcm: Buffer.from(pcm), sampleRate, durationSec: pcm.length / 2 / sampleRate }
  }
  // Raw PCM path
  const pcm = input.length % 2 === 0 ? input : input.subarray(0, input.length - 1)
  return { pcm: Buffer.from(pcm), sampleRate: fallbackSampleRate, durationSec: pcm.length / 2 / fallbackSampleRate }
}

export function pcmToInt16(pcm: Buffer): Int16Array {
  const count = Math.floor(pcm.byteLength / 2)
  return new Int16Array(pcm.buffer, pcm.byteOffset, count)
}
