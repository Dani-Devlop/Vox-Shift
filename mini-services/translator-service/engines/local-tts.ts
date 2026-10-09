// ─────────────────────────────────────────────────────────────────────────────
// LOCAL TTS engine (§14) — piper (preferred) → espeak-ng (fallback).
// Reconstructed from the v3.0.0 spec after the platform workspace rollback
// (lost to the local-* gitignore rule — see worklog GH-PUSH-3).
// API: localTTS(text, { lang, speed }) → { buffer: Buffer, format: 'wav' }.
// voices: piper fa_IR-amir-medium / en_US-amy-medium (voxshift-ml installer),
// espeak-ng voice 'fa' / 'en-us' with speed-scaled rate.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectLocalRuntimes } from '../providers/local-runtimes'

const MODELS_ROOT = process.env.VOXSHIFT_MODELS_DIR || '/home/z/models'

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
): Promise<{ buffer: Buffer } | null> {
  const rt = await detectLocalRuntimes()
  const pr = rt.runtimes.find((r) => r.id === 'local:piper-tts')
  if (!pr?.available || !pr.model) return null
  const voice = `${MODELS_ROOT}/piper/${pr.model}`
  const dir = await mkdtemp(join(tmpdir(), 'voxshift-tts-'))
  try {
    const outPath = join(dir, 'out.wav')
    // piper reads text on stdin; length_scale >1 = slower (inverse of speed).
    const lengthScale = Math.min(4, Math.max(0.25, 1 / Math.min(3, Math.max(0.5, speed || 1))))
    const { code, err } = await runWithInput(
      'piper',
      ['--model', voice, '--length_scale', String(lengthScale), '--output_file', outPath],
      text,
      90_000
    )
    if (code !== 0) throw new Error(`piper failed (exit ${code}): ${err.slice(0, 200)}`)
    return { buffer: await readFile(outPath) }
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
 * Synthesize speech on-machine. Order: piper (natural voices) → espeak-ng.
 * Returns 16 kHz-ish mono WAV buffer (caller conforms as needed).
 */
export async function localTTS(
  text: string,
  opts: { lang?: string; speed?: number } = {}
): Promise<{ buffer: Buffer; format: 'wav' }> {
  const lang = opts.lang ?? 'en'
  try {
    const piper = await piperTTS(text, lang, opts.speed ?? 1)
    if (piper) return { buffer: piper.buffer, format: 'wav' }
  } catch {
    /* fall through to espeak */
  }
  const rt = await detectLocalRuntimes()
  const espeak = rt.runtimes.find((r) => r.id === 'local:espeak-tts')
  if (!espeak?.available) {
    throw new Error(
      'LOCAL TTS not configured on this machine — no piper and no espeak-ng on PATH (see voxshift-ml/setup_ml_stack.sh)'
    )
  }
  const out = await espeakTTS(text, lang, opts.speed ?? 1)
  return { buffer: out.buffer, format: 'wav' }
}
