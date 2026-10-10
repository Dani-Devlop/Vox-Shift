/**
 * PRODUCTION E2E — v3.6.0 ASR against the LIVE deployment.
 * Sends REAL synthesized audio through the public socket:
 *   1. pure English utterance  → transcript must be ENGLISH (not fa-garbled)
 *   2. mixed fa+en utterance   → transcript must keep the Persian backbone
 * Run: bun tests/prod-asr-e2e.ts
 */
import { io } from 'socket.io-client'

const BASE = process.env.VOXSHIFT_PROD_BASE ?? 'https://voxshift134.up.railway.app'
const socket = io(`${BASE}/?XTransformPort=3003`, { path: '/', transports: ['websocket'], timeout: 15000 })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function speak(req: { utteranceId: string; audioBase64: string; sampleRate: number }): Promise<{
  sourceText: string
  translatedText: string
  detectedLang?: string
  providers: { asr: string; translate: string; tts: string }
  timings: { totalMs: number }
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('result timeout')), 60_000)
    const onResult = (r: Record<string, unknown>) => {
      clearTimeout(timer)
      socket.off('result', onResult)
      socket.off('utterance:error', onErr)
      resolve(r as never)
    }
    const onErr = (e: { message?: string }) => {
      clearTimeout(timer)
      socket.off('result', onResult)
      socket.off('utterance:error', onErr)
      reject(new Error(e.message ?? 'utterance error'))
    }
    socket.once('result', onResult)
    socket.once('utterance:error', onErr)
    socket.emit('utterance', { ...req, sourceLang: 'auto', targetLang: 'auto', autoPair: 'fa,en', style: 'natural', voice: 'default', speed: 1, detectionMode: 'auto' })
  })
}

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

socket.on('connect', () => console.log(`connected: ${socket.id}`))
socket.on('connect_error', (e: Error) => {
  console.error('connect_error:', e.message)
  process.exit(1)
})

await new Promise<void>((r) => socket.on('connect', r))

try {
  const { execSync } = await import('child_process')
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodasr-'))
  const run = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const synth = (text: string, voice: string, out: string) =>
    run(`/home/z/.venv/bin/python3 -m piper -m /home/z/models/piper/${voice} -f ${out} -- "${text}"`)
  const wavData = (p: string) => fs.readFileSync(p).subarray(44)
  const concatWav = (parts: Buffer[], sr: number, out: string) => {
    const data = Buffer.concat(parts)
    const h = Buffer.alloc(44)
    h.write('RIFF', 0, 'ascii')
    h.writeUInt32LE(36 + data.length, 4)
    h.write('WAVE', 8, 'ascii')
    h.write('fmt ', 12, 'ascii')
    h.writeUInt32LE(16, 16)
    h.writeUInt16LE(1, 20)
    h.writeUInt16LE(1, 22)
    h.writeUInt32LE(sr, 24)
    h.writeUInt32LE(sr * 2, 28)
    h.writeUInt16LE(2, 32)
    h.writeUInt16LE(16, 34)
    h.write('data', 36, 'ascii')
    h.writeUInt32LE(data.length, 40)
    fs.writeFileSync(out, Buffer.concat([h, data]))
  }
  const toPcm16k = (wavPath: string): string => {
    // Decode WAV (16-bit PCM) → resample to 16 kHz raw PCM b64 (pipeline input)
    const buf = fs.readFileSync(wavPath)
    const sr = buf.readUInt32LE(24)
    const data = buf.subarray(44)
    const outSr = 16000
    const n = Math.floor((data.length / 2) * outSr / sr)
    const out = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) {
      const srcIdx = Math.floor(i * sr / outSr) * 2
      out.writeInt16LE(data.readInt16LE(srcIdx), i * 2)
    }
    return out.toString('base64')
  }

  // 1. Pure English → auto mode must detect EN and translate to FA
  synth('What time is our meeting tomorrow morning', 'en_US-amy-medium.onnx', path.join(dir, 'en.wav'))
  const enPcm = toPcm16k(path.join(dir, 'en.wav'))
  const r1 = await speak({ utteranceId: `prod_en_${Date.now()}`, audioBase64: enPcm, sampleRate: 16000 })
  check(
    'PROD: pure English auto → English transcript (NOT fa-garbled)',
    /[a-z]{3,}/i.test(r1.sourceText) && !/[\u0600-\u06FF]/.test(r1.sourceText),
    `asr=${r1.providers.asr} :: "${r1.sourceText.slice(0, 80)}"`
  )
  check('PROD: English translated to Persian', /[\u0600-\u06FF]/.test(r1.translatedText), `"${r1.translatedText.slice(0, 60)}"`)

  // 2. Mixed: fa + en spliced → Persian backbone must survive
  const head = path.join(dir, 'head.wav')
  const mid = path.join(dir, 'mid.wav')
  const tail = path.join(dir, 'tail.wav')
  synth('امروز یک', 'fa_IR-amir-medium.onnx', head)
  synth('meeting', 'en_US-amy-medium.onnx', mid)
  synth('مهم دارم با تیمم', 'fa_IR-amir-medium.onnx', tail)
  const mixed = path.join(dir, 'mixed.wav')
  concatWav([wavData(head), wavData(mid), wavData(tail)], 22050, mixed)
  const mxPcm = toPcm16k(mixed)
  const r2 = await speak({ utteranceId: `prod_mx_${Date.now()}`, audioBase64: mxPcm, sampleRate: 16000 })
  check(
    'PROD: mixed fa+en keeps the Persian backbone',
    /[\u0600-\u06FF]/.test(r2.sourceText) && /امروز|مهم|دارم/.test(r2.sourceText),
    `asr=${r2.providers.asr} :: "${r2.sourceText.slice(0, 90)}"`
  )
  console.log(`  ℹ mixed transcript English capture: ${/[A-Za-z]{3,}/.test(r2.sourceText) ? 'YES' : 'garbled by whisper-tiny (honest vosk-only degradation)'}`)

  fs.rmSync(dir, { recursive: true, force: true })
} catch (err) {
  console.error('E2E error:', err instanceof Error ? err.message : err)
  failed++
}

socket.close()
if (failed > 0) {
  console.error(`\n${failed} PROD E2E check(s) FAILED`)
  process.exit(1)
}
console.log('\nALL PRODUCTION ASR E2E CHECKS PASSED')
process.exit(0)
