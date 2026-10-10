// ─────────────────────────────────────────────────────────────────────────────
// LOCAL TTS engine (§14) — piper (preferred) → espeak-ng (fallback).
// Reconstructed from the v3.0.0 spec after the platform workspace rollback
// (lost to the local-* gitignore rule — see worklog GH-PUSH-3).
// API: localTTS(text, { lang, speed }) → { buffer: Buffer, format: 'wav' }.
// voices: piper fa_IR-amir-medium / en_US-amy-medium (voxshift-ml installer),
// espeak-ng voice 'fa' / 'en-us' with speed-scaled rate.
//
// PERFORMANCE (deploy-3): piper used to spawn a fresh process per call — the
// ONNX model reloaded from disk every utterance (~3-5s before the first audio
// sample, dominating end-to-end latency). Two optimizations, both honest:
//   1. WARM WORKER — `engines/piper-worker.py` keeps one resident python
//      process per voice model (JSON-line protocol on stdio, ready-gated,
//      request timeouts, auto-respawn, idle reaper). Synthesis drops to
//      ~0.3-1.5s. Any worker failure transparently falls back to the
//      one-shot CLI path below.
//   2. LRU RESULT CACHE — identical (text, lang, speed) repeats (greetings,
//      confirmations, common replies) return instantly from memory.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { detectLocalRuntimes } from '../providers/local-runtimes'
import { PIPER_VOICES } from '../providers/local-runtimes'

const MODELS_ROOT = process.env.VOXSHIFT_MODELS_DIR || '/home/z/models'
const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'piper-worker.py')

// ── Warm piper worker manager ────────────────────────────────────────────────

interface PendingReq {
  resolve: (buf: Buffer) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface WarmWorker {
  proc: ChildProcessWithoutNullStreams
  model: string
  ready: boolean
  fatal: string | null
  lastUsed: number
  lineBuf: string
  pending: Map<string, PendingReq>
  nextId: number
  startTimeout?: ReturnType<typeof setTimeout>
}

const warmWorkers = new Map<string, WarmWorker>()
const WORKER_READY_TIMEOUT_MS = 15_000
const WORKER_REQ_TIMEOUT_MS = 45_000
const WORKER_IDLE_MS = 4 * 60_000

/** Candidate python interpreters: PATH first, then known venv locations. */
function pythonCandidates(): string[] {
  return ['python3', '/opt/voxshift/venv/bin/python3', '/home/z/.venv/bin/python']
}

let pythonBin: string | null = null
function resolvePython(): string | null {
  if (pythonBin) return pythonBin
  for (const bin of pythonCandidates()) {
    try {
      // existsSync works for absolute paths; bare `python3` is trusted to PATH
      // (start-voxshift.sh puts the venv bin first) and validated by the
      // worker's ready gate — a missing interpreter rejects into the CLI path.
      if (bin.startsWith('/') && !existsSync(bin)) continue
      pythonBin = bin
      return bin
    } catch {
      /* try next */
    }
  }
  return null
}

function killWorker(w: WarmWorker): void {
  for (const [, p] of w.pending) {
    clearTimeout(p.timer)
    p.reject(new Error('piper warm worker terminated'))
  }
  w.pending.clear()
  try {
    w.proc.kill('SIGKILL')
  } catch {}
  for (const [k, v] of warmWorkers) if (v === w) warmWorkers.delete(k)
}

/**
 * Boot-time prewarm: spawn (and optionally wait for) resident workers so the
 * FIRST utterance after a deploy/restart is already fast. Both app voices
 * (en + fa) are prewarmed by default — measured cost ≈180MB RSS each, total
 * anon stays ≈490MB inside the container's 954MB budget (verified deploy-5).
 */
export async function prewarmTTS(langs: Array<'fa' | 'en'> = ['en', 'fa']): Promise<void> {
  try {
    const rt = await detectLocalRuntimes()
    const pr = rt.runtimes.find((r) => r.id === 'local:piper-tts')
    if (!pr?.available) return
    for (const lang of langs) {
      const file = PIPER_VOICES[lang]
      if (!file) continue
      const modelPath = `${MODELS_ROOT}/piper/${file}`
      if (!warmWorkers.has(modelPath)) spawnWorker(modelPath)
    }
  } catch {
    /* prewarm is best-effort — on-demand path still works */
  }
}

/** Honest voice-engine state for the diagnostics/health channel (§30): which
 *  piper workers are resident + warm, and the LRU cache fill. */
export function ttsWorkerState(): {
  workers: Array<{ voice: string; ready: boolean }>
  cacheEntries: number
  cacheBytes: number
} {
  return {
    workers: [...warmWorkers.values()].map((w) => ({
      voice: (w.model.split('/').pop() ?? w.model).replace(/\.onnx$/, ''),
      ready: w.ready,
    })),
    cacheEntries: ttsCache.size,
    cacheBytes: ttsCacheBytes,
  }
}

function spawnWorker(modelPath: string): WarmWorker {
  const bin = resolvePython()
  const proc = spawn(bin || 'python3', [WORKER_SCRIPT, modelPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  const w: WarmWorker = {
    proc,
    model: modelPath,
    ready: false,
    fatal: null,
    lastUsed: Date.now(),
    lineBuf: '',
    pending: new Map(),
    nextId: 1,
  }
  warmWorkers.set(modelPath, w)

  // Ready gate: if the worker never becomes ready, release waiters to the CLI path.
  w.startTimeout = setTimeout(() => {
    if (!w.ready) {
      w.fatal = `worker not ready within ${WORKER_READY_TIMEOUT_MS / 1000}s`
      const waiters = [...w.pending.values()]
      w.pending.clear()
      for (const p of waiters) {
        clearTimeout(p.timer)
        p.reject(new Error(w.fatal))
      }
      // Keep the process alive a little longer? No — it is useless now.
      killWorker(w)
    }
  }, WORKER_READY_TIMEOUT_MS)

  proc.stdout.on('data', (chunk: Buffer) => {
    w.lineBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = w.lineBuf.indexOf('\n')) >= 0) {
      const line = w.lineBuf.slice(0, idx).trim()
      w.lineBuf = w.lineBuf.slice(idx + 1)
      if (!line) continue
      let msg: { type?: string; id?: string; ok?: boolean; b64?: string; error?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // stray non-protocol output — ignore
      }
      if (msg.type === 'ready') {
        w.ready = true
        if (w.startTimeout) clearTimeout(w.startTimeout)
        continue
      }
      if (msg.type === 'fatal') {
        w.fatal = msg.error ?? 'worker fatal'
        killWorker(w)
        continue
      }
      if (msg.type === 'result' && msg.id) {
        const p = w.pending.get(msg.id)
        if (!p) continue // late answer to an already-timed-out request
        w.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok && msg.b64) {
          p.resolve(Buffer.from(msg.b64, 'base64'))
        } else {
          p.reject(new Error(msg.error ?? 'piper worker synthesis failed'))
        }
      }
    }
  })

  proc.stderr.on('data', () => {
    /* piper/onnxruntime logs — intentionally swallowed */
  })

  proc.on('error', () => killWorker(w))
  proc.on('close', () => killWorker(w))

  return w
}

function warmSynth(text: string, modelPath: string, lengthScale: number): Promise<Buffer> {
  let w = warmWorkers.get(modelPath)
  if (!w) w = spawnWorker(modelPath)
  if (w.fatal) return Promise.reject(new Error(w.fatal))
  w.lastUsed = Date.now()
  const id = `r${w.nextId++}`
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      w.pending.delete(id)
      // A timed-out request desyncs the line protocol — recycle the worker.
      killWorker(w)
      reject(new Error('piper warm worker request timed out'))
    }, WORKER_REQ_TIMEOUT_MS)
    w.pending.set(id, { resolve, reject, timer })
    try {
      w.proc.stdin.write(
        JSON.stringify({ id, text, length_scale: lengthScale }) + '\n'
      )
    } catch (e) {
      clearTimeout(timer)
      w.pending.delete(id)
      killWorker(w)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

// Idle reaper — frees RAM (container budget 954MB) when TTS goes quiet.
const reaper = setInterval(() => {
  const now = Date.now()
  for (const w of [...warmWorkers.values()]) {
    if (now - w.lastUsed > WORKER_IDLE_MS) killWorker(w)
  }
}, 60_000)
reaper.unref?.()

// ── LRU result cache ─────────────────────────────────────────────────────────

const TTS_CACHE_MAX_ENTRIES = 96
const TTS_CACHE_MAX_BYTES = 24 * 1024 * 1024
const ttsCache = new Map<string, Buffer>()
let ttsCacheBytes = 0

function ttsCacheKey(text: string, lang: string, speed: number): string {
  return createHash('sha1').update(`${lang}|${speed.toFixed(2)}|${text}`).digest('hex')
}

function cachePut(key: string, buf: Buffer): void {
  if (ttsCache.has(key)) return // identical result already cached
  ttsCache.set(key, buf)
  ttsCacheBytes += buf.length
  while (ttsCache.size > TTS_CACHE_MAX_ENTRIES || ttsCacheBytes > TTS_CACHE_MAX_BYTES) {
    const oldest = ttsCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    const v = ttsCache.get(oldest)
    ttsCache.delete(oldest)
    if (v) ttsCacheBytes -= v.length
  }
}

// ── One-shot CLI synthesis (fallback path, unchanged behavior) ──────────────

function runWithInput(
  cmd: string,
  args: string[],
  input: string,
  timeoutMs = 60_000
): Promise<{ code: number; err: string }> {
  return new Promise((resolve, reject) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      const timer = setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {}
        reject(new Error(`local TTS timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      p.stderr.on('data', (d) => (err += String(d)))
      p.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, err })
      })
      p.stdin.write(input)
      p.stdin.end()
    } catch (e) {
      reject(e)
    }
  })
}

function runFileOut(
  cmd: string,
  args: string[],
  outPath: string,
  timeoutMs = 60_000
): Promise<{ code: number; err: string }> {
  return new Promise((resolve, reject) => {
    try {
      const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      const timer = setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {}
        reject(new Error(`local TTS timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      p.stderr.on('data', (d) => (err += String(d)))
      p.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, err })
      })
    } catch (e) {
      reject(e)
    }
  })
}

async function piperTTS(
  text: string,
  lang: string,
  speed: number
): Promise<{ buffer: Buffer; via: 'warm' | 'cli' } | null> {
  const rt = await detectLocalRuntimes()
  const pr = rt.runtimes.find((r) => r.id === 'local:piper-tts')
  if (!pr?.available) return null
  // Language-aware voice selection — the runtime probe only reports the FIRST
  // installed voice, which made English output use the Persian voice (accented
  // speech). Map the output language to its dedicated voice, falling back to
  // whatever the probe found.
  const wanted = (lang || '').toLowerCase().startsWith('fa') ? PIPER_VOICES.fa : PIPER_VOICES.en
  const modelFile = existsSync(`${MODELS_ROOT}/piper/${wanted}`) ? wanted : pr.model
  if (!modelFile) return null
  const voice = `${MODELS_ROOT}/piper/${modelFile}`
  const lengthScale = Math.min(4, Math.max(0.25, 1 / Math.min(3, Math.max(0.5, speed || 1))))

  // 1) Warm worker (resident model) — the fast path.
  try {
    const buf = await warmSynth(text, voice, lengthScale)
    return { buffer: buf, via: 'warm' }
  } catch {
    /* worker unavailable/failed — fall back to the CLI below */
  }

  // 2) One-shot CLI (model reloads per call — slow but bulletproof).
  const dir = await mkdtemp(join(tmpdir(), 'voxshift-tts-'))
  try {
    const outPath = join(dir, 'out.wav')
    const { code, err } = await runWithInput(
      'piper',
      ['--model', voice, '--length_scale', String(lengthScale), '--output_file', outPath],
      text,
      90_000
    )
    if (code !== 0) throw new Error(`piper failed (exit ${code}): ${err.slice(0, 200)}`)
    return { buffer: await readFile(outPath), via: 'cli' }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function espeakTTS(
  text: string,
  lang: string,
  speed: number
): Promise<{ buffer: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'voxshift-tts-'))
  try {
    const outPath = join(dir, 'out.wav')
    const voice = (lang || '').toLowerCase().startsWith('fa') ? 'fa' : 'en-us'
    // espeak-ng default rate ≈ 175 wpm; scale by the requested speed.
    const rate = Math.round(Math.min(400, Math.max(80, 160 * Math.min(2, Math.max(0.5, speed || 1)))))
    const { code, err } = await runFileOut(
      'espeak-ng',
      ['-v', voice, '-s', String(rate), '-a', '185', '-p', '45', '-w', outPath, '--', text],
      outPath
    )
    if (code !== 0) throw new Error(`espeak-ng failed (exit ${code}): ${err.slice(0, 200)}`)
    return { buffer: await readFile(outPath) }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Synthesize speech on-machine. Order: piper warm worker → piper CLI →
 * espeak-ng. Repeated phrases are served from an in-memory LRU cache.
 * `via` reports honestly HOW the audio was produced (§27 telemetry):
 *   'cache'  — LRU hit (0 ms, identical phrase repeated)
 *   'warm'   — resident piper worker (fast path)
 *   'cli'    — one-shot piper process (worker failed; slow)
 *   'espeak' — last-resort formant synthesizer
 * Returns 16 kHz-ish mono WAV buffer (caller conforms as needed).
 */
export async function localTTS(
  text: string,
  opts: { lang?: string; speed?: number } = {}
): Promise<{ buffer: Buffer; format: 'wav'; via: 'cache' | 'warm' | 'cli' | 'espeak' }> {
  const lang = opts.lang ?? 'en'
  const key = ttsCacheKey(text, lang, opts.speed ?? 1)
  const cached = ttsCache.get(key)
  if (cached) {
    // LRU refresh
    ttsCache.delete(key)
    ttsCache.set(key, cached)
    return { buffer: cached, format: 'wav', via: 'cache' }
  }
  let out: { buffer: Buffer; format: 'wav'; via: 'warm' | 'cli' | 'espeak' } | null = null
  try {
    const piper = await piperTTS(text, lang, opts.speed ?? 1)
    if (piper) out = { buffer: piper.buffer, format: 'wav', via: piper.via }
  } catch {
    /* fall through to espeak */
  }
  if (!out) {
    const rt = await detectLocalRuntimes()
    const espeak = rt.runtimes.find((r) => r.id === 'local:espeak-tts')
    if (!espeak?.available) {
      throw new Error(
        'LOCAL TTS not configured on this machine — no piper and no espeak-ng on PATH (see voxshift-ml/setup_ml_stack.sh)'
      )
    }
    const es = await espeakTTS(text, lang, opts.speed ?? 1)
    out = { buffer: es.buffer, format: 'wav', via: 'espeak' }
  }
  if (out.buffer.length < 4 * 1024 * 1024) cachePut(key, out.buffer) // skip caching giant WAVs
  return out
}
