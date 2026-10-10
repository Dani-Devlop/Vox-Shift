// ─────────────────────────────────────────────────────────────────────────────
// Audio utilities — wrap raw PCM (Int16 LE mono) into a standard WAV container
// and resample WAV audio (pitch-shifting playback-rate change).
// ─────────────────────────────────────────────────────────────────────────────

export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  pcm.copy(buffer, 44)

  return buffer
}

/**
 * Resample a 16-bit PCM mono WAV by `ratio` (>1 = faster playback = higher
 * pitch + shorter duration; <1 = slower = lower pitch + longer duration).
 * Linear interpolation — good quality for modest ratios (|ratio − 1| ≲ 0.35).
 * Returns a fresh WAV with the SAME sample-rate header (duration changes).
 */
export function resampleWav(wav: Buffer, ratio: number): Buffer {
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.005) return wav
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return wav

  const dataChunk = wav.indexOf('data', 12, 'ascii')
  if (dataChunk < 0) return wav
  const pcm = wav.subarray(dataChunk + 8)

  const sampleCount = Math.floor(pcm.length / 2)
  if (sampleCount < 16) return wav

  // Standard PCM WAV: sampleRate lives at byte 24 in the fmt chunk.
  const sampleRate = wav.readUInt32LE(24) || 24000

  const outCount = Math.max(1, Math.floor(sampleCount / ratio))
  const out = Buffer.allocUnsafe(outCount * 2)
  for (let i = 0; i < outCount; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = idx < sampleCount ? pcm.readInt16LE(idx * 2) : 0
    const b = idx + 1 < sampleCount ? pcm.readInt16LE((idx + 1) * 2) : a
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2)
  }
  return pcmToWav(out, sampleRate)
}
