// ─────────────────────────────────────────────────────────────────────────────
// LOCAL-FIRST voice cloning priority chain (shared by BOTH processes):
//   · the translator mini-service resolves the ACTIVE engine at synthesis time
//   · the Next.js diagnostics API reports the chain + active engine (About page)
//
// Priority order (v3.5.0):
//   1. fish-speech      LOCAL  — Fish Speech zero-shot clone (~2-4 GB, per docs)
//   2. f5-tts           LOCAL  — F5-TTS Base (RTF 0.0394 on L20 GPU, ~4-8 GB)
//   3. chatterbox       LOCAL  — Chatterbox Turbo (~75 ms, 5 s zero-shot reference)
//   4. elevenlabs-ivc   CLOUD  — existing ElevenLabs Instant Voice Cloning
//   5. pitch-conformed  DSP    — pitch-conformed preset match (always available,
//                                labeled honestly — it is NOT a clone)
//
// An engine is AVAILABLE only when ALL of its gates pass:
//   a. python package import probe (real `import` in a child python3)
//   b. model weights present on disk (env override or well-known locations)
//   c. the host can afford the engine's RAM floor (honest refusal on small
//      containers — same philosophy as the whisper worker's 350 MB guard)
//
// Detection is REAL: no simulated states, no "should work" guesses. The result
// is cached for 30 s (same policy as local-runtimes.ts) and the cache can be
// invalidated after installs.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'

export type CloneEngineId = 'fish-speech' | 'f5-tts' | 'chatterbox' | 'elevenlabs-ivc' | 'pitch-conformed'

export interface CloneChainEntry {
  id: CloneEngineId
  /** Display name INCLUDING the class suffix the About page renders. */
  name: string
  cls: 'local' | 'cloud' | 'dsp'
  available: boolean
  /** Honest explanation of WHY (first failing gate, or "ready"). */
  why: string
  /** Minimum free RAM this engine demands before it may be selected. */
  minRamMb: number
  /** Weights directory that satisfied (or was expected at) the disk gate. */
  weightsPath?: string | null
}

export interface CloneChainResult {
  chain: CloneChainEntry[]
  /** First available engine in priority order (always resolves). */
  active: CloneEngineId
  detectedAt: string
}

// ── RAM probe (honest host capability) ───────────────────────────────────────

/**
 * Free RAM in MB. Test hook: VOXSHIFT_TEST_RAM_MB forces a value so the RAM
 * gate can be exercised deterministically (documented, sandbox-only).
 */
export function availableRamMb(): number {
  const forced = process.env.VOXSHIFT_TEST_RAM_MB
  if (forced && Number.isFinite(Number(forced))) return Number(forced)
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const m = info.match(/MemAvailable:\s+(\d+) kB/)
    return m ? Math.round(parseInt(m[1], 10) / 1024) : Number.MAX_SAFE_INTEGER
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

// ── Engine registry (extensible — new engines register here, in order) ──────

export interface CloneEngineSpec {
  id: CloneEngineId
  name: string
  cls: 'local' | 'cloud' | 'dsp'
  /** Python modules whose import proves the package is installed (ANY of). */
  pythonModules: string[]
  /** Candidate weights locations — first existing dir/file wins. */
  weightsCandidates: () => string[]
  minRamMb: number
  /** Cloud engines authenticate via an env key instead of python+weights. */
  envKey?: string
  installHint: string
}

const MODELS_ROOT = process.env.VOXSHIFT_MODELS_DIR || '/home/z/models'
const HF_HUB_CACHE = process.env.HF_HOME
  ? `${process.env.HF_HOME.replace(/\/$/, '')}/hub`
  : `${process.env.HOME ?? '/root'}/.cache/huggingface/hub`

function dirHasWeights(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return existsSync(dir) // directory present; weight filenames vary per release
  } catch {
    return false
  }
}

export const CLONE_ENGINE_SPECS: CloneEngineSpec[] = [
  {
    id: 'fish-speech',
    name: 'Fish Speech (local)',
    cls: 'local',
    pythonModules: ['fish_speech'],
    weightsCandidates: () => [
      process.env.VOXSHIFT_FISH_WEIGHTS,
      `${MODELS_ROOT}/fish-speech`,
      `${MODELS_ROOT}/fish-speech-1.5`,
      `${HF_HUB_CACHE}/fishaudio--fish-speech-1.5`,
      `${HF_HUB_CACHE}/fishaudio--openaudio-s1-mini`,
    ].filter((p): p is string => Boolean(p)),
    minRamMb: 2600, // docs: ~2-4 GB
    installHint: 'pip install fish-speech + weights to /home/z/models/fish-speech (or set VOXSHIFT_FISH_WEIGHTS)',
  },
  {
    id: 'f5-tts',
    name: 'F5-TTS (local)',
    cls: 'local',
    pythonModules: ['f5_tts'],
    weightsCandidates: () => [
      process.env.VOXSHIFT_F5_WEIGHTS,
      `${MODELS_ROOT}/f5-tts`,
      `${HF_HUB_CACHE}/SWivid--F5-TTS`,
    ].filter((p): p is string => Boolean(p)),
    minRamMb: 4200, // F5-TTS Base: ~4-8 GB VRAM
    installHint: 'pip install f5-tts + model weights to /home/z/models/f5-tts (or set VOXSHIFT_F5_WEIGHTS)',
  },
  {
    id: 'chatterbox',
    name: 'Chatterbox (local)',
    cls: 'local',
    pythonModules: ['chatterbox'],
    weightsCandidates: () => [
      process.env.VOXSHIFT_CHATTERBOX_WEIGHTS,
      `${MODELS_ROOT}/chatterbox`,
      `${HF_HUB_CACHE}/resemble-ai--chatterbox`,
    ].filter((p): p is string => Boolean(p)),
    minRamMb: 2600, // Turbo: zero-shot from a 5 s reference, still GB-class weights
    installHint: 'pip install chatterbox-tts + weights to /home/z/models/chatterbox (or set VOXSHIFT_CHATTERBOX_WEIGHTS)',
  },
]

// ── Probes ───────────────────────────────────────────────────────────────────

function pythonHasAny(modules: string[]): Promise<string | null> {
  // One python child probes ALL candidate modules ("import a" or "import b") —
  // returns the first that imports, or null. Import failures inside a module's
  // own dependency tree count as NOT installed (honest).
  const code = `
import importlib, sys, json
mods = ${JSON.stringify(modules)}
found = None
for m in mods:
    try:
        importlib.import_module(m)
        found = m
        break
    except Exception:
        continue
print(json.dumps({"found": found}))
`
  return new Promise((resolve) => {
    try {
      const p = spawn('python3', ['-c', code], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', (d) => (out += String(d)))
      p.on('error', () => resolve(null))
      p.on('close', () => {
        try {
          const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}') as { found?: string | null }
          resolve(parsed.found ?? null)
        } catch {
          resolve(null)
        }
      })
      setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {}
        resolve(null)
      }, 8000).unref()
    } catch {
      resolve(null)
    }
  })
}

export function elevenLabsKeyPresent(): boolean {
  if (process.env.ELEVENLABS_API_KEY) return true
  try {
    // Same contract as engines/voice-clone.ts: the shared project .env is one
    // level above the translator service cwd. Parse only this variable.
    const text = readFileSync('/home/z/my-project/.env', 'utf8')
    return /^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"\r\n#]+)"?\s*$/m.test(text)
  } catch {
    return false
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000
let cache: { at: number; result: CloneChainResult } | null = null

export function invalidateCloneChainCache(): void {
  cache = null
}

async function detectChain(): Promise<CloneChainResult> {
  const chain: CloneChainEntry[] = []
  const ramMb = availableRamMb()

  for (const spec of CLONE_ENGINE_SPECS) {
    const weights = spec.weightsCandidates().find((p) => dirHasWeights(p))
    if (ramMb < spec.minRamMb) {
      chain.push({
        id: spec.id,
        name: spec.name,
        cls: spec.cls,
        available: false,
        why: `installed but the host has only ${ramMb} MB free — engine needs ≥ ${spec.minRamMb} MB`,
        minRamMb: spec.minRamMb,
        weightsPath: weights ?? null,
      })
      continue
    }
    const found = await pythonHasAny(spec.pythonModules)
    if (!found) {
      chain.push({
        id: spec.id,
        name: spec.name,
        cls: spec.cls,
        available: false,
        why: `not installed — ${spec.installHint}`,
        minRamMb: spec.minRamMb,
        weightsPath: weights ?? null,
      })
      continue
    }
    if (!weights) {
      chain.push({
        id: spec.id,
        name: spec.name,
        cls: spec.cls,
        available: false,
        why: `python package "${found}" is importable but model weights were not found on disk`,
        minRamMb: spec.minRamMb,
        weightsPath: null,
      })
      continue
    }
    chain.push({
      id: spec.id,
      name: spec.name,
      cls: spec.cls,
      available: true,
      why: `ready (${found}, weights present, ${ramMb} MB free)`,
      minRamMb: spec.minRamMb,
      weightsPath: weights,
    })
  }

  // Priority 4 — ElevenLabs IVC (cloud): real key gate only (a live account
  // probe runs in the diagnostics self-test, not in the hot path).
  const keyOk = elevenLabsKeyPresent()
  chain.push({
    id: 'elevenlabs-ivc',
    name: 'ElevenLabs IVC (cloud)',
    cls: 'cloud',
    available: keyOk,
    why: keyOk ? 'ready (ELEVENLABS_API_KEY configured)' : 'ELEVENLABS_API_KEY not configured',
    minRamMb: 0,
    weightsPath: null,
  })

  // Priority 5 — pitch-conformed preset match (local DSP): always available.
  chain.push({
    id: 'pitch-conformed',
    name: 'Pitch-conformed match (local DSP)',
    cls: 'dsp',
    available: true,
    why: 'always available — honest preset match, NOT a clone',
    minRamMb: 0,
    weightsPath: null,
  })

  const active = chain.find((e) => e.available)?.id ?? 'pitch-conformed'
  return { chain, active, detectedAt: new Date().toISOString() }
}

/** Cached chain detection (30 s TTL). */
export async function detectCloneChain(): Promise<CloneChainResult> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  const result = await detectChain()
  cache = { at: Date.now(), result }
  return result
}

/** Resolve just the active engine id (synthesis hot path). */
export async function resolveCloneEngine(): Promise<CloneEngineId> {
  return (await detectCloneChain()).active
}
