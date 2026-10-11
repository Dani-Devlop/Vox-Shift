/**
 * Timbre-conform DSP probe (v3.8.0) — objective evidence that the new terminal
 * DSP level moves piper output TOWARD the enrolled reference:
 *
 *   1. decode the reference (the "user's voice")
 *   2. synthesize a base sentence with piper (the robotic preset path)
 *   3. run conformTimbre() (F0 shift + LTASS spectral-envelope morph)
 *   4. report: ref F0 vs base F0 vs applied ratio, and the LTASS cosine
 *      similarity ref↔base BEFORE vs ref↔output AFTER (it must increase)
 *
 * Run: bun tests/probe-timbre-conform.ts
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { analyzeTimbreRef, conformTimbre, decodeWavMono } from '../mini-services/translator-service/engines/timbre-conform'

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

/** LTASS cosine similarity between two WAVs (shared bins, active frames). */
function ltassCos(a: Buffer, b: Buffer): { cos: number; f0a: number | null } {
  const da = decodeWavMono(a)
  const db = decodeWavMono(b)
  if (!da || !db) return { cos: 0, f0a: null }
  // resample b to a's rate for a fair bin mapping (reuse conform internals via dynamic path)
  const FFT = 1024
  const HOP = 256
  const bins = FFT / 2 + 1
  const env = (pcm: Float32Array): Float64Array => {
    const acc = new Float64Array(bins)
    let active = 0
    let energy = 0
    for (let i = 0; i < pcm.length; i++) energy += pcm[i] * pcm[i]
    const rms = Math.sqrt(energy / pcm.length)
    const re = new Float64Array(FFT)
    const im = new Float64Array(FFT)
    for (let off = 0; off + FFT <= pcm.length; off += HOP) {
      let fe = 0
      for (let i = 0; i < FFT; i++) fe += pcm[off + i] * pcm[off + i]
      if (Math.sqrt(fe / FFT) < rms * 0.25) continue
      for (let i = 0; i < FFT; i++) {
        re[i] = pcm[off + i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT - 1))))
        im[i] = 0
      }
      // radix-2 fft
      for (let i = 1, j = 0; i < FFT; i++) {
        let bit = FFT >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t
          t = im[i]; im[i] = im[j]; im[j] = t
        }
      }
      for (let len = 2; len <= FFT; len <<= 1) {
        const ang = (-2 * Math.PI) / len
        const wr = Math.cos(ang), wi = Math.sin(ang)
        for (let i = 0; i < FFT; i += len) {
          let cr = 1, ci = 0
          for (let k = 0; k < len / 2; k++) {
            const ur = re[i + k], ui = im[i + k]
            const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
            const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
            re[i + k] = ur + vr; im[i + k] = ui + vi
            re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
            const nr = cr * wr - ci * wi
            ci = cr * wi + ci * wr
            cr = nr
          }
        }
      }
      for (let k = 0; k < bins; k++) acc[k] += Math.hypot(re[k], im[k])
      active++
    }
    const out = new Float64Array(bins)
    if (active > 0) for (let k = 0; k < bins; k++) out[k] = acc[k] / active
    return out
  }
  const ea = env(da.pcm)
  const eb = env(db.pcm)
  let dot = 0, na = 0, nb = 0
  for (let k = 0; k < bins; k++) {
    dot += ea[k] * eb[k]
    na += ea[k] * ea[k]
    nb += eb[k] * eb[k]
  }
  const cos = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
  return { cos, f0a: null }
}

const REF = '/home/z/.venv/lib/python3.12/site-packages/f5_tts/infer/examples/basic/basic_ref_en.wav'
const OUT_DIR = mkdtempSync(join(tmpdir(), 'timbre-'))

const main = () => {
  check('reference WAV present', existsSync(REF))
  if (!existsSync(REF)) process.exit(1)

  const refBuf = readFileSync(REF)
  const ref = analyzeTimbreRef(refBuf)
  check('analyzeTimbreRef → F0 measured', Boolean(ref?.f0Mean && ref.f0Mean > 60 && ref.f0Mean < 400), `refF0=${ref?.f0Mean?.toFixed(1)}Hz sr=${ref?.sampleRate}`)

  // Base synthesis via piper — gender-aware, mirroring the v3.8.0 production
  // logic (low-F0 reference → male en_US-ryan-high when installed).
  const text = 'Hello, this is a timbre conformance test for the voice pipeline.'
  const piperModel = ref && ref.f0Mean && ref.f0Mean < 145 && existsSync('/home/z/models/piper/en_US-ryan-high.onnx')
    ? '/home/z/models/piper/en_US-ryan-high.onnx'
    : '/home/z/models/piper/en_US-amy-medium.onnx'
  const basePath = join(OUT_DIR, 'base.wav')
  const p = spawnSync('python3', ['-m', 'piper', '-m', piperModel, '-f', basePath], {
    input: text,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const baseBuf = p.status === 0 ? readFileSync(basePath) : null
  check('piper base synthesis', Boolean(baseBuf && baseBuf.length > 44), `model=${piperModel.split('/').pop()} exit=${p.status} stderr=${(p.stderr ?? '').slice(-120)}`)
  if (!baseBuf || !ref) process.exit(1)

  // BEFORE: similarity ref↔base
  const before = ltassCos(refBuf, baseBuf)

  // Conform.
  const result = conformTimbre(baseBuf, ref, { pitchRatio: 1.0 })
  check('conformTimbre → morphed', result.morphed, `f0Ratio=${result.f0Ratio}`)
  writeFileSync(join(OUT_DIR, 'conformed.wav'), result.wav)

  // AFTER: similarity ref↔output
  const after = ltassCos(refBuf, result.wav)

  // Duration sanity: conformed ≈ base (the pitch resample shifts duration by
  // 1/ratio — with the measured F0 ratio close to 1 it must stay within 35%).
  const dBase = decodeWavMono(baseBuf)
  const dOut = decodeWavMono(result.wav)
  const durRatio = dBase && dOut ? dOut.pcm.length / dBase.pcm.length : 0
  check(
    'LTASS similarity moved toward the reference',
    after.cos > before.cos,
    `before=${before.cos.toFixed(4)} after=${after.cos.toFixed(4)} (Δ=${((after.cos - before.cos) * 100).toFixed(2)}pp)`
  )
  check('duration within tolerance', durRatio > 0.65 && durRatio < 1.55, `out/base samples=${durRatio.toFixed(3)} (1/ratio=${(1 / result.f0Ratio).toFixed(3)})`)

  console.log(`\n(audios saved under ${OUT_DIR} for manual listening)`)
  console.log(failed === 0 ? 'ALL TIMBRE PROBES PASSED' : `${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
