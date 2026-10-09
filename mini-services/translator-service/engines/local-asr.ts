// ─────────────────────────────────────────────────────────────────────────────
// LOCAL ASR engine (§14) — vosk python stream (primary) / whisper.cpp (opt).
// Reconstructed from the v3.0.0 spec after the platform workspace rollback
// (lost to the local-* gitignore rule — see worklog GH-PUSH-3).
// API: localASR(wavBase64, lang) → { text } — called by the pipeline's
// routedCall('asr', { local: … }) with 16 kHz mono WAV input.
// Model pick is language-aware: fa → vosk-model-small-fa-0.42,
// en (default) → vosk-model-small-en-us-0.15.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { detectLocalRuntimes } from '../providers/local-runtimes'

const MODELS_ROOT = process.env.VOXSHIFT_MODELS_DIR || '/home/z/models'
const VOSK_MODELS: Record<string, string> = {
  fa: 'vosk-model-small-fa-0.42',
  en: 'vosk-model-small-en-us-0.15',
}

const VOSK_PY = `
import sys, json, wave
from vosk import Model, KaldiRecognizer, SetLogLevel
wav_path, model_path = sys.argv[1], sys.argv[2]
SetLogLevel(-1)
wf = wave.open(wav_path, 'rb')
model = Model(model_path)
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(False)
parts = []
while True:
    data = wf.readframes(8000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        parts.append(json.loads(rec.Result()).get('text', ''))
parts.append(json.loads(rec.FinalResult()).get('text', ''))
text = ' '.join(t for t in parts if t).strip()
print(json.dumps({'text': text}))
`

function pickVoskModel(lang: string): string | null {
  const key = (lang || '').toLowerCase().startsWith('fa') ? 'fa' : 'en'
  const dir = `${MODELS_ROOT}/${VOSK_MODELS[key]}`
  if (existsSync(dir)) return dir
  const other = `${MODELS_ROOT}/${VOSK_MODELS[key === 'fa' ? 'en' : 'fa']}`
  return existsSync(other) ? other : null
}

function run(cmd: string, args: string[], input?: string, timeoutMs = 60_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {}
        reject(new Error(`local ASR step timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      p.stdout.on('data', (d) => (out += String(d)))
      p.stderr.on('data', (d) => (err += String(d)))
      p.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, out, err })
      })
      if (input !== undefined) {
        p.stdin.write(input)
        p.stdin.end()
      }
    } catch (e) {
      reject(e)
    }
  })
}

async function voskTranscribe(wavBase64: string, lang: string): Promise<{ text: string }> {
  const modelDir = pickVoskModel(lang)
  if (!modelDir) {
    throw new Error(
      'LOCAL ASR not configured on this machine — install vosk (pip install vosk) and models per voxshift-ml/setup_ml_stack.sh'
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'voxshift-asr-'))
  try {
    const wavPath = join(dir, 'in.wav')
    await writeFile(wavPath, Buffer.from(wavBase64, 'base64'))
    const { code, out, err } = await run('python3', ['-c', VOSK_PY, wavPath, modelDir])
    if (code !== 0) {
      throw new Error(`vosk ASR failed (exit ${code}): ${err.slice(0, 300) || 'no stderr'}`)
    }
    const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}'
    const parsed = JSON.parse(line) as { text?: string }
    return { text: (parsed.text ?? '').trim() }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function whisperCppTranscribe(wavBase64: string): Promise<{ text: string }> {
  const rt = await detectLocalRuntimes()
  const wr = rt.runtimes.find((r) => r.id === 'local:whisper-asr' && r.available)
  const model = wr?.model ? `${MODELS_ROOT}/${wr.model}` : null
  if (!wr || !model) {
    throw new Error('LOCAL ASR (whisper.cpp) not configured — binary + ggml model required')
  }
  const dir = await mkdtemp(join(tmpdir(), 'voxshift-asr-'))
  try {
    const wavPath = join(dir, 'in.wav')
    await writeFile(wavPath, Buffer.from(wavBase64, 'base64'))
    const exe = (await new Promise<string | null>((res) => {
      const p = spawn('which', ['whisper-cli'])
      let o = ''
      p.stdout.on('data', (d) => (o += String(d)))
      p.on('close', (c) => res(c === 0 ? o.trim() : null))
      p.on('error', () => res(null))
    })) || 'whisper.cpp'
    const { code, out } = await run(exe, ['-m', model, '-f', wavPath, '-nt', '-otxt=false'], undefined, 120_000)
    if (code !== 0) throw new Error(`whisper.cpp failed (exit ${code})`)
    const text = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\[/.test(l))
      .join(' ')
      .trim()
    return { text }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Transcribe 16 kHz mono WAV (base64) with a REAL on-machine engine.
 * Order: vosk (python stream) → whisper.cpp → honest NOT_CONFIGURED error.
 */
export async function localASR(wavBase64: string, lang = 'en'): Promise<{ text: string }> {
  const rt = await detectLocalRuntimes()
  const vosk = rt.runtimes.find((r) => r.id === 'local:vosk-asr')
  if (vosk?.available) {
    return voskTranscribe(wavBase64, lang)
  }
  const whisper = rt.runtimes.find((r) => r.id === 'local:whisper-asr')
  if (whisper?.available) {
    return whisperCppTranscribe(wavBase64)
  }
  throw new Error(
    `LOCAL ASR not configured on this machine — ${vosk?.detail ?? 'vosk detection failed'}; install per voxshift-ml/setup_ml_stack.sh`
  )
}
