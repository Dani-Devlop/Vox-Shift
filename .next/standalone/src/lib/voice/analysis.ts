// ─────────────────────────────────────────────────────────────────────────────
// Voice profile analysis (pure TypeScript, runs server-side).
// Extracts acoustic features from a raw PCM voice sample:
//   - Fundamental frequency (F0) via time-domain autocorrelation
//   - Spectral centroid (brightness) via radix-2 FFT
//   - Speaking rate via syllable-nuclei peak counting on the energy envelope
// These features drive the mapping to the closest engine voice (mapping.ts).
// The analyzer is engine-agnostic: swapping the Voice Engine only requires a
// new mapping table, not a new analysis.
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceFeatures {
  meanF0: number
  f0Std: number
  f0Min: number
  f0Max: number
  spectralCentroid: number
  speakingRate: number // syllables / second
  voicedRatio: number
  durationSec: number
  // ── Sample-quality diagnostics (§5.2 enrollment feedback) ──
  /** Fraction of samples at ≥97% full scale (0 = clean, >0.005 = clipping). */
  clippingRatio: number
  /** 10th-percentile frame RMS — quietest background level (linear 0..1). */
  noiseFloorRms: number
  /** Voiced level vs noise floor in dB — <12 dB warns of a noisy room. */
  snrDb: number
}

const FRAME_SEC = 0.04 // 40 ms analysis frames
const HOP_SEC = 0.02 // 20 ms hop
const MIN_F0 = 60
const MAX_F0 = 400

function rms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

/**
 * Autocorrelation pitch detection for one frame.
 * Returns F0 in Hz or 0 if unvoiced/uncertain.
 */
function detectF0(frame: Float32Array, sampleRate: number): number {
  const n = frame.length
  const minLag = Math.floor(sampleRate / MAX_F0)
  const maxLag = Math.floor(sampleRate / MIN_F0)
  if (maxLag >= n) return 0

  // Remove DC
  let mean = 0
  for (let i = 0; i < n; i++) mean += frame[i]
  mean /= n

  let energy = 0
  for (let i = 0; i < n; i++) {
    const v = frame[i] - mean
    energy += v * v
  }
  if (energy < 1e-6) return 0

  let bestLag = -1
  let bestCorr = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < n - lag; i++) {
      corr += (frame[i] - mean) * (frame[i + lag] - mean)
    }
    const norm = corr / energy // normalized autocorrelation
    if (norm > bestCorr) {
      bestCorr = norm
      bestLag = lag
    }
  }

  // Confidence threshold: clear periodicity required
  if (bestLag <= 0 || bestCorr < 0.5) return 0
  return sampleRate / bestLag
}

/** Iterative radix-2 FFT (in-place) on real signal padded to power of two. */
function fftMagnitude(re: Float32Array, im: Float32Array): void {
  const n = re.length
  // Bit reversal
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

function spectralCentroidOf(frame: Float32Array, sampleRate: number): number {
  const N = 512
  const buf = new Float32Array(N)
  const step = Math.min(frame.length, N)
  for (let i = 0; i < step; i++) {
    // Hann window
    buf[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (step - 1 || 1)))
  }
  const re = Float32Array.from(buf)
  const im = new Float32Array(N)
  fftMagnitude(re, im)

  let num = 0
  let den = 0
  const halfN = N / 2
  for (let k = 1; k < halfN; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    const freq = (k * sampleRate) / N
    num += freq * mag
    den += mag
  }
  return den > 0 ? num / den : 0
}

/**
 * Count syllable nuclei: local maxima of the smoothed energy envelope that
 * stand out from the local baseline. A rough but useful tempo estimate.
 */
function estimateSpeakingRate(envelope: Float32Array, hopSec: number, voicedFrames: number): number {
  if (envelope.length < 8) return 0
  // Smooth with ~100ms window
  const win = Math.max(3, Math.round(0.1 / hopSec))
  const smooth = new Float32Array(envelope.length)
  for (let i = 0; i < envelope.length; i++) {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - win); j <= Math.min(envelope.length - 1, i + win); j++) {
      s += envelope[j]
      c++
    }
    smooth[i] = s / c
  }
  const peakWin = Math.round(0.115 / hopSec) // min distance between syllable peaks
  let peaks = 0
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1]) {
      // Require a local prominence
      let isPeak = true
      for (let j = Math.max(0, i - peakWin); j <= Math.min(smooth.length - 1, i + peakWin); j++) {
        if (smooth[j] > smooth[i]) {
          isPeak = false
          break
        }
      }
      if (isPeak) peaks++
    }
  }
  const voicedSec = voicedFrames * hopSec
  return voicedSec > 0.3 ? peaks / voicedSec : 0
}

export function analyzePcm(int16: Int16Array, sampleRate: number): VoiceFeatures {
  const samples = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768

  const frameLen = Math.round(FRAME_SEC * sampleRate)
  const hopLen = Math.round(HOP_SEC * sampleRate)
  const frameCount = Math.max(0, Math.floor((samples.length - frameLen) / hopLen) + 1)

  // Global silence threshold relative to loudest frame
  let peakRms = 0
  const frameRms: number[] = []
  for (let f = 0; f < frameCount; f++) {
    const frame = samples.subarray(f * hopLen, f * hopLen + frameLen)
    const r = rms(frame)
    frameRms.push(r)
    if (r > peakRms) peakRms = r
  }
  const silenceThreshold = Math.max(0.012, peakRms * 0.16)

  const f0s: number[] = []
  const centroids: number[] = []
  const envelope = new Float32Array(frameCount)
  let voicedFrames = 0

  for (let f = 0; f < frameCount; f++) {
    const frame = samples.subarray(f * hopLen, f * hopLen + frameLen)
    const r = frameRms[f]
    envelope[f] = r
    if (r < silenceThreshold) continue
    voicedFrames++

    const f0 = detectF0(frame, sampleRate)
    if (f0 > 0) f0s.push(f0)

    const centroid = spectralCentroidOf(frame, sampleRate)
    if (centroid > 0) centroids.push(centroid)
  }

  const durationSec = samples.length / sampleRate

  if (f0s.length < 5 || voicedFrames < 8) {
    // Not enough voiced material — return neutral features
    return {
      meanF0: 0,
      f0Std: 0,
      f0Min: 0,
      f0Max: 0,
      spectralCentroid: centroids.length ? centroids.reduce((a, b) => a + b, 0) / centroids.length : 0,
      speakingRate: estimateSpeakingRate(envelope, HOP_SEC, voicedFrames),
      voicedRatio: frameCount ? voicedFrames / frameCount : 0,
      durationSec,
      ...qualityMetrics(samples, frameRms, silenceThreshold),
    }
  }

  const meanF0 = f0s.reduce((a, b) => a + b, 0) / f0s.length
  const variance = f0s.reduce((a, b) => a + (b - meanF0) ** 2, 0) / f0s.length
  const f0Std = Math.sqrt(variance)

  return {
    meanF0,
    f0Std,
    f0Min: Math.min(...f0s),
    f0Max: Math.max(...f0s),
    spectralCentroid: centroids.length ? centroids.reduce((a, b) => a + b, 0) / centroids.length : 0,
    speakingRate: estimateSpeakingRate(envelope, HOP_SEC, voicedFrames),
    voicedRatio: frameCount ? voicedFrames / frameCount : 0,
    durationSec,
    ...qualityMetrics(samples, frameRms, silenceThreshold),
  }
}

/**
 * Sample-quality diagnostics for enrollment feedback (§5.2): clipping,
 * background noise floor and an approximate signal-to-noise ratio.
 */
function qualityMetrics(samples: Float32Array, frameRms: number[], silenceThreshold: number) {
  // Clipping: samples within 3% of full scale (counted on |x|).
  let clipped = 0
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i]
    if (a >= 0.97) clipped++
  }
  const clippingRatio = samples.length ? clipped / samples.length : 0

  // Noise floor: 10th percentile of frame RMS (quietest background).
  const sorted = [...frameRms].sort((a, b) => a - b)
  const noiseFloorRms = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0] : 0

  // SNR: mean level of frames above the speech threshold vs the noise floor.
  const voiced = frameRms.filter((r) => r >= silenceThreshold)
  const voicedMean = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 0
  const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-6))
  const snrDb = noiseFloorRms > 0 && voicedMean > 0 ? Math.max(0, toDb(voicedMean) - toDb(noiseFloorRms)) : 0

  return { clippingRatio, noiseFloorRms, snrDb }
}

/** Decode base64 raw PCM (Int16 LE) into an Int16Array. */
export function base64ToPcm(base64: string): Int16Array {
  const buffer = Buffer.from(base64, 'base64')
  const len = Math.floor(buffer.length / 2)
  const out = new Int16Array(len)
  for (let i = 0; i < len; i++) out[i] = buffer.readInt16LE(i * 2)
  return out
}
