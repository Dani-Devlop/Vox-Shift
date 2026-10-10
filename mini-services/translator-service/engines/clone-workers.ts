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
import { existsSync } from 'fs'
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
 * Resolve the enrolled reference WAV for a clone profile. Convention (kept by
 * both enrollment routes): db/audio/clone-ref/{providerProfileId}.wav.
 * Override the directory with VOXSHIFT_CLONE_REF_DIR.
 */
export function cloneRefWavPath(providerProfileId: string | undefined): string | null {
  if (!providerProfileId || !/^[A-Za-z0-9_-]{1,64}$/.test(providerProfileId)) return null
  const dirs = [
    process.env.VOXSHIFT_CLONE_REF_DIR,
    join(REPO_ROOT, 'db', 'audio', 'clone-ref'),
    join(REPO_ROOT, 'db', 'audio', 'contacts'),
  ].filter((d): d is string => Boolean(d))
  for (const dir of dirs) {
    const p = join(dir, `${providerProfileId}.wav`)
    if (existsSync(p)) return p
  }
  return null
}

export interface LocalCloneSynthResult {
  buffer: Buffer
  sampleRate: number
  ms: number
}

/** Run the python worker for one LOCAL clone engine. Rejects with the honest worker error. */
export function localCloneSynthesize(
  engine: Extract<CloneEngineId, 'fish-speech' | 'f5-tts' | 'chatterbox'>,
  text: string,
  refWavPath: string,
  timeoutMs = 120_000
): Promise<LocalCloneSynthResult> {
  return new Promise((resolve, reject) => {
    const worker = join(SERVICE_DIR, 'clone-tts-worker.py')
    let out = ''
    let settled = false
    try {
      const proc = spawn('python3', [worker, engine, text.slice(0, 2000), refWavPath], {
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
