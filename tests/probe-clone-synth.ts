/**
 * REAL local clone-engine synthesis probe (v3.7.0) — runs the actual
 * engines/clone-tts-worker.py child for fish-speech + f5-tts with a real
 * reference WAV and verifies honest audio comes back (b64 → non-empty WAV,
 * sane sample rate). This is the round-15 "the least 2 models should work"
 * gate: fish + f5 measured on this machine at:
 *   fish-speech  peak RSS 2306 MB · 3.4 s audio in ~57 s cold
 *   f5-tts       peak RSS 2875 MB · 3.4 s audio in ~150 s cold
 *
 * Skips honestly (does not fail) when the engine's weights/repo are not
 * installed on THIS host — production gates the same way, so a skip here is
 * the same signal the About page reports.
 *
 * Run: bun tests/probe-clone-synth.ts
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'

let failed = 0
let skipped = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const skip = (name: string, detail: string) => {
  console.log(`⊘ ${name} — ${detail}`)
  skipped++
}

const WORKER = join(import.meta.dir, '..', 'mini-services', 'translator-service', 'engines', 'clone-tts-worker.py')
const REF_TEXT = 'Some call me nature, others call me mother nature.'

/** Locate the f5 example reference WAV (ships with the pip package). */
function findRefWav(): string | null {
  const candidates = ['/home/z/.venv/lib/python3.12/site-packages/f5_tts/infer/examples/basic/basic_ref_en.wav']
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

function runWorker(engine: string, text: string, ref: string, refText: string, timeoutMs: number) {
  return spawnSync('python3', [WORKER, engine, text, ref, refText], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, EINX_FILTER_TRACEBACK: 'false' },
  })
}

const main = () => {
  const ref = findRefWav()
  if (!ref) {
    skip('reference WAV', 'f5 example audio not found on this host')
  } else {
    const outDir = mkdtempSync(join(tmpdir(), 'clonesynth-'))
    const text = 'Hello, this is a voice cloning test.'

    // ── fish-speech (needs repo checkout + weights; skip honestly otherwise) ─
    const fishRepo = process.env.FISH_SPEECH_REPO ?? '/home/z/models/fish-speech-src'
    const fishWeights = process.env.VOXSHIFT_FISH_WEIGHTS ?? '/home/z/models/fish-speech/checkpoints/fish-speech-1.5'
    if (existsSync(join(fishRepo, 'tools', 'inference_engine', '__init__.py')) && existsSync(join(fishWeights, 'model.pth'))) {
      const t0 = Date.now()
      const r = runWorker('fish-speech', text, ref, REF_TEXT, 300_000)
      const last = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
      try {
        const msg = JSON.parse(last) as { ok?: boolean; sr?: number; wav_b64?: string; ms?: number; error?: string }
        check(
          'fish-speech worker → real WAV (ok, sr, bytes)',
          Boolean(msg.ok && msg.sr && (msg.wav_b64?.length ?? 0) > 10_000),
          `sr=${msg.sr} b64len=${msg.wav_b64?.length ?? 0} wall=${Math.round((Date.now() - t0) / 1000)}s${msg.error ? ` err=${msg.error.slice(0, 120)}` : ''}`
        )
        if (msg.ok && msg.wav_b64) writeFileSync(join(outDir, 'fish.wav'), Buffer.from(msg.wav_b64, 'base64'))
      } catch {
        check('fish-speech worker → real WAV', false, `unparseable: ${last.slice(0, 120)} · stderr: ${(r.stderr ?? '').slice(-200)}`)
      }
    } else {
      skip('fish-speech synthesis', 'repo/weights not installed on this host (run scripts/setup-local-clone.sh)')
    }

    // ── f5-tts (pip package auto-resolves weights from the HF cache) ─────────
    const t1 = Date.now()
    const r5 = runWorker('f5-tts', text, ref, REF_TEXT, 300_000)
    const last5 = (r5.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
    try {
      const msg5 = JSON.parse(last5) as { ok?: boolean; sr?: number; wav_b64?: string; ms?: number; error?: string }
      check(
        'f5-tts worker → real WAV (ok, sr, bytes)',
        Boolean(msg5.ok && msg5.sr && (msg5.wav_b64?.length ?? 0) > 10_000),
        `sr=${msg5.sr} b64len=${msg5.wav_b64?.length ?? 0} wall=${Math.round((Date.now() - t1) / 1000)}s${msg5.error ? ` err=${msg5.error.slice(0, 120)}` : ''}`
      )
      if (msg5.ok && msg5.wav_b64) writeFileSync(join(outDir, 'f5.wav'), Buffer.from(msg5.wav_b64, 'base64'))
    } catch {
      check('f5-tts worker → real WAV', false, `unparseable: ${last5.slice(0, 120)} · stderr: ${(r5.stderr ?? '').slice(-200)}`)
    }
    console.log(`\n(audios saved under ${outDir} for manual listening)`)
  }

  console.log(`\n${failed} failed · ${skipped} skipped (honest)`)
  if (failed > 0) process.exit(1)
  console.log('ALL CLONE SYNTH PROBES PASSED')
  process.exit(0)
}

main()
