// ─────────────────────────────────────────────────────────────────────────────
// LOCAL runtime detection (§13/§14) — REAL probes only, honest states.
// Reconstructed from the v3.0.0 spec after the platform workspace rollback
// (original file was gitignored by the local-* rule and lost — see worklog
// GH-PUSH-3). Spec source: worklog line "LOCAL runtimes that REALLY execute":
//   vosk + whisper.cpp ASR detection w/ language-tagged model dirs,
//   espeak-ng + piper TTS, Ollama HTTP probe, 30 s cache.
// Runtime IDs consumed by router/tests: local:vosk-asr, local:whisper-asr,
//   local:espeak-tts, local:piper-tts, local:ollama-llm.
// Ollama serves the 'llm' category AND translation (§21) — the router maps it.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { existsSync } from 'fs'

export type LocalRuntimeCategory = 'asr' | 'translate' | 'llm' | 'tts'

export interface LocalRuntimeStatus {
  /** Stable id used by the router/tests, e.g. 'local:vosk-asr'. */
  id: string
  name: string
  category: LocalRuntimeCategory
  available: boolean
  /** Primary model identifier (ollama tag / vosk model dir / piper voice). */
  model?: string | null
  /** Human explanation when NOT available (shown in the providers UI). */
  detail?: string
}

export interface DetectedLocalRuntimes {
  runtimes: LocalRuntimeStatus[]
  /** Base URL when an Ollama server answers (e.g. http://127.0.0.1:11434). */
  ollamaBaseUrl: string | null
  /** Installed Ollama model tags (for pickOllamaModel). */
  ollamaModels: string[]
}

const CACHE_TTL_MS = 30_000
let cache: { at: number; rt: DetectedLocalRuntimes } | null = null

export function invalidateLocalRuntimeCache(): void {
  cache = null
}

/** Model dirs documented in the v3.0.0 round + voxshift-ml installer. */
const MODELS_ROOT = process.env.VOXSHIFT_MODELS_DIR || '/home/z/models'
const VOSK_MODELS: Record<'fa' | 'en', string> = {
  fa: 'vosk-model-small-fa-0.42',
  en: 'vosk-model-small-en-us-0.15',
}
const PIPER_VOICES: Record<'fa' | 'en', string> = {
  fa: 'fa_IR-amir-medium.onnx',
  en: 'en_US-amy-medium.onnx',
}
const OLLAMA_BASE =
  process.env.VOXSHIFT_OLLAMA_URL || process.env.OLLAMA_HOST
    ? process.env.VOXSHIFT_OLLAMA_URL ||
      (process.env.OLLAMA_HOST?.startsWith('http')
        ? process.env.OLLAMA_HOST
        : `http://${process.env.OLLAMA_HOST ?? '127.0.0.1:11434'}`)
    : 'http://127.0.0.1:11434'

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', (d) => (out += String(d)))
      p.on('error', () => resolve(null))
      p.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
      p.on('spawn', () => undefined)
      setTimeout(() => {
        try {
          p.kill()
        } catch {}
        resolve(null)
      }, 2500).unref()
    } catch {
      resolve(null)
    }
  })
}

function pythonHas(module: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('python3', ['-c', `import ${module}`], { stdio: 'ignore' })
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0))
      setTimeout(() => {
        try {
          p.kill()
        } catch {}
        resolve(false)
      }, 4000).unref()
    } catch {
      resolve(false)
    }
  })
}

async function probeOllamaModels(url: string): Promise<string[] | null> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1500)
    const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const json = (await res.json()) as { models?: Array<{ name?: string }> }
    return (json.models ?? []).map((m) => m.name ?? '').filter(Boolean)
  } catch {
    return null
  }
}

/** env VOXSHIFT_OLLAMA_MODEL → first qwen → llama/mistral/gemma → first. */
function pickOllamaModel(models: string[]): string | null {
  if (!models.length) return null
  const env = process.env.VOXSHIFT_OLLAMA_MODEL
  if (env) {
    const exact = models.find((m) => m === env)
    if (exact) return exact
    const prefix = models.find((m) => m.startsWith(env))
    if (prefix) return prefix
  }
  return (
    models.find((m) => /qwen/i.test(m)) ??
    models.find((m) => /(llama|mistral|gemma)/i.test(m)) ??
    models[0]
  )
}

export async function detectLocalRuntimes(): Promise<DetectedLocalRuntimes> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rt

  const runtimes: LocalRuntimeStatus[] = []

  // ── Ollama (LLM + translation) — HTTP probe ──────────────────────────────
  const ollamaUrl = OLLAMA_BASE
  const models = await probeOllamaModels(ollamaUrl)
  let ollamaBaseUrl: string | null = null
  let ollamaModels: string[] = []
  if (models && models.length) {
    ollamaBaseUrl = ollamaUrl
    ollamaModels = models
    runtimes.push({
      id: 'local:ollama-llm',
      name: 'Ollama (local LLM)',
      category: 'llm',
      available: true,
      model: pickOllamaModel(models),
      detail: `${models.length} model(s): ${models.slice(0, 4).join(', ')}${models.length > 4 ? '…' : ''}`,
    })
  } else {
    runtimes.push({
      id: 'local:ollama-llm',
      name: 'Ollama (local LLM)',
      category: 'llm',
      available: false,
      model: null,
      detail: `Ollama not answering on ${ollamaUrl} — start \`ollama serve\` and pull a model (e.g. qwen2.5:3b-instruct)`,
    })
  }

  // ── vosk ASR — python module + language-tagged model dirs ────────────────
  const voskPy = await pythonHas('vosk')
  const faDir = `${MODELS_ROOT}/${VOSK_MODELS.fa}`
  const enDir = `${MODELS_ROOT}/${VOSK_MODELS.en}`
  const hasFa = existsSync(faDir)
  const hasEn = existsSync(enDir)
  const voskModel = hasFa ? VOSK_MODELS.fa : hasEn ? VOSK_MODELS.en : null
  if (voskPy && voskModel) {
    runtimes.push({
      id: 'local:vosk-asr',
      name: 'Vosk (local ASR)',
      category: 'asr',
      available: true,
      model: voskModel,
      detail: `models: fa=${hasFa ? '✓' : '✗'} en=${hasEn ? '✓' : '✗'}`,
    })
  } else {
    const why = !voskPy
      ? 'python vosk module missing — pip install vosk'
      : 'model dirs missing — see voxshift-ml/setup_ml_stack.sh'
    runtimes.push({
      id: 'local:vosk-asr',
      name: 'Vosk (local ASR)',
      category: 'asr',
      available: false,
      model: null,
      detail: `${why} (${MODELS_ROOT}: fa=${hasFa ? '✓' : '✗'} en=${hasEn ? '✓' : '✗'})`,
    })
  }

  // ── whisper.cpp ASR — optional secondary local ASR ───────────────────────
  const whisperBin = (await which('whisper-cli')) ?? (await which('whisper.cpp'))
  const ggml = [`${MODELS_ROOT}/ggml-large-v3-turbo.bin`, `${MODELS_ROOT}/ggml-base.bin`].find((p) =>
    existsSync(p)
  )
  if (whisperBin && ggml) {
    runtimes.push({
      id: 'local:whisper-asr',
      name: 'whisper.cpp (local ASR)',
      category: 'asr',
      available: true,
      model: ggml.split('/').pop() ?? null,
    })
  }

  // ── piper TTS — preferred local TTS when present ─────────────────────────
  const piperBin = await which('piper')
  const piperVoice = [PIPER_VOICES.fa, PIPER_VOICES.en]
    .map((v) => `${MODELS_ROOT}/piper/${v}`)
    .find((p) => existsSync(p))
  if (piperBin) {
    runtimes.push({
      id: 'local:piper-tts',
      name: 'Piper (local TTS)',
      category: 'tts',
      available: Boolean(piperVoice),
      model: piperVoice ? (piperVoice.split('/').pop() ?? null) : null,
      detail: piperVoice ? undefined : 'piper binary found but no voice model — see voxshift-ml/setup_ml_stack.sh',
    })
  }

  // ── espeak-ng TTS — always-probed fallback ───────────────────────────────
  const espeakBin = (await which('espeak-ng')) ?? (await which('espeak'))
  runtimes.push({
    id: 'local:espeak-tts',
    name: 'espeak-ng (local TTS)',
    category: 'tts',
    available: Boolean(espeakBin),
    model: null,
    detail: espeakBin ? undefined : 'espeak-ng binary not found on PATH',
  })

  const rt: DetectedLocalRuntimes = { runtimes, ollamaBaseUrl, ollamaModels }
  cache = { at: Date.now(), rt }
  return rt
}
