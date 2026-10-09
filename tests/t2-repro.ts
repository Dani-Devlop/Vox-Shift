// Reproduce the T2 scenario: 5 utterances (3 voices) on one socket, full trace.
const { io } = await import('socket.io-client')
import { readFileSync, unlinkSync } from 'fs'

const BASE = 'http://localhost:81'
const t0 = Date.now()
const log = (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', m)

const espeak = (voice: string, text: string): { pcm: Buffer; sampleRate: number } | null => {
  const out = `/tmp/vx-t2-${Math.random().toString(36).slice(2, 8)}.wav`
  const proc = Bun.spawnSync(['espeak-ng', '-v', voice, '-s', '150', '-w', out, text])
  if (proc.exitCode !== 0) return null
  const wav = readFileSync(out)
  unlinkSync(out)
  let pos = 12, fmtRate = 22050, data: Buffer | null = null
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4)
    const size = wav.readUInt32LE(pos + 4)
    if (id === 'fmt ') fmtRate = wav.readUInt32LE(pos + 12)
    else if (id === 'data') { data = wav.subarray(pos + 8, pos + 8 + size); break }
    pos += 8 + size + (size % 2)
  }
  return data ? { pcm: data, sampleRate: fmtRate } : null
}

const segs = [
  espeak('en-us+m1', 'Hello there, how are you today my friend.'),
  espeak('en-us+f2', 'I am doing very well, thank you for asking.'),
  espeak('en-us+m3', 'That is wonderful news for everyone here.'),
  espeak('en-us+m1', 'What shall we do about the plan tomorrow?'),
  espeak('en-us+m3', 'I think we should just wait and see how it goes.'),
]
log(`espeak segments ready: ${segs.filter(Boolean).length}/5`)

const socket = io(`${BASE}/?XTransformPort=3003`, { path: '/', transports: ['websocket'], timeout: 8000 })
let done = 0
const events = ['stage', 'provider.failed', 'provider.fallback', 'utterance:error', 'speaker.changed', 'speaker.started']
for (const ev of events) socket.on(ev, (e: unknown) => log(`${ev}: ${JSON.stringify(e).slice(0, 110)}`))
socket.on('result', (r: { providers?: Record<string, string>; timings?: Record<string, number>; speaker?: { clusterKey?: string } }) => {
  done++
  log(`RESULT #${done} spk=${r.speaker?.clusterKey} providers=${JSON.stringify(r.providers)} timings=${JSON.stringify(r.timings)}`)
  if (done >= 5) { log('ALL 5 RESULTS RECEIVED ✓'); socket.close(); process.exit(0) }
})
socket.on('connect', () => {
  log('connected — sending 5 utterances back to back')
  segs.forEach((s, i) => {
    if (!s) return
    socket.emit('utterance', {
      utteranceId: `t2rep_${i}_${Date.now()}`,
      audioBase64: s.pcm.toString('base64'),
      sampleRate: s.sampleRate,
      sourceLang: 'en',
      targetLang: 'fa',
      style: 'natural',
      voice: 'default',
      speed: 1.0,
      detectionMode: 'auto',
    })
  })
})
setTimeout(() => { log(`*** 240s GUARD — got ${done}/5 ***`); socket.close(); process.exit(2) }, 240000)
