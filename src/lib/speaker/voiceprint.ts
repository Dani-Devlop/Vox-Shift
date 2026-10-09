// ─────────────────────────────────────────────────────────────────────────────
// Voiceprint — LOCAL-FIRST speaker recognition (master prompt v2 §16/§25).
//
// A voiceprint is a fixed-length acoustic vector describing WHO is speaking:
//   · 24 mean log-mel band energies, MEAN-CENTERED (relative spectral shape —
//     the formant/timbre fingerprint; absolute level carries no identity)
//   · 24 std-dev of log-mel energies  (timbre dynamics across speech)
//   · 8-dim log-F0 kernel signature   (pitch register — near-orthogonal for
//     distant F0s so pitch differences actually move cosine similarity)
//   · F0 variability + spectral centroid
// → group-balanced, L2-normalized, compared with cosine similarity.
//
// HONESTY (spec: never overstate capability): this is a classic DSP voiceprint
// (mel statistics + pitch statistics), NOT a deep x-vector/d-vector neural
// embedding. It runs anywhere (CPU, milliseconds, zero dependencies, zero
// cloud) and reliably distinguishes people with different pitch/timbre, but it
// is weaker for near-identical voices and noisy channels. The UI labels the
// confidence honestly and the core rule is "Unknown is better than wrong".
//
// Pure functions only — no DOM, no Node APIs — so the SAME file runs in the
// browser, the Next.js server, and the bun mini-service.
// ─────────────────────────────────────────────────────────────────────────────

export const VOICEPRINT_DIM = 57 // 24 melMeans + 24 melStds + 8 pitchKernel + 1 f0Std

/** Analysis constants. */
const FRAME_MS = 32
const HOP_MS = 16
const FFT_SIZE = 512
const MEL_BANDS = 24
const MEL_FMIN = 80
const MEL_FMAX = 4000
const F0_MIN = 60
const F0_MAX = 400
/** Triangular kernel bands over log2(F0) — 60..400 Hz. */
const PITCH_BANDS = 8

/** Default similarity thresholds (cosine). Contacts can override theirs. */
export const DEFAULT_MATCH_THRESHOLD = 0.9 // ≥ → verified contact
export const AMBIGUOUS_MARGIN = 0.012 // top-2 within margin → ambiguous
export const CLUSTER_MERGE_THRESHOLD = 0.88 // ≥ → same unknown speaker
export const HYSTERESIS_THRESHOLD = 0.86 // ≥ → keep previous speaker

export interface VoiceprintQuality {
  durationSec: number
  speechSec: number
  speechFrames: number
  meanF0: number
  f0Std: number
  snrDb: number
}

export interface Voiceprint {
  vector: Float32Array | number[]
  quality: VoiceprintQuality
}

// ── FFT (iterative radix-2, in-place) ────────────────────────────────────────

function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  // Bit-reversal permutation
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
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const vIm = re[i + k + half] * curRe + im[i + k + half] * curIm
        re[i + k] = uRe + vRe
        im[i + k] = uIm - 0 + vIm
        re[i + k + half] = uRe - vRe
        im[i + k + half] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

// ── Mel filterbank (24 triangular bands, 80–4000 Hz) ────────────────────────

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1)

let filterbankCache: { centers: number[]; weights: Float32Array[] } | null = null

function getFilterbank(): { centers: number[]; weights: Float32Array[] } {
  if (filterbankCache) return filterbankCache
  const binCount = FFT_SIZE / 2
  const hzPerBin = (16000 / 2) / binCount // design rate is fixed for cache reuse
  const melMin = hzToMel(MEL_FMIN)
  const melMax = hzToMel(MEL_FMAX)
  const edges: number[] = []
  for (let i = 0; i < MEL_BANDS + 2; i++) {
    edges.push(melToHz(melMin + ((melMax - melMin) * i) / (MEL_BANDS + 1)))
  }
  const centers: number[] = []
  const weights: Float32Array[] = []
  for (let b = 0; b < MEL_BANDS; b++) {
    const lo = edges[b] / hzPerBin
    const mid = edges[b + 1] / hzPerBin
    const hi = edges[b + 2] / hzPerBin
    const w = new Float32Array(binCount)
    for (let k = 0; k < binCount; k++) {
      if (k >= lo && k <= mid && mid > lo) w[k] = (k - lo) / (mid - lo)
      else if (k > mid && k <= hi && hi > mid) w[k] = (hi - k) / (hi - mid)
    }
    centers.push((edges[b + 1] + 1) / 2)
    weights.push(w)
  }
  filterbankCache = { centers, weights }
  return filterbankCache
}

// ── Core extraction ──────────────────────────────────────────────────────────

/**
 * Compute a voiceprint from raw PCM (Int16 LE mono, any rate ≤ 24 kHz —
 * the live pipeline sends 16 kHz). Returns null when the audio has too
 * little usable speech (caller must then NOT claim any identification).
 */
export function computeVoiceprint(pcm: Int16Array | Float32Array, sampleRate: number): Voiceprint | null {
  const ANALYSIS_RATE = 16000

  // ── Normalize input: Int16 → float, resample any rate to 16 kHz ──────────
  // (The live pipeline already sends 16 kHz; API uploads may be 22.05/44.1 k.
  //  The FFT frame is sized for 16 kHz, so we linearly resample — quality is
  //  more than sufficient for speaker statistics.)
  let x: Float32Array
  let rate = sampleRate
  const n0 = pcm.length
  if (n0 === 0) return null
  if (pcm instanceof Float32Array) {
    x = pcm
  } else {
    x = new Float32Array(n0)
    for (let i = 0; i < n0; i++) x[i] = pcm[i] / 32768
  }
  if (rate !== ANALYSIS_RATE && rate > 4000) {
    const outLen = Math.max(1, Math.floor((n0 * ANALYSIS_RATE) / rate))
    const y = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const pos = (i * rate) / ANALYSIS_RATE
      const idx = Math.floor(pos)
      const frac = pos - idx
      const a = idx < n0 ? x[idx] : 0
      const b = idx + 1 < n0 ? x[idx + 1] : a
      y[i] = a + (b - a) * frac
    }
    x = y
    rate = ANALYSIS_RATE
  }

  const n = x.length
  const durationSec = n / rate
  if (durationSec < 0.4) return null

  // Gentle normalize so level differences do not dominate the timbre stats.
  let peak = 1e-9
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i])
    if (a > peak) peak = a
  }
  if (peak > 0.001 && peak < 1) {
    const g = 0.89 / peak
    for (let i = 0; i < n; i++) x[i] *= g
  }

  const frameLen = Math.round((FRAME_MS / 1000) * rate)
  const hopLen = Math.round((HOP_MS / 1000) * rate)
  if (frameLen < 64 || frameLen > FFT_SIZE) return null

  // Hann window sized to the frame (zero-padded into the FFT).
  const win = new Float32Array(frameLen)
  for (let i = 0; i < frameLen; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameLen - 1))

  // Energy profile for VAD gating + SNR estimate.
  const frameCount = Math.max(1, Math.floor((n - frameLen) / hopLen) + 1)
  const energies = new Float32Array(frameCount)
  for (let f = 0; f < frameCount; f++) {
    let e = 0
    const off = f * hopLen
    for (let i = 0; i < frameLen; i += 2) {
      const v = off + i < n ? x[off + i] : 0
      e += v * v
    }
    energies[f] = e / (frameLen / 2)
  }
  const sortedE = Array.from(energies).sort((a, b) => a - b)
  const noiseFloor = Math.max(1e-10, sortedE[Math.floor(frameCount * 0.1)])
  const speechLevel = Math.max(1e-10, sortedE[Math.floor(frameCount * 0.9)])
  const snrDb = 10 * Math.log10(speechLevel / noiseFloor)

  // Speech-gate: frames ≥ (noiseFloor × 3.2) count as speech.
  const gate = noiseFloor * 3.2 + 1e-7
  const { weights } = getFilterbank()

  const melSum = new Float64Array(MEL_BANDS)
  const melSqSum = new Float64Array(MEL_BANDS)
  let centroidSum = 0
  let speechFrames = 0
  const f0s: number[] = []
  const binHz = rate / FFT_SIZE

  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)

  for (let f = 0; f < frameCount; f++) {
    if (energies[f] < gate) continue
    speechFrames++
    const off = f * hopLen
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < frameLen; i++) re[i] = (off + i < n ? x[off + i] : 0) * win[i]
    fftInPlace(re, im)

    // Mel band energies (power spectrum, log-compressed).
    const mels = new Float64Array(MEL_BANDS)
    let centroidNum = 0
    let centroidDen = 0
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / (FFT_SIZE * FFT_SIZE)
      const hz = k * binHz
      if (hz <= MEL_FMAX) {
        centroidNum += hz * p
        centroidDen += p
      }
      for (let b = 0; b < MEL_BANDS; b++) {
        const w = weights[b][k]
        if (w > 0) mels[b] += w * p
      }
    }
    for (let b = 0; b < MEL_BANDS; b++) {
      const logE = Math.log10(mels[b] + 1e-10)
      melSum[b] += logE
      melSqSum[b] += logE * logE
    }
    centroidSum += centroidDen > 0 ? centroidNum / centroidDen : 0

    // F0 via autocorrelation on the raw frame — pitch is the dominant cue
    // for telling two people apart, measured per speech frame. Octave-error
    // guard: among lags scoring ≥ 92% of the best correlation, prefer the
    // LOWEST frequency (largest lag) — harmonics otherwise win.
    const lagMin = Math.floor(rate / F0_MAX)
    const lagMax = Math.min(frameLen - 2, Math.ceil(rate / F0_MIN))
    let e0x = 0
    for (let i = 0; i < frameLen; i++) {
      const v = off + i < n ? x[off + i] : 0
      e0x += v * v
    }
    if (e0x > 1e-9 && lagMax > lagMin) {
      let bestCorr = 0
      const corrs = new Float32Array(lagMax - lagMin + 1)
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let corr = 0
        for (let i = 0; i < frameLen - lag; i++) {
          const a = off + i < n ? x[off + i] : 0
          const b = off + i + lag < n ? x[off + i + lag] : 0
          corr += a * b
        }
        const norm = corr / e0x
        corrs[lag - lagMin] = norm
        if (norm > bestCorr) bestCorr = norm
      }
      if (bestCorr > 0.35) {
        let chosenLag = -1
        for (let lag = lagMax; lag >= lagMin; lag--) {
          if (corrs[lag - lagMin] >= bestCorr * 0.92) {
            chosenLag = lag
            break
          }
        }
        if (chosenLag > 0) f0s.push(rate / chosenLag)
      }
    }
  }

  if (speechFrames < 6) return null // < ~100 ms of actual speech — unusable

  const meanF0 = f0s.length ? f0s.reduce((a, b) => a + b, 0) / f0s.length : 0
  const f0Std =
    f0s.length > 1 ? Math.sqrt(f0s.reduce((acc, v) => acc + (v - meanF0) ** 2, 0) / f0s.length) : 0

  // Assemble the vector with GROUP BALANCE so each cue family contributes:
  //   [24 centered melMeans | 24 melStds | 8 log-F0 kernel | 1 f0Std]
  // Group weights: mel-shape 0.50, mel-dynamics 0.20, pitch 0.26, rest 0.04.
  const raw = new Float32Array(VOICEPRINT_DIM)
  for (let b = 0; b < MEL_BANDS; b++) {
    const mean = melSum[b] / speechFrames
    const varr = Math.max(0, melSqSum[b] / speechFrames - mean * mean)
    raw[b] = mean
    raw[MEL_BANDS + b] = Math.sqrt(varr)
  }
  // Mean-center the mel means (level invariance) before weighting.
  let melMeanOfMeans = 0
  for (let b = 0; b < MEL_BANDS; b++) melMeanOfMeans += raw[b]
  melMeanOfMeans /= MEL_BANDS
  for (let b = 0; b < MEL_BANDS; b++) raw[b] -= melMeanOfMeans

  // Log-F0 triangular kernel signature: a peak centered at meanF0 spread
  // over 8 log2-spaced bands (60..400 Hz). Two voices with distant pitch
  // registers land on nearly disjoint bands → genuinely lower similarity.
  {
    const pitchBase = 2 * MEL_BANDS
    const loOct = Math.log2(F0_MIN)
    const hiOct = Math.log2(F0_MAX)
    const step = (hiOct - loOct) / (PITCH_BANDS - 1)
    const f0 = Math.max(F0_MIN, Math.min(F0_MAX, meanF0))
    const oct = Math.log2(f0)
    for (let b = 0; b < PITCH_BANDS; b++) {
      const d = Math.abs(oct - (loOct + b * step))
      raw[pitchBase + b] = Math.max(0, 1 - d / step) // triangular kernel
    }
    raw[pitchBase + PITCH_BANDS] = Math.min(1, f0Std / 200)
  }
  raw[2 * MEL_BANDS + PITCH_BANDS + 1] = Math.min(1, (centroidSum / speechFrames) / 4000)

  // Apply group weights then L2 normalize → cosine similarity = dot product.
  const wMelMean = 0.5 / MEL_BANDS
  const wMelStd = 0.2 / MEL_BANDS
  const wPitch = 0.22 / PITCH_BANDS
  const vector = new Float32Array(VOICEPRINT_DIM)
  for (let b = 0; b < MEL_BANDS; b++) {
    vector[b] = raw[b] * wMelMean
    vector[MEL_BANDS + b] = raw[MEL_BANDS + b] * wMelStd
  }
  const pitchBase = 2 * MEL_BANDS
  for (let b = 0; b < PITCH_BANDS; b++) vector[pitchBase + b] = raw[pitchBase + b] * wPitch
  vector[pitchBase + PITCH_BANDS] = raw[pitchBase + PITCH_BANDS] * 0.03
  vector[pitchBase + PITCH_BANDS + 1] = raw[pitchBase + PITCH_BANDS + 1] * 0.05

  let norm = 0
  for (let i = 0; i < VOICEPRINT_DIM; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm < 1e-9) return null
  for (let i = 0; i < VOICEPRINT_DIM; i++) vector[i] /= norm

  return {
    vector,
    quality: {
      durationSec: Number(durationSec.toFixed(2)),
      speechSec: Number(((speechFrames * HOP_MS) / 1000).toFixed(2)),
      speechFrames,
      meanF0: Number(meanF0.toFixed(1)),
      f0Std: Number(f0Std.toFixed(1)),
      snrDb: Number(snrDb.toFixed(1)),
    },
  }
}

/** Cosine similarity of two equal-length vectors (both L2-normalized → dot). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na < 1e-12 || nb < 1e-12) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface MatchCandidate {
  id: string
  name: string
  vector: ArrayLike<number>
  threshold?: number
}

export interface MatchOutcome {
  best: { id: string; name: string; score: number } | null
  second: { id: string; name: string; score: number } | null
  /** 'verified' | 'ambiguous' | 'none' */
  verdict: 'verified' | 'ambiguous' | 'none'
}

/**
 * Match a query voiceprint against enrolled contacts.
 * verdict:
 *  - 'verified'  → best ≥ best.threshold (margin over second OK)
 *  - 'ambiguous' → threshold met but top-2 too close (spec §14: never guess)
 *  - 'none'      → below threshold → treat as Unknown speaker
 */
export function matchVoiceprint(query: ArrayLike<number>, refs: MatchCandidate[]): MatchOutcome {
  const scored = refs
    .map((r) => ({ id: r.id, name: r.name, score: cosineSimilarity(query, r.vector), threshold: r.threshold }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return { best: null, second: null, verdict: 'none' }
  const top = scored[0]
  const second = scored[1] ?? null
  const thr = top.threshold ?? DEFAULT_MATCH_THRESHOLD
  if (top.score >= thr) {
    const ambiguous = second !== null && top.score - second.score < AMBIGUOUS_MARGIN
    return {
      best: { id: top.id, name: top.name, score: top.score },
      second: second ? { id: second.id, name: second.name, score: second.score } : null,
      verdict: ambiguous ? 'ambiguous' : 'verified',
    }
  }
  return {
    best: { id: top.id, name: top.name, score: top.score },
    second: second ? { id: second.id, name: second.name, score: second.score } : null,
    verdict: 'none',
  }
}

/** Parse a stored embeddingJson into a float array (null when corrupt). */
export function parseVoiceprintJson(json: string | null | undefined): number[] | null {
  if (!json) return null
  try {
    const arr = JSON.parse(json)
    if (Array.isArray(arr) && arr.length === VOICEPRINT_DIM && arr.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return arr as number[]
    }
  } catch {
    /* corrupt row — ignore */
  }
  return null
}
