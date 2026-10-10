/** Debug: print raw whisper + vosk results for a synthesized mixed clip. */
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'asrdebug-'))
const run = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const synth = (text: string, voice: string, out: string) =>
  run(`/home/z/.venv/bin/python3 -m piper -m /home/z/models/piper/${voice} -f ${out} -- "${text}"`)
const wavData = (p: string) => readFileSync(p).subarray(44)
const concatWav = (parts: Buffer[], sr: number, out: string) => {
  const data = Buffer.concat(parts)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sr, 24)
  header.writeUInt32LE(sr * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  writeFileSync(out, Buffer.concat([header, data]))
}

const faWav = join(dir, 'fa.wav')
const enWav = join(dir, 'en.wav')
synth('امروز هوا آفتابی است و من خوشحالم', 'fa_IR-amir-medium.onnx', faWav)
synth('I have a meeting tomorrow at nine', 'en_US-amy-medium.onnx', enWav)
const mixed = join(dir, 'mixed.wav')
concatWav([wavData(faWav), wavData(enWav)], 22050, mixed)
const b64 = readFileSync(mixed).toString('base64')

const { whisperTranscribe } = await import('../mini-services/translator-service/engines/local-asr')
const r1 = await whisperTranscribe(b64, 'tiny', { lang: null, timeoutMs: 45_000 })
console.log('WHISPER#1:', JSON.stringify({ lang: r1.lang, text: r1.text.slice(0, 90), words: r1.words.length }))
const r2 = await whisperTranscribe(b64, 'tiny', { lang: null, timeoutMs: 45_000 })
console.log('WHISPER#2:', JSON.stringify({ lang: r2.lang, text: r2.text.slice(0, 90) }))
rmSync(dir, { recursive: true, force: true })
process.exit(0)
