// ─────────────────────────────────────────────────────────────────────────────
// LOCAL-FIRST voice cloning priority chain (shared by BOTH processes):
//   · the translator mini-service resolves the ACTIVE engine at synthesis time
//   · the Next.js diagnostics API reports the chain + active engine (About page)
//
// Priority order (v3.8.0):
//   1. fish-speech        LOCAL  — Fish Speech zero-shot clone (~2-4 GB, per docs)
//   2. f5-tts             LOCAL  — F5-TTS Base (RTF 0.0394 on L20 GPU, ~4-8 GB)
//   3. chatterbox         LOCAL  — Chatterbox Turbo (~75 ms, 5 s zero-shot reference)
//   4. satellite-clone    CLOUD  — YOUR host running mini-services/clone-satellite
//                                  (real engines on RAM-rich hardware, v3.8.0)
//   5. elevenlabs-ivc     CLOUD  — existing ElevenLabs Instant Voice Cloning
//   6. timbre-conformed   DSP    — F0 + spectral-envelope morph toward the
//                                  enrolled reference (v3.8.0; no RAM floor)
//   7. pitch-conformed    DSP    — pitch-conformed preset match (always available,
//                                  labeled honestly — it is NOT a clone)
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

export type CloneEngineId =
  | 'fish-speech'
  | 'f5-tts'
  | 'chatterbox'
  | 'satellite-clone'
  | 'elevenlabs-ivc'
  | 'timbre-conformed'
  | 'pitch-conformed'

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
  /** Honest usable-RAM numbers behind the gates (About page renders this). */
  ram: RamProbe
  detectedAt: string
}

// ── RAM probe (honest host capability) ───────────────────────────────────────

export interface RamProbe {
  /** Usable MB for a new allocation — the value the RAM gates compare. */
  usableMb: number
  /** Where the number came from (rendered on the About page). */
  source: 'override' | 'test' | 'meminfo-cgroup-synced' | 'meminfo-capped-by-cgroup' | 'meminfo'
  /** cgroup memory limit (v2 memory.max / v1 memory.limit_in_bytes), MB. */
  cgroupLimitMb: number | null
  /** Host meminfo numbers, MB (as the OS reports them). */
  meminfoTotalMb: number | null
  meminfoAvailableMb: number | null
  /** Human explanation, e.g. why a 100 GB host still yields a small usable. */
  note: string
}

function readMeminfo(): { totalMb: number | null; availableMb: number | null } {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const total = info.match(/MemTotal:\s+(\d+) kB/)
    const avail = info.match(/MemAvailable:\s+(\d+) kB/)
    return {
      totalMb: total ? Math.round(parseInt(total[1], 10) / 1024) : null,
      availableMb: avail ? Math.round(parseInt(avail[1], 10) / 1024) : null,
    }
  } catch {
    return { totalMb: null, availableMb: null }
  }
}

function readCgroupLimitMb(): number | null {
  try {
    // cgroup v2
    const v2 = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (v2 && v2 !== 'max') return Math.round(parseInt(v2, 10) / (1024 * 1024))
  } catch {}
  try {
    // cgroup v1
    const v1 = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim()
    const n = parseInt(v1, 10)
    // values > 2^40 (e.g. 0x7FFFFFFFFFFFF000) mean "no limit"
    if (Number.isFinite(n) && n > 0 && n < 2 ** 40) return Math.round(n / (1024 * 1024))
  } catch {}
  return null
}

/**
 * Honest usable-RAM probe.
 *
 * Priority:
 *   1. VOXSHIFT_RAM_BUDGET_MB  — operator-declared budget (wins outright; use
 *      when the platform limit was raised and the old cgroup reading is stale,
 *      or to opt in on soft limits). Rendered as an override in the UI.
 *   2. VOXSHIFT_TEST_RAM_MB    — deterministic test hook.
 *   3. Real probe:
 *        · /proc/meminfo MemAvailable (kernel's own reclaim-aware estimate)
 *        · the cgroup memory limit — the piece a shared host hides: on many
 *          platforms (Railway included) /proc/meminfo describes the HOST
 *          (hundreds of GB shared by all projects) while the cgroup caps THIS
 *          container at its own slice. When meminfo.MemTotal ≫ cgroup limit
 *          we cap usable = min(MemAvailable, cgroupLimit) so the gates never
 *          promise RAM the platform will refuse to give (OOM-kill otherwise).
 *        · When meminfo.MemTotal ≈ cgroup limit the meminfo view is already
 *          cgroup-scoped (lxcfs-style) and MemAvailable alone is correct.
 */
export function ramProbe(): RamProbe {
  const override = process.env.VOXSHIFT_RAM_BUDGET_MB
  if (override && Number.isFinite(Number(override))) {
    return {
      usableMb: Math.max(0, Math.round(Number(override))),
      source: 'override',
      cgroupLimitMb: readCgroupLimitMb(),
      meminfoTotalMb: null,
      meminfoAvailableMb: null,
      note: `operator override VOXSHIFT_RAM_BUDGET_MB=${override}`,
    }
  }
  const test = process.env.VOXSHIFT_TEST_RAM_MB
  if (test && Number.isFinite(Number(test))) {
    return {
      usableMb: Number(test),
      source: 'test',
      cgroupLimitMb: null,
      meminfoTotalMb: null,
      meminfoAvailableMb: null,
      note: 'test hook VOXSHIFT_TEST_RAM_MB',
    }
  }
  const mem = readMeminfo()
  const limitMb = readCgroupLimitMb()
  if (mem.availableMb === null) {
    return {
      usableMb: Number.MAX_SAFE_INTEGER,
      source: 'meminfo',
      cgroupLimitMb: limitMb,
      meminfoTotalMb: mem.totalMb,
      meminfoAvailableMb: null,
      note: 'meminfo unreadable — RAM gate open',
    }
  }
  const synced = limitMb !== null && mem.totalMb !== null && Math.abs(mem.totalMb - limitMb) <= Math.max(64, limitMb * 0.05)
  if (synced) {
    return {
      usableMb: mem.availableMb,
      source: 'meminfo-cgroup-synced',
      cgroupLimitMb: limitMb,
      meminfoTotalMb: mem.totalMb,
      meminfoAvailableMb: mem.availableMb,
      note: `container-scoped memory: ${mem.availableMb} MB available of the ${limitMb} MB cgroup slice`,
    }
  }
  if (limitMb !== null) {
    const usable = Math.min(mem.availableMb, limitMb)
    return {
      usableMb: usable,
      source: 'meminfo-capped-by-cgroup',
      cgroupLimitMb: limitMb,
      meminfoTotalMb: mem.totalMb,
      meminfoAvailableMb: mem.availableMb,
      note:
        `host reports ${mem.availableMb} MB free, but this container is cgroup-capped to ` +
        `${limitMb} MB — the platform slice is what binds. Raise the service memory ` +
        '(or set VOXSHIFT_RAM_BUDGET_MB) to unlock the GB-class local engines.',
    }
  }
  return {
    usableMb: mem.availableMb,
    source: 'meminfo',
    cgroupLimitMb: null,
    meminfoTotalMb: mem.totalMb,
    meminfoAvailableMb: mem.availableMb,
    note: `${mem.availableMb} MB available (no cgroup limit detected)`,
  }
}

/** Free RAM in MB (compat wrapper used by the gates and health rows). */
export function availableRamMb(): number {
  return ramProbe().usableMb
}

// ── Engine registry (extensible — new engines register here, in order) ──────

export interface CloneEngineSpec {
  id: CloneEngineId
  name: string
  cls: 'local' | 'cloud' | 'dsp'
  /** Python modules whose import proves the package is installed (ANY of). */
  pythonModules: string[]
  /**
   * Optional file-existence probe that ALSO proves installability — used by
   * engines that ship as a source checkout rather than a pip package
   * (fish-speech v1.5.0: the official local surface lives in the repo's
   * tools/inference_engine, not behind `import fish_speech`).
   */
  fileProbe?: () => string | null
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
    // v1.5.0 ships as a source checkout — the official local synthesis surface
    // (tools.inference_engine.TTSInferenceEngine) exists only in the repo.
    fileProbe: () => {
      const repos = [
        process.env.FISH_SPEECH_REPO,
        `${MODELS_ROOT}/fish-speech-src`,
        '/opt/voxshift/models/fish-speech-src',
      ].filter((p): p is string => Boolean(p))
      for (const repo of repos) {
        if (existsSync(`${repo}/tools/inference_engine/__init__.py`)) return repo
      }
      return null
    },
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
    minRamMb: 2900, // measured CPU peak RSS 2875 MB across two real runs (2-core sandbox); +1% margin — the old 4200 was the GPU-docs number
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
  const ram = ramProbe()
  const ramMb = ram.usableMb

  for (const spec of CLONE_ENGINE_SPECS) {
    const weights = spec.weightsCandidates().find((p) => dirHasWeights(p))
    if (ramMb < spec.minRamMb) {
      chain.push({
        id: spec.id,
        name: spec.name,
        cls: spec.cls,
        available: false,
        why: `RAM gate: usable ${ramMb} MB (${ram.source}) < required ${spec.minRamMb} MB${ram.cgroupLimitMb ? ` — container cgroup cap ${ram.cgroupLimitMb} MB` : ''}`,
        minRamMb: spec.minRamMb,
        weightsPath: weights ?? null,
      })
      continue
    }
    const found = await pythonHasAny(spec.pythonModules)
    const fileHit = spec.fileProbe?.() ?? null
    if (!found && !fileHit) {
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
        why: `${fileHit ? `source checkout ${fileHit}` : `python package "${found}"`} is present but model weights were not found on disk`,
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
      why: `ready (${fileHit ? `source ${fileHit}` : found}, weights present, ${ramMb} MB usable by ${ram.source})`,
      minRamMb: spec.minRamMb,
      weightsPath: weights,
    })
  }

  // Priority 4 — SATELLITE clone (v3.8.0): a host YOU control running the
  // real engines (mini-services/clone-satellite). The one-switch answer to
  // "the platform caps my container at ~1 GB": the container stays small,
  // the cloning quality runs on hardware that can afford it.
  const satelliteUrl = (process.env.VOXSHIFT_SATELLITE_CLONE_URL ?? '').trim()
  chain.push({
    id: 'satellite-clone',
    name: 'Satellite clone (your host)',
    cls: 'cloud',
    available: Boolean(satelliteUrl),
    why: satelliteUrl
      ? `ready (VOXSHIFT_SATELLITE_CLONE_URL configured — ${satelliteUrl})`
      : 'not configured — run mini-services/clone-satellite on any RAM-rich machine and set VOXSHIFT_SATELLITE_CLONE_URL to upgrade clone profiles to real Fish Speech / F5-TTS / Chatterbox',
    minRamMb: 0,
    weightsPath: null,
  })

  // Priority 5 — ElevenLabs IVC (cloud): real key gate only (a live account
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

  // Priority 6 — timbre-conformed match (v3.8.0 local DSP): F0 + spectral
  // envelope morph toward the enrolled reference. Always offered; it needs a
  // reference WAV on disk to actually morph (falls through without one).
  chain.push({
    id: 'timbre-conformed',
    name: 'Timbre-conformed match (local DSP)',
    cls: 'dsp',
    available: true,
    why: 'always available — F0 + spectral-envelope morph toward the enrolled reference (needs a reference WAV; without one it falls through to pitch-conformed)',
    minRamMb: 0,
    weightsPath: null,
  })

  // Priority 7 — pitch-conformed preset match (local DSP): always available.
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
  return { chain, active, ram, detectedAt: new Date().toISOString() }
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
