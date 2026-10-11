// ─────────────────────────────────────────────────────────────────────────────
// LOCAL clone-engine synthesis adapters (v3.5.0) — bridge between the
// local-first priority chain (src/lib/voice/clone-chain.ts) and the real
// python engines via engines/clone-tts-worker.py (one-shot, JSON stdout).
//
// The worker is ONLY spawned when the detector verified package + weights +
// RAM, so a spawn failure here is an honest runtime error that the chain
// records as a failed attempt before falling through to the next engine.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { CloneEngineId } from '../../../src/lib/voice/clone-chain'

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url)) // engines/
const REPO_ROOT = join(SERVICE_DIR, '..', '..', '..') // translator-service → mini-services → repo root

const LOCAL_CLONE_ENGINES: readonly string[] = ['fish-speech', 'f5-tts', 'chatterbox']

export function isLocalCloneEngine(id: string): boolean {
  return LOCAL_CLONE_ENGINES.includes(id)
}

/**
 * Resolve the enrolled reference WAV for a clone profile. Conventions:
 *   · db/audio/clone-ref/{providerProfileId}.wav  (cloud-enrolled clones)
 *   · db/audio/clone-ref/{profileId}.wav          (v3.8.0 — EVERY enrollment
 *     persists its first take under the profile's own id so the timbre-
 *     conformed DSP level and the satellite/local engines can morph toward it)
 *   · db/audio/contacts/{id}.wav
 * Override the directory with VOXSHIFT_CLONE_REF_DIR.
 */
export function cloneRefWavPath(providerProfileId: string | undefined): string | null {
  return cloneRefWavPathAny(providerProfileId, providerProfileId)
}

/** Try the provider voice id first, then the profile id (v3.8.0). */
export function cloneRefWavPathAny(
  providerProfileId: string | null | undefined,
  profileId: string | null | undefined
): string | null {
  const ids = [providerProfileId, profileId].filter(
    (id): id is string => Boolean(id && /^[A-Za-z0-9_-]{1,64}$/.test(id))
  )
  const dirs = [
    process.env.VOXSHIFT_CLONE_REF_DIR,
    join(REPO_ROOT, 'db', 'audio', 'clone-ref'),
    join(REPO_ROOT, 'db', 'audio', 'contacts'),
  ].filter((d): d is string => Boolean(d))
  for (const id of ids) {
    for (const dir of dirs) {
      const p = join(dir, `${id}.wav`)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * Reference transcript for zero-shot engines (fish + f5 both condition on the
 * reference text; f5's empty-text path pulls a whisper model mid-flight).
 * Convention: a .txt sibling of the WAV ({id}.txt), or the operator-wide
 * VOXSHIFT_CLONE_REF_TEXT. Returns null when none exists — the engines then
 * run on their honest best-effort path.
 */
export function cloneRefTextFor(refWavPath: string | null): string | null {
  const env = process.env.VOXSHIFT_CLONE_REF_TEXT
  if (env) return env
  if (!refWavPath) return null
  const txt = refWavPath.replace(/\.wav$/i, '.txt')
  try {
    if (existsSync(txt)) return readFileSync(txt, 'utf8').trim() || null
  } catch {}
  return null
}

export interface LocalCloneSynthResult {
  buffer: Buffer
  sampleRate: number
  ms: number
}

/** Run the python worker for one LOCAL clone engine. Rejects with the honest worker error.
 *
 * timeoutMs defaults to 300 s: the measured one-shot cold path is ~57 s for
 * fish-speech (LLM load + 3.4 s audio) and ~150 s for f5-tts — the old 120 s
 * default killed cold f5 calls mid-vocoder. */
export function localCloneSynthesize(
  engine: Extract<CloneEngineId, 'fish-speech' | 'f5-tts' | 'chatterbox'>,
  text: string,
  refWavPath: string,
  opts?: { timeoutMs?: number; refText?: string | null }
): Promise<LocalCloneSynthResult> {
  const timeoutMs = opts?.timeoutMs ?? 300_000
  const refText = opts?.refText ?? null
  return new Promise((resolve, reject) => {
    const worker = join(SERVICE_DIR, 'clone-tts-worker.py')
    const args = [worker, engine, text.slice(0, 2000), refWavPath]
    if (refText) args.push(refText.slice(0, 2000))
    let out = ''
    let settled = false
    try {
      const proc = spawn('python3', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          proc.kill('SIGKILL')
        } catch {}
        reject(new Error(`${engine} clone worker timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      proc.stdout.on('data', (d) => (out += String(d)))
      proc.stderr.on('data', () => undefined) // engine log noise — the JSON line is the contract
      proc.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`${engine} clone worker failed to spawn: ${e.message}`))
      })
      proc.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const line = out.trim().split('\n').filter(Boolean).pop() ?? ''
        try {
          const msg = JSON.parse(line) as { ok?: boolean; error?: string; wav_b64?: string; sr?: number; ms?: number }
          if (!msg.ok || !msg.wav_b64) {
            reject(new Error(`${engine} clone synthesis failed: ${msg.error ?? 'no audio returned'}`))
            return
          }
          resolve({
            buffer: Buffer.from(msg.wav_b64, 'base64'),
            sampleRate: msg.sr ?? 24000,
            ms: msg.ms ?? 0,
          })
        } catch {
          reject(new Error(`${engine} clone worker returned an unparseable result: ${line.slice(0, 120)}`))
        }
      })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/**
 * SATELLITE clone synthesis (v3.8.0): POST the text + reference WAV (base64)
 * to a user-hosted satellite worker (mini-services/clone-satellite) that runs
 * the REAL engines (Fish Speech / F5-TTS / Chatterbox) on hardware with the
 * RAM to afford them — the Railway container stays small, the cloning quality
 * does not. Contract mirrors the local worker: {ok, wavBase64, sr?, ms?, engine?}.
 */
const SATELLITE_RETRY_DELAYS_MS = [500, 1200, 2600]

export function satelliteCloneSynthesize(
  baseUrl: string,
  text: string,
  refWavPath: string,
  opts?: { refText?: string | null; lang?: string; timeoutMs?: number }
): Promise<LocalCloneSynthResult> {
  const timeoutMs = opts?.timeoutMs ?? 240_000
  const body = JSON.stringify({
    text: text.slice(0, 2000),
    lang: opts?.lang ?? 'en',
    refText: opts?.refText ?? null,
    wavBase64: readFileSync(refWavPath).toString('base64'),
  })
  const attemptOnce = async (): Promise<LocalCloneSynthResult> => {
    const res = await fetch(new URL('/clone', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`satellite responded ${res.status}: ${detail.slice(0, 200)}`)
    }
    const msg = (await res.json()) as { ok?: boolean; error?: string; wavBase64?: string; sr?: number; ms?: number; engine?: string }
    if (!msg.ok || !msg.wavBase64) throw new Error(`satellite synthesis failed: ${msg.error ?? 'no audio returned'}`)
    return { buffer: Buffer.from(msg.wavBase64, 'base64'), sampleRate: msg.sr ?? 24000, ms: msg.ms ?? 0 }
  }
  return (async () => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= SATELLITE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await attemptOnce()
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        const transient = /429|rate|too many|5\d\d|timeout|ECONN|fetch failed|network/i.test(msg)
        if (!transient || attempt === SATELLITE_RETRY_DELAYS_MS.length) break
        await new Promise((r) => setTimeout(r, SATELLITE_RETRY_DELAYS_MS[attempt]))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  })()
}
