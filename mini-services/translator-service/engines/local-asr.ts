// ─────────────────────────────────────────────────────────────────────────────
// LOCAL ASR engine (§14) — policy-registry driven (v3.6.0).
// API: localASR(wavBase64, lang) → { text, lang? } — called by the pipeline's
// routedCall('asr', { local: … }) with 16 kHz mono WAV input.
//
// LANGUAGE POLICY REGISTRY (v3.5.0 — extensibility contract):
// Each language declares { primary engine, vosk model dir, whisper size } in
// ASR_LANGUAGE_POLICIES. Adding a language = registerASRLanguage({ lang,
// primary, voskModel, … }) — NO core branch changes. Current benchmark-backed
// policy (2026-10):
//   fa → vosk small (near-perfect fa, RTF 0.16 — whisper tiny/base garble fa)
//   en → faster-whisper tiny resident (RTF 0.08, punctuation) → vosk-en
//
// CODE-SWITCHING (v3.6.0): a policy may declare `codeSwitchWith` — the partner
// language embedded inside speech (Persian sentences carry English words and
// vice-versa in real conversations). For those languages localASR runs BOTH
// engines in parallel — the resident multilingual whisper (auto-detect + word
// timestamps) and the vosk primary — and MERGES the word timelines: words in
// the primary language's script come from vosk (better quality), words in the
// other script come from whisper (vosk cannot produce them at all). English
// utterances are detected by the whisper side and returned directly, which
// fixes "English detected as Persian" in AUTO mode (the old code transcribed
// EVERY auto utterance with the fa model). whisper.cpp remains a secondary
// option when its binary + ggml model exist.
//
// Operational guards (unchanged): RAM floor ≥ 350 MB for the resident worker,
// lazy spawn on first demand, 4-min idle unload — mirroring the piper pool.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync } from 'fs'
import { detectLocalRuntimes } from '../providers/local-runtimes'

const MODELS_ROOT = process.env.VOXSHIFT_MODELS_DIR || '/home/z/models'

// ── ASR language policy registry (v3.5.0 / code-switch v3.6.0) ──────────────

export interface ASRLanguagePolicy {
  /** BCP-47 prefix the policy matches (case-insensitive startsWith). */
  lang: string
  /** Engine tried FIRST for this language ('whisper' = resident faster-whisper). */
  primary: 'vosk' | 'whisper'
  /** vosk model directory under MODELS_ROOT (vosk is the universal fallback tier). */
  voskModel: string
  /** Whisper model size for the resident worker (primary = 'whisper'). */
  whisperModel?: string
  /** Partner language embedded in speech (code-switching dual-run, v3.6.0). */
  codeSwitchWith?: string
  /** Script of the language's native writing system — drives the merge rule
   *  (words in this script prefer vosk, words in the partner's script come
   *  from whisper). Derived from the lang code when omitted. */
  script?: 'persian' | 'latin'
  /** Measured justification for the policy (surfaced in diagnostics). */
  benchmarkNote?: string
}

const ASR_LANGUAGE_POLICIES: ASRLanguagePolicy[] = [
  {
    lang: 'fa',
    primary: 'vosk',
    voskModel: 'vosk-model-small-fa-0.42',
    codeSwitchWith: 'en',
    benchmarkNote: 'whisper tiny/base garble fa (RTF ≥ 1.0) — vosk small near-perfect, RTF 0.16',
  },
  {
    lang: 'en',
    primary: 'whisper',
    whisperModel: 'tiny',
    voskModel: 'vosk-model-small-en-us-0.15',
    benchmarkNote: 'whisper tiny RTF 0.08 with punctuation vs vosk-en RTF 0.22 without',
  },
]

/** Default policy for languages with no registered entry (en is the nearest). */
const ASR_DEFAULT_POLICY_LANG = 'en'

/**
 * Register (or replace) a language policy — the ONLY step needed to add a new
 * language to local ASR: drop the vosk/whisper model on disk, then register
 * its model path here. Unknown request languages resolve to the default.
 */
export function registerASRLanguage(policy: ASRLanguagePolicy): void {
  const normalized: ASRLanguagePolicy = { ...policy, lang: policy.lang.toLowerCase() }
  const i = ASR_LANGUAGE_POLICIES.findIndex((p) => p.lang === normalized.lang)
  if (i >= 0) ASR_LANGUAGE_POLICIES[i] = normalized
  else ASR_LANGUAGE_POLICIES.push(normalized)
}

/** Read-only snapshot of the active policies (diagnostics / About page). */
export function asrLanguagePolicies(): readonly ASRLanguagePolicy[] {
  return ASR_LANGUAGE_POLICIES
}

function resolveASRPolicy(lang?: string): ASRLanguagePolicy {
  const l = (lang || ASR_DEFAULT_POLICY_LANG).toLowerCase()
  return (
    ASR_LANGUAGE_POLICIES.find((p) => l.startsWith(p.lang)) ??
    ASR_LANGUAGE_POLICIES.find((p) => p.lang === ASR_DEFAULT_POLICY_LANG) ??
    ASR_LANGUAGE_POLICIES[0]
  )
}

const VOSK_PY = `
import sys, json, wave
from vosk import Model, KaldiRecognizer, SetLogLevel
wav_path, model_path = sys.argv[1], sys.argv[2]
SetLogLevel(-1)
wf = wave.open(wav_path, 'rb')
model = Model(model_path)
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(True)
parts = []
words = []
def collect(res):
    t = res.get('text', '')
    if t:
        parts.append(t)
    for w in res.get('result', []) or []:
        try:
            words.append({'w': w.get('word', ''), 'start': float(w.get('start', 0)), 'end': float(w.get('end', 0))})
        except Exception:
            pass
while True:
    data = wf.readframes(8000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        collect(json.loads(rec.Result()))
collect(json.loads(rec.FinalResult()))
text = ' '.join(t for t in parts if t).strip()
print(json.dumps({'text': text, 'words': words}))
`

/** One word with timestamps from either engine (vosk / faster-whisper). */
export interface AsrWord {
  w: string
  start: number
  end: number
}

export interface VoskResult {
  text: string
  words: AsrWord[]
}

export interface WhisperResult {
  text: string
  lang: string
  words: AsrWord[]
}

/** Resolve the vosk model dir for a language FROM THE POLICY REGISTRY. */
function pickVoskModel(lang: string): string | null {
  const policy = resolveASRPolicy(lang)
  const preferred = `${MODELS_ROOT}/${policy.voskModel}`
  if (existsSync(preferred)) return preferred
  // Preferred dir missing — fall back to ANY registered model that exists
  // (honest degradation over refusal; the caller surfaces which model served).
  for (const p of ASR_LANGUAGE_POLICIES) {
    if (p.lang === policy.lang) continue
    const dir = `${MODELS_ROOT}/${p.voskModel}`
    if (existsSync(dir)) return dir
  }
  return null
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

async function voskTranscribe(wavBase64: string, lang: string): Promise<VoskResult> {
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
    const parsed = JSON.parse(line) as { text?: string; words?: AsrWord[] }
    const words = Array.isArray(parsed.words)
      ? parsed.words.filter((w) => w && typeof w.w === 'string' && Number.isFinite(w.start))
      : []
    return { text: (parsed.text ?? '').trim(), words }
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

// ── faster-whisper resident worker (multilingual since v3.6.0) ─────────────
// Benchmark 2026-10 (CPU int8): en RTF 0.08 with punctuation vs vosk-en RTF
// 0.22 without; PURE fa garbles at tiny/base → vosk stays the fa primary.
// The same tiny model, however, DETECTS the language and renders embedded
// English words inside Persian speech — the dual-run merge (v3.6.0) uses it
// for code-switching and for honest auto language detection. The worker is
// spawned lazily on first local-ASR demand and killed after an idle window,
// mirroring the piper workers.

const WHISPER_IDLE_MS = 4 * 60_000
const WHISPER_MIN_AVAIL_MB = 350 // refuse to spawn if the host can't afford it

interface WhisperWorker {
  proc: ReturnType<typeof spawn>
  ready: Promise<void>
  lastUsed: number
  /** Model size this worker was booted with (policy may request another). */
  model: string
}

let whisperWorker: WhisperWorker | null = null
let whisperIdleTimer: ReturnType<typeof setTimeout> | null = null

function freeMemMB(): number {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const m = info.match(/MemAvailable:\s+(\d+) kB/)
    return m ? Math.round(parseInt(m[1], 10) / 1024) : Number.MAX_SAFE_INTEGER
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function killWhisperWorker(): void {
  const w = whisperWorker
  whisperWorker = null
  if (whisperIdleTimer) {
    clearTimeout(whisperIdleTimer)
    whisperIdleTimer = null
  }
  if (w) {
    try {
      w.proc.kill('SIGKILL')
    } catch {}
  }
}

// v3.8.0: model selectable via VOXSHIFT_WHISPER_MODEL ('tiny' bundled default;
// 'base' upgrades embedded-English + accent capture at ~2× RTF, still int8).
function spawnWhisperWorker(
  modelSize = process.env.VOXSHIFT_WHISPER_MODEL?.trim() || 'tiny'
): WhisperWorker | null {
  if (freeMemMB() < WHISPER_MIN_AVAIL_MB) return null
  const script = join(dirname(fileURLToPath(import.meta.url)), 'whisper-worker.py')
  const proc = spawn('python3', [script, modelSize], { stdio: ['pipe', 'pipe', 'pipe'] })
  const w: WhisperWorker = { proc, ready: null as unknown as Promise<void>, lastUsed: Date.now(), model: modelSize }
  w.ready = new Promise<void>((resolve, reject) => {
    let buf = ''
    // 90 s (v3.8.0): a non-bundled model (e.g. VOXSHIFT_WHISPER_MODEL=base)
    // downloads from HF on first boot — 30 s killed that cold boot mid-download.
    const timer = setTimeout(() => reject(new Error('whisper worker boot timeout')), 90_000)
    const onData = (d: string) => {
      buf += d
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { type?: string; error?: string }
          if (msg.type === 'ready') {
            clearTimeout(timer)
            resolve()
            return
          }
          if (msg.type === 'fatal') {
            clearTimeout(timer)
            reject(new Error(msg.error ?? 'whisper worker fatal'))
            return
          }
        } catch {
          // stray log noise — ignore
        }
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', () => undefined)
    proc.on('close', () => {
      if (whisperWorker === w) killWhisperWorker()
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  w.ready.catch(() => killWhisperWorker())
  whisperWorker = w
  return w
}

export function whisperTranscribe(
  wavBase64: string,
  modelSize = 'tiny',
  opts: { lang?: string | null; timeoutMs?: number } = {}
): Promise<WhisperResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  let w = whisperWorker
  if (w && w.model !== modelSize) {
    killWhisperWorker() // policy changed the model — respawn with the right one
    w = null
  }
  w = w ?? spawnWhisperWorker(modelSize)
  if (!w) return Promise.reject(new Error('whisper worker declined: not enough free RAM'))
  return w.ready.then(
    () =>
      new Promise<WhisperResult>((resolve, reject) => {
        const id = `wr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        let buf = ''
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('whisper ASR timed out'))
        }, timeoutMs)
        const onData = (d: string) => {
          buf += d
          let idx: number
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line) continue
            try {
              const msg = JSON.parse(line) as {
                type?: string
                id?: string
                ok?: boolean
                text?: string
                lang?: string
                words?: AsrWord[]
                error?: string
              }
              if (msg.type === 'result' && msg.id === id) {
                cleanup()
                if (msg.ok) {
                  resolve({
                    text: (msg.text ?? '').trim(),
                    lang: msg.lang ?? opts.lang ?? 'en',
                    words: Array.isArray(msg.words)
                      ? msg.words.filter((x) => x && typeof x.w === 'string' && Number.isFinite(x.start))
                      : [],
                  })
                } else reject(new Error(msg.error ?? 'whisper ASR failed'))
                return
              }
            } catch {
              // stray log noise — ignore
            }
          }
        }
        const cleanup = () => {
          clearTimeout(timer)
          w.proc.stdout?.off('data', onData)
        }
        w.proc.stdout?.on('data', onData)
        w.lastUsed = Date.now()
        w.proc.stdin?.write(JSON.stringify({ id, wav_b64: wavBase64, lang: opts.lang ?? null }) + '\n')
        // Idle unload — same policy as the piper worker pool.
        if (whisperIdleTimer) clearTimeout(whisperIdleTimer)
        whisperIdleTimer = setTimeout(() => {
          if (whisperWorker && Date.now() - whisperWorker.lastUsed >= WHISPER_IDLE_MS) killWhisperWorker()
        }, WHISPER_IDLE_MS + 1_000)
      })
  )
}

// ── Code-switching word-timeline merge (v3.6.0) ─────────────────────────────

const PERSIAN_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/
const LATIN_RE = /[A-Za-z]/

/** Native script of a policy language (Arabic-range scripts vs Latin). */
function scriptForLang(lang: string): 'persian' | 'latin' {
  return /^(fa|ar|ur|ps|he|fa-)/.test(lang) ? 'persian' : 'latin'
}

/** Coarse script of one token — 'other' covers numbers/punctuation-only. */
export function scriptOf(word: string): 'persian' | 'latin' | 'other' {
  if (PERSIAN_SCRIPT_RE.test(word)) return 'persian'
  if (LATIN_RE.test(word)) return 'latin'
  return 'other'
}

function overlaps(a: AsrWord, b: AsrWord, eps = 0.02): boolean {
  return a.start < b.end - eps && b.start < a.end - eps
}

/** Near-overlap: spans intersect OR sit within `eps` of each other. Used for
 *  "vosk already covers this span" decisions — whisper's word timestamps lag
 *  vosk's slightly; without the tolerance a whisper garble sneaks into the
 *  gap right after a vosk word (measured: دارم → trailing 'دارن'). */
function nearOverlaps(a: AsrWord, b: AsrWord, eps = 0.12): boolean {
  return a.start - eps < b.end && b.start - eps < a.end
}

/**
 * Merge the vosk + whisper word timelines into one transcript (v3.6.0).
 * Rule: words in the PRIMARY script come from vosk when it captured that
 * time span (measurably better quality); words in the OTHER script come from
 * whisper (vosk cannot transcribe them at all — they used to vanish); gaps
 * are filled by whichever engine has the span. Pure functions — probed by
 * tests/integration + probe-asr-merge.ts.
 *
 * `trustForeign` — when whisper's detected language is one of the policy's
 * own pair (fa/en), its Latin-script words are trusted INSIDE vosk spans
 * (they are the embedded English). When whisper detected something ELSE
 * (measured: pure fa → 'pt'/'ar' with garbage transliteration), vosk wins
 * EVERY overlap and whisper only fills true gaps — the hijack is killed.
 */
export function mergeWords(
  voskWords: AsrWord[],
  whisperWords: AsrWord[],
  primaryScript: 'persian' | 'latin',
  trustForeign = true
): string {
  const emitted: Array<AsrWord & { src: 'vosk' | 'whisper' }> = []
  const emittedSpanHas = (w: AsrWord) => emitted.some((e) => overlaps(e, w))

  // Whisper covers the whole utterance (multilingual) — walk its timeline.
  for (const wsw of [...whisperWords].sort((a, b) => a.start - b.start)) {
    const script = scriptOf(wsw.w)
    if (trustForeign && script !== 'other' && script !== primaryScript) {
      // Embedded foreign-language word — only whisper has it.
      emitted.push({ ...wsw, src: 'whisper' })
      continue
    }
    // Primary-script (or neutral/untrusted) span — prefer an overlapping vosk word.
    const voskHit = voskWords.find((vw) => !emittedSpanHas(vw) && nearOverlaps(vw, wsw))
    if (voskHit) {
      emitted.push({ ...voskHit, src: 'vosk' })
      // Mark the whisper word consumed so a later vosk word can't match it.
      continue
    }
    if (!emittedSpanHas(wsw)) emitted.push({ ...wsw, src: 'whisper' })
  }
  // vosk words whisper never covered (dropped / garbled) — append them too.
  for (const vw of voskWords) {
    if (!emittedSpanHas(vw)) emitted.push({ ...vw, src: 'vosk' })
  }
  emitted.sort((a, b) => a.start - b.start)
  // Dedup identical adjacent tokens (engines agreeing on the same word).
  const out: string[] = []
  for (const e of emitted) {
    const t = e.w.trim()
    if (t && out[out.length - 1]?.toLowerCase() !== t.toLowerCase()) out.push(t)
  }
  return out.join(' ').trim()
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

function latinTokens(text: string): number {
  return text.split(/\s+/).filter((t) => /[A-Za-z]{2,}/.test(t)).length
}

/** Local ASR result — `lang` is present when the engine detected it. */
export interface LocalASRResult {
  text: string
  lang?: string
  /** How the transcript was produced (diagnostics / honest telemetry). */
  via?: 'vosk' | 'whisper' | 'merged' | 'whisper-cpp'
}

/**
 * Transcribe 16 kHz mono WAV (base64) with a REAL on-machine engine.
 * Resolved from the LANGUAGE POLICY REGISTRY:
 *   declared en  → whisper(en, resident) → vosk-en → whisper.cpp
 *   declared fa  → dual-run (vosk-fa ∥ whisper auto-detect) + merge → vosk-fa
 *                  alone when whisper is unavailable → whisper text as salvage
 *   auto         → the SAME dual-run (this is what fixed "English detected
 *                  as Persian": detection now happens at the ASR layer)
 *   other        → that policy's primary engine → vosk fallback
 * Adding a language = registerASRLanguage() — no new branches here.
 */
export async function localASR(wavBase64: string, lang = 'en'): Promise<LocalASRResult> {
  const rt = await detectLocalRuntimes()
  const requested = (lang || 'en').toLowerCase()
  const policy = resolveASRPolicy(requested === 'auto' ? 'fa' : requested)
  const vosk = rt.runtimes.find((r) => r.id === 'local:vosk-asr')
  const whisper = rt.runtimes.find((r) => r.id === 'local:whisper-asr')
  const whisperResident = Boolean(whisper?.available)
  const dualRun =
    (requested === 'auto' || requested.startsWith(policy.lang)) &&
    policy.codeSwitchWith !== undefined &&
    whisperResident &&
    Boolean(vosk?.available)

  // ── Declared English: whisper pinned to en (accent-robust beam decode) ──
  if (requested.startsWith('en')) {
    if (whisperResident) {
      try {
        const r = await whisperTranscribe(wavBase64, policy.whisperModel ?? 'tiny', { lang: 'en' })
        if (r.text) return { text: r.text, lang: 'en', via: 'whisper' }
      } catch {
        /* fall through to vosk-en */
      }
    }
    if (vosk?.available) return { text: (await voskTranscribe(wavBase64, 'en')).text, via: 'vosk' }
    if (whisperResident) throw new Error('whisper ASR failed and vosk-en is not installed')
    if (whisper?.available) return { text: (await whisperCppTranscribe(wavBase64)).text, via: 'whisper-cpp' }
    throw new Error(
      `LOCAL ASR not configured on this machine — ${vosk?.detail ?? 'vosk detection failed'}; install per voxshift-ml/setup_ml_stack.sh`
    )
  }

  // ── Dual-run: fa (or auto) with a registered code-switch partner ─────────
  if (dualRun) {
    const [ws, vk] = await Promise.allSettled([
      whisperTranscribe(wavBase64, policy.whisperModel ?? 'tiny', { lang: null, timeoutMs: 45_000 }),
      voskTranscribe(wavBase64, policy.lang),
    ])
    const wsOk = ws.status === 'fulfilled' ? ws.value : null
    const vkOk = vk.status === 'fulfilled' ? vk.value : null
    // Whisper tiny occasionally misdetects Persian audio as a random
    // Latin-script language (measured: pure fa → 'pt' → garbage
    // transliteration) or an adjacent script ('ar'). Its timeline is still
    // usable for the MERGE, but only fully trusted when the detected language
    // is one of the policy's own pair (fa/en) — otherwise vosk wins every
    // overlap and whisper only fills true gaps (kills the hijack, keeps real
    // English tails whisper caught in its own spans).
    const wsLangUsable =
      wsOk !== null &&
      (wsOk.lang.startsWith(policy.lang) || (policy.codeSwitchWith ? wsOk.lang.startsWith(policy.codeSwitchWith) : false))
    if (wsOk?.text) {
      const persianChars = countMatches(wsOk.text, PERSIAN_SCRIPT_RE)
      const latinTok = latinTokens(wsOk.text)
      // English utterance → return whisper directly (fixes EN-as-FA detection).
      if (wsOk.lang === 'en' && persianChars < 3) {
        return { text: wsOk.text, lang: 'en', via: 'whisper' }
      }
      // Mixed fa+en → time-aligned merge (vosk for Persian, whisper for English).
      if (latinTok > 0 && vkOk?.words.length) {
        const merged = mergeWords(vkOk.words, wsOk.words, policy.script ?? scriptForLang(policy.lang), wsLangUsable)
        if (merged) return { text: merged, lang: 'fa', via: 'merged' }
        return { text: wsOk.text, lang: wsOk.lang, via: 'whisper' }
      }
      // Pure Persian → vosk wins when it produced anything.
      if (vkOk?.text) return { text: vkOk.text, lang: 'fa', via: 'vosk' }
      return { text: wsOk.text, lang: wsOk.lang, via: 'whisper' }
    }
    if (vkOk?.text) return { text: vkOk.text, lang: 'fa', via: 'vosk' }
    // BOTH failed — fall through to the single-engine attempts for honest errors.
  }

  // ── Single-engine paths (no dual-run possible / both dual legs failed) ───
  if (policy.primary === 'whisper' && whisperResident) {
    try {
      const r = await whisperTranscribe(wavBase64, policy.whisperModel ?? 'tiny', { lang: requested === 'auto' ? null : policy.lang, timeoutMs: 45_000 })
      if (r.text) return { text: r.text, lang: r.lang, via: 'whisper' }
    } catch {
      /* fall to vosk */
    }
  }
  if (vosk?.available) {
    return { text: (await voskTranscribe(wavBase64, policy.lang)).text, via: 'vosk' }
  }
  if (whisperResident) {
    const r = await whisperTranscribe(wavBase64, policy.whisperModel ?? 'tiny', { lang: null, timeoutMs: 45_000 })
    return { text: r.text, lang: r.lang, via: 'whisper' }
  }
  if (whisper?.available) {
    return { text: (await whisperCppTranscribe(wavBase64)).text, via: 'whisper-cpp' }
  }
  throw new Error(
    `LOCAL ASR not configured on this machine — ${vosk?.detail ?? 'vosk detection failed'}; install per voxshift-ml/setup_ml_stack.sh`
  )
}
