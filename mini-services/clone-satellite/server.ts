// ─────────────────────────────────────────────────────────────────────────────
// VoxShift CLONE SATELLITE (v3.8.0) — run the REAL local cloning engines
// (Fish Speech / F5-TTS / Chatterbox) on ANY machine that can afford them,
// and let a small production container (Railway ~1 GB slice) use them over
// HTTP. This is the "use the whole RAM instead of the 1 GB shared slice"
// answer: the heavy models live HERE, the app just calls in.
//
// SETUP (on the machine that will host the engines — your own PC/server):
//   1. bash scripts/setup-local-clone.sh          # engines + weights
//      (add: pip install chatterbox-tts for the chatterbox engine)
//   2. bun mini-services/clone-satellite/server.ts   # port 3011
//   3. Expose it: SSH tunnel / Tailscale / ngrok / port-forward
//   4. On the app host:  VOXSHIFT_SATELLITE_CLONE_URL=http://<host>:3011
//      → the clone chain picks the satellite up automatically (About page
//      shows "Satellite clone (your host) — ready").
//
// API:
//   GET  /healthz → {ok, engines:[...]}
//   POST /clone   {text, lang, wavBase64, refText?} →
//                 {ok, wavBase64, sr, ms, engine} | {ok:false, error}
//
// Every request spawns the one-shot clone-tts-worker.py process (same JSON
// stdout contract the translator uses locally) — no resident model RAM.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const PORT = Number(process.env.VOXSATELLITE_PORT || 3011)
const SERVICE_DIR = dirname(fileURLToPath(import.meta.url))
const WORKER = join(SERVICE_DIR, '..', 'translator-service', 'engines', 'clone-tts-worker.py')
const ENGINES = (process.env.VOXSATELLITE_ENGINES || 'fish-speech,f5-tts,chatterbox')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const ALLOWED_ORIGINS = process.env.VOXSATELLITE_ALLOW_ORIGINS // optional CORS allowlist
const MAX_BODY = 12 * 1024 * 1024 // 12 MB (reference WAV base64 + text)

function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(ALLOWED_ORIGINS ? { 'access-control-allow-origin': ALLOWED_ORIGINS } : {}),
  })
  res.end(body)
}

/** Which engines can actually run here (package import probe, 8 s cap). */
function probeEngines(): Promise<string[]> {
  const code = `
import importlib, json
mods = ${JSON.stringify(
    ENGINES.map((e) => (e === 'fish-speech' ? 'fish_speech' : e === 'f5-tts' ? 'f5_tts' : 'chatterbox'))
  )}
found = []
for m in mods:
    try:
        importlib.import_module(m)
        found.append(m)
    except Exception:
        pass
print(json.dumps(found))
`
  return new Promise((resolve) => {
    try {
      const p = spawn('python3', ['-c', code], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', (d) => (out += String(d)))
      p.on('error', () => resolve([]))
      p.on('close', () => {
        try {
          const list = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '[]') as string[]
          resolve(
            list
              .map((m) => (m === 'fish_speech' ? 'fish-speech' : m === 'f5_tts' ? 'f5-tts' : 'chatterbox'))
              .filter((e) => ENGINES.includes(e))
          )
        } catch {
          resolve([])
        }
      })
      setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {}
        resolve([])
      }, 8000).unref()
    } catch {
      resolve([])
    }
  })
}

/** Run one synthesis through the shared one-shot worker (JSON stdout contract). */
function runWorker(
  engine: string,
  text: string,
  refPath: string,
  refText: string | null
): Promise<{ wav: Buffer; sr: number; ms: number }> {
  const timeoutMs = Number(process.env.VOXSATELLITE_TIMEOUT_MS || 300_000)
  return new Promise((resolve, reject) => {
    const args = [WORKER, engine, text.slice(0, 2000), refPath]
    if (refText) args.push(refText.slice(0, 2000))
    let out = ''
    let settled = false
    const proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch {}
      reject(new Error(`${engine} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    proc.stdout.on('data', (d) => (out += String(d)))
    proc.stderr.on('data', () => undefined)
    proc.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`worker spawn failed: ${e.message}`))
    })
    proc.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const line = out.trim().split('\n').filter(Boolean).pop() ?? ''
      try {
        const msg = JSON.parse(line) as { ok?: boolean; error?: string; wav_b64?: string; sr?: number; ms?: number }
        if (!msg.ok || !msg.wav_b64) throw new Error(msg.error ?? 'no audio returned')
        resolve({ wav: Buffer.from(msg.wav_b64, 'base64'), sr: msg.sr ?? 24000, ms: msg.ms ?? 0 })
      } catch (e) {
        reject(new Error(`${engine}: ${e instanceof Error ? e.message : line.slice(0, 120)}`))
      }
    })
  })
}

async function handleClone(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) {
      json(res, 413, { ok: false, error: 'body too large' })
      return
    }
    chunks.push(c as Buffer)
  }
  let body: { text?: string; lang?: string; refText?: string | null; wavBase64?: string; engine?: string }
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    json(res, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  const text = typeof body.text === 'string' ? body.text : ''
  const wavB64 = typeof body.wavBase64 === 'string' ? body.wavBase64 : ''
  if (!text.trim() || !wavB64) {
    json(res, 422, { ok: false, error: 'text and wavBase64 are required' })
    return
  }
  const available = await probeEngines()
  if (available.length === 0) {
    json(res, 503, {
      ok: false,
      error:
        'no clone engine is importable on this satellite host — run scripts/setup-local-clone.sh (pip install f5-tts / fish-speech checkout / pip install chatterbox-tts)',
    })
    return
  }
  const order = body.engine && available.includes(body.engine) ? [body.engine] : available
  const refWav = Buffer.from(wavB64, 'base64')

  let lastErr = 'no engine attempted'
  for (const engine of order) {
    const dir = await mkdtemp(join(tmpdir(), 'voxshift-sat-'))
    try {
      const refPath = join(dir, 'reference.wav')
      await writeFile(refPath, refWav)
      const out = await runWorker(engine, text, refPath, body.refText ?? null)
      json(res, 200, { ok: true, wavBase64: out.wav.toString('base64'), sr: out.sr, ms: out.ms, engine })
      return
    } catch (err) {
      lastErr = `${engine}: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  json(res, 502, { ok: false, error: lastErr })
}

const server = createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0]
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...(ALLOWED_ORIGINS ? { 'access-control-allow-origin': ALLOWED_ORIGINS } : {}),
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end()
    return
  }
  if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
    probeEngines().then((engines) => {
      json(res, 200, { ok: true, service: 'voxshift-clone-satellite', version: '3.8.0', engines })
    })
    return
  }
  if (req.method === 'POST' && url === '/clone') {
    handleClone(req, res).catch((err) =>
      json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    )
    return
  }
  json(res, 404, { ok: false, error: 'not found — POST /clone or GET /healthz' })
})

server.listen(PORT, () => {
  console.log(`[clone-satellite] v3.8.0 listening on :${PORT} — engines: ${ENGINES.join(', ')}`)
  probeEngines().then((e) =>
    console.log(`[clone-satellite] importable now: ${e.join(', ') || 'NONE — run scripts/setup-local-clone.sh'}`)
  )
})

process.on('SIGINT', () => server.close(() => process.exit(0)))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
