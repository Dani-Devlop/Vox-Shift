import { pcmToWav } from './audio-utils'

// ─────────────────────────────────────────────────────────────────────────────
// Timbre-conformed matching (v3.8.0) — the terminal DSP level UPGRADED from
// pitch-only conformance to reference-driven mimicry:
//
//   1. F0 alignment   — measures the reference speaker's mean F0 and the base
//                       (piper) output's mean F0, then playback-rate shifts the
//                       base to the speaker's pitch register.
//   2. Timbre morph   — computes the LONG-TERM AVERAGE SPECTRUM (LTASS) of the
//                       reference and of the base, and applies the smoothed
//                       per-bin magnitude ratio as a static filter to the base
//                       (STFT → gain → overlap-add, phase preserved). This
//                       moves formant energies + spectral tilt toward the
//                       enrolled speaker's timbre — the "sounds like me, not a
//                       robot preset" layer that pitch-only conformance lacks.
//
// Pure TypeScript, zero dependencies, O(n log n). Runs comfortably inside a
// 954 MB container with no RAM floor (the FFT frames are transient). It is
// still NOT a neural voice clone and stays labeled degraded: true — but it is
// the honest best a small container can serve, and measurably closer to the
// speaker than a raw preset.
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE = 1024
const HOP = FFT_SIZE / 4

export interface TimbreAnalysis {
  /** Reference native sample rate (after decode). */
  sampleRate: number
  /** Float32 mono PCM of the reference at its native rate. */
  pcm: Float32Array
  /** Mean F0 of the reference speaker (Hz) or null when unvoiced/too short. */
  f0Mean: number | null
}

export interface TimbreConformResult {
  wav: Buffer
  /** The applied playback-rate pitch ratio (1.0 = no shift). */
  f0Ratio: number
  /** Measured mean F0 of the BASE voice (Hz) — the caller caches it per lang. */
  baseF0: number | null
  /** false → reference was unusable, output equals the base (caller notes it). */
  morphed: boolean
}

// ── WAV decode (PCM16 mono/stereo → Float32 mono) ────────────────────────────

export function decodeWavMono(wav: Buffer): { pcm: Float32Array; sampleRate: number } | null {
  try {
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
    const fmtOff = wav.indexOf('fmt ', 12, 'ascii')
    const dataOff = wav.indexOf('data', 12, 'ascii')
    if (fmtOff < 0 || dataOff < 0) return null
    const audioFormat = wav.readUInt16LE(fmtOff + 8)
    const channels = wav.readUInt16LE(fmtOff + 10)
    const sampleRate = wav.readUInt32LE(fmtOff + 12)
    const bits = wav.readUInt16LE(fmtOff + 22)
    if (audioFormat !== 1 || bits !== 16 || channels < 1) return null
    const data = wav.subarray(dataOff + 8)
    const frames = Math.floor(data.length / (2 * channels))
    if (frames < 16) return null
    const out = new Float32Array(frames)
    if (channels === 1) {
      for (let i = 0; i < frames; i++) out[i] = data.readInt16LE(i * 2) / 32768
    } else {
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < channels; c++) acc += data.readInt16LE((i * channels + c) * 2)
        out[i] = acc / channels / 32768
      }
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null
    return { pcm: out, sampleRate }
  } catch {
    return null
  }
}

// ── Linear resample (Float32 mono) ───────────────────────────────────────────

function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x
  const outLen = Math.max(1, Math.floor((x.length * to) / from))
  const out = new Float32Array(outLen)
  const step = from / to
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = idx < x.length ? x[idx] : 0
    const b = idx + 1 < x.length ? x[idx + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}

// ── FFT (iterative radix-2, in-place) ────────────────────────────────────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]
  fft(re, im)
  for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] = -im[i] / n
  }
}

const HANN = (() => {
  const w = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))
  return w
})()

// ── F0 (median autocorrelation over voiced frames) ───────────────────────────

export function measureF0(x: Float32Array, sampleRate: number): number | null {
  const frame = Math.round(sampleRate * 0.04) // 40 ms
  const hop = Math.round(sampleRate * 0.02) // 20 ms
  if (x.length < frame * 3) return null
  const minLag = Math.floor(sampleRate / 400)
  const maxLag = Math.floor(sampleRate / 60)
  if (maxLag >= frame) return null

  // Global RMS → voiced threshold.
  let energy = 0
  for (let i = 0; i < x.length; i++) energy += x[i] * x[i]
  const rms = Math.sqrt(energy / x.length)
  const thr = rms * 0.35

  const f0s: number[] = []
  for (let off = 0; off + frame <= x.length; off += hop) {
    let e = 0
    for (let i = 0; i < frame; i++) e += x[off + i] * x[off + i]
    if (Math.sqrt(e / frame) < thr) continue
    let best = 0
    let bestLag = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0
      let norm = 0
      for (let i = 0; i + lag < frame; i++) {
        acc += x[off + i] * x[off + i + lag]
        norm += x[off + i + lag] * x[off + i + lag]
      }
      const normAcc = norm > 0 ? acc / Math.sqrt(norm * e) : 0
      if (normAcc > best) {
        best = normAcc
        bestLag = lag
      }
    }
    if (best > 0.35 && bestLag > 0) f0s.push(sampleRate / bestLag)
  }
  if (f0s.length < 8) return null // too few voiced frames — unreliable
  f0s.sort((a, b) => a - b)
  return f0s[Math.floor(f0s.length / 2)]
}

// ── LTASS (long-term average spectrum over active frames) ────────────────────

function ltass(x: Float32Array, sampleRate: number): { env: Float32Array; bins: number } | null {
  if (x.length < FFT_SIZE * 2) return null
  const bins = FFT_SIZE / 2 + 1
  const acc = new Float64Array(bins)
  let active = 0
  let energy = 0
  for (let i = 0; i < x.length; i++) energy += x[i] * x[i]
  const rms = Math.sqrt(energy / x.length)
  if (rms < 1e-4) return null

  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  for (let off = 0; off + FFT_SIZE <= x.length; off += HOP) {
    let fe = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = x[off + i]
      fe += s * s
    }
    if (Math.sqrt(fe / FFT_SIZE) < rms * 0.25) continue // skip silence frames
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = x[off + i] * HANN[i]
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b < bins; b++) acc[b] += Math.hypot(re[b], im[b])
    active++
  }
  if (active < 8) return null
  const env = new Float32Array(bins)
  for (let b = 0; b < bins; b++) env[b] = acc[b] / active
  return { env, bins }
}

function smoothBins(g: Float32Array, width: number): Float32Array {
  const out = new Float32Array(g.length)
  const half = Math.floor(width / 2)
  for (let i = 0; i < g.length; i++) {
    let acc = 0
    let n = 0
    for (let k = Math.max(0, i - half); k <= Math.min(g.length - 1, i + half); k++) {
      acc += g[k]
      n++
    }
    out[i] = acc / n
  }
  return out
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Decode + F0-analyze the enrolled reference WAV (native rate preserved). */
export function analyzeTimbreRef(refWav: Buffer): TimbreAnalysis | null {
  const dec = decodeWavMono(refWav)
  if (!dec || dec.pcm.length < dec.sampleRate * 0.8) return null // < 0.8 s — unusable
  return { sampleRate: dec.sampleRate, pcm: dec.pcm, f0Mean: measureF0(dec.pcm, dec.sampleRate) }
}

/**
 * Conform a base (piper/espeak) WAV toward the reference speaker:
 * playback-rate F0 shift, then static LTASS-ratio timbre morph (phase-safe).
 * `pitchRatio` is the FALLBACK when either F0 measurement fails (the
 * enrollment mapping ratio — user F0 ÷ mapped slot center).
 */
export function conformTimbre(
  baseWav: Buffer,
  ref: TimbreAnalysis,
  opts: { pitchRatio?: number } = {}
): TimbreConformResult {
  const base = decodeWavMono(baseWav)
  if (!base) return { wav: baseWav, f0Ratio: 1, baseF0: null, morphed: false }

  // 1. F0 ratio (reference measured on its native rate; base on its own).
  const baseF0 = measureF0(base.pcm, base.sampleRate)
  const refF0 = ref.f0Mean
  let ratio = 1
  if (refF0 && baseF0 && baseF0 > 0) {
    ratio = refF0 / baseF0
  } else if (opts.pitchRatio && Number.isFinite(opts.pitchRatio) && opts.pitchRatio > 0) {
    ratio = opts.pitchRatio
  }
  ratio = Math.min(1.33, Math.max(0.75, ratio))

  // 2. Playback-rate pitch shift (formants shift with it — step 3 corrects).
  const shifted = resampleLinear(base.pcm, base.sampleRate, base.sampleRate / ratio)

  // 3. Timbre morph: gain = refEnv / baseEnv (full envelope match), clamped
  //    + bin-smoothed. (v3.8.0 probe fix: exponent 1.0 — the partial 0.7 left
  //    30% of the resample-induced envelope drift uncorrected and LTASS
  //    similarity measurably DROPPED; full match recovers it exactly.)
  const refAtSr = resampleLinear(ref.pcm, ref.sampleRate, base.sampleRate)
  const refSpec = ltass(refAtSr, base.sampleRate)
  const baseSpec = ltass(shifted, base.sampleRate)
  let out = shifted
  let morphed = false
  if (refSpec && baseSpec) {
    const gains = new Float32Array(refSpec.bins)
    for (let b = 0; b < refSpec.bins; b++) {
      const r = baseSpec.env[b] > 1e-6 ? refSpec.env[b] / baseSpec.env[b] : 1
      gains[b] = Math.min(4, Math.max(0.25, r))
    }
    const smoothed = smoothBins(gains, 9)
    out = stftMorph(shifted, smoothed)
    morphed = true
  }

  // 4. RMS normalize back to the base's loudness (the filter changes energy).
  let outE = 0
  for (let i = 0; i < out.length; i++) outE += out[i] * out[i]
  let baseE = 0
  for (let i = 0; i < base.pcm.length; i++) baseE += base.pcm[i] * base.pcm[i]
  const gain = outE > 0 && baseE > 0 ? Math.sqrt(baseE / out.length / (outE / out.length)) : 1
  const g = Math.min(4, Math.max(0.25, gain))

  const pcm = Buffer.allocUnsafe(out.length * 2)
  for (let i = 0; i < out.length; i++) {
    const v = Math.round(Math.min(1, Math.max(-1, out[i] * g)) * 32767)
    pcm.writeInt16LE(v, i * 2)
  }
  return { wav: pcmToWav(pcm, base.sampleRate), f0Ratio: Number(ratio.toFixed(3)), baseF0: baseF0, morphed }
}

/** Static per-bin gain applied through STFT/OLA (phase preserved). */
function stftMorph(x: Float32Array, gains: Float32Array): Float32Array {
  const bins = FFT_SIZE / 2 + 1
  const out = new Float64Array(x.length + FFT_SIZE)
  const norm = new Float64Array(x.length + FFT_SIZE)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  for (let off = 0; off + FFT_SIZE <= x.length; off += HOP) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = x[off + i] * HANN[i]
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b < bins; b++) {
      const g = gains[Math.min(b, gains.length - 1)]
      re[b] *= g
      im[b] *= g
      if (b > 0 && b < bins - 1) {
        re[FFT_SIZE - b] *= g
        im[FFT_SIZE - b] *= g
      }
    }
    ifft(re, im)
    for (let i = 0; i < FFT_SIZE; i++) {
      out[off + i] += re[i] * HANN[i]
      norm[off + i] += HANN[i] * HANN[i]
    }
  }
  const res = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) res[i] = norm[i] > 1e-9 ? out[i] / norm[i] : x[i]
  return res
}
