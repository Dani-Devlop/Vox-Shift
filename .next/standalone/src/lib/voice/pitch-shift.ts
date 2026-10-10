// ─────────────────────────────────────────────────────────────────────────────
// WAV pitch shift (playback-rate resampling) — Next.js-side mirror of the
// mini-service audio-utils resampler. Used by /api/voice-preview so A/B
// auditions reproduce the exact pitch-conformed audio the pipeline generates.
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
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
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
 * Resample a 16-bit PCM mono WAV by `ratio` (>1 = higher pitch + shorter,
 * <1 = lower pitch + longer). Linear interpolation — fine for modest ratios.
 */
export function resampleWav(wav: Buffer, ratio: number): Buffer {
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.005) return wav
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return wav

  const dataChunk = wav.indexOf('data', 12, 'ascii')
  if (dataChunk < 0) return wav
  const pcm = wav.subarray(dataChunk + 8)

  const sampleCount = Math.floor(pcm.length / 2)
  if (sampleCount < 16) return wav

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

/** Clamp a pitch ratio to the quality-safe band (mirrors the voice engine). */
export function clampPitchRatio(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return 1.0
  return Math.min(1.33, Math.max(0.75, ratio))
}
