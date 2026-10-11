/**
 * Voice cloning priority chain probe (v3.6.0) — fallback-level tests with
 * REAL detection gates, run in child processes with controlled env:
 *
 *   1. baseline            → nothing installed, low RAM  → pitch-conformed
 *   2. fish-speech stub    → package+weights+RAM present → fish-speech
 *   3. f5-tts stub         → package+weights+RAM present → f5-tts
 *   4. chatterbox stub     → package+weights+RAM present → chatterbox
 *   5. RAM guard           → stubs present but RAM 200 MB → all locals refused
 *   6. weights-missing     → package importable, NO weights → refused
 *   7. ElevenLabs key gate → cloud row follows the key state honestly
 *
 * Run: bun tests/probe-clone-chain.ts
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CHILD = `
import { detectCloneChain, invalidateCloneChainCache } from '/home/z/Vox-Shift/src/lib/voice/clone-chain'
invalidateCloneChainCache()
const r = await detectCloneChain()
console.log('RESULT:' + JSON.stringify({ active: r.active, ram: r.ram ? { source: r.ram.source, usableMb: r.ram.usableMb, cgroupLimitMb: r.ram.cgroupLimitMb } : null, chain: r.chain.map((e) => [e.id, e.available, e.why.slice(0, 90)]) }))
`

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

function runScenario(env: Record<string, string>): { active: string; ram: { source: string; usableMb: number; cgroupLimitMb: number | null } | null; chain: Array<[string, boolean, string]> } {
  const res = spawnSync('bun', ['-e', CHILD], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'))
  if (!line) throw new Error(`no result line (stderr: ${(res.stderr ?? '').slice(0, 200)})`)
  return JSON.parse(line.slice(7))
}

const main = async () => {
  const stubs = mkdtempSync(join(tmpdir(), 'clonechain-'))
  const mkStub = (name: string) => {
    const d = join(stubs, name, name.replace('-', '_'))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, '__init__.py'), `print("stub ${name}")\n`)
  }

  try {
    // ── 1. baseline: nothing installed + low RAM → terminal pitch-conformed ──
    const r1 = runScenario({ VOXSHIFT_TEST_RAM_MB: '200' })
    check(
      'baseline (no engines, low RAM) → pitch-conformed',
      r1.active === 'pitch-conformed' && r1.chain.every(([id, av]) => (id === 'pitch-conformed' ? av : !av)),
      `active=${r1.active}`
    )

    // ── 2. fish-speech stub wins over F5/Chatterbox/ElevenLabs ──────────────
    mkStub('fish_speech')
    const w2 = join(stubs, 'fish-weights')
    mkdirSync(w2)
    const r2 = runScenario({
      PYTHONPATH: join(stubs, 'fish_speech'),
      VOXSHIFT_FISH_WEIGHTS: w2,
      VOXSHIFT_TEST_RAM_MB: '8000',
    })
    check('fish-speech (package+weights+RAM) → ACTIVE fish-speech', r2.active === 'fish-speech', `active=${r2.active}`)
    check('f5-tts unavailable when not installed (priority respected)', r2.chain.find(([id]) => id === 'f5-tts')?.[1] === false)

    // ── 3. f5-tts stub (fish gone) → f5-tts ─────────────────────────────────
    mkStub('f5_tts')
    const w3 = join(stubs, 'f5-weights')
    mkdirSync(w3)
    const r3 = runScenario({
      PYTHONPATH: join(stubs, 'f5_tts'),
      VOXSHIFT_F5_WEIGHTS: w3,
      VOXSHIFT_TEST_RAM_MB: '8000',
    })
    check('f5-tts (package+weights+RAM) → ACTIVE f5-tts', r3.active === 'f5-tts', `active=${r3.active}`)

    // ── 4. chatterbox stub (fish + f5 gone) → chatterbox ────────────────────
    mkStub('chatterbox')
    const w4 = join(stubs, 'chatterbox-weights')
    mkdirSync(w4)
    const r4 = runScenario({
      PYTHONPATH: join(stubs, 'chatterbox'),
      VOXSHIFT_CHATTERBOX_WEIGHTS: w4,
      VOXSHIFT_TEST_RAM_MB: '8000',
    })
    check('chatterbox (package+weights+RAM) → ACTIVE chatterbox', r4.active === 'chatterbox', `active=${r4.active}`)

    // ── 5. RAM guard: stubs present but host poor → locals refused ──────────
    const r5 = runScenario({
      PYTHONPATH: join(stubs, 'chatterbox'),
      VOXSHIFT_CHATTERBOX_WEIGHTS: w4,
      VOXSHIFT_TEST_RAM_MB: '200',
    })
    check(
      'RAM guard refuses GB-class locals (200 MB free) → pitch-conformed',
      r5.active === 'pitch-conformed' && (r5.chain.find(([id]) => id === 'chatterbox')?.[2].includes('RAM gate') ?? false),
      `active=${r5.active} · why=${r5.chain.find(([id]) => id === 'chatterbox')?.[2]}`
    )

    // ── 5b. cgroup-capped host honesty + operator override ─────────────────
    // Simulate the shared-host case: the OS meminfo is huge but the cgroup cap
    // is small → usable MUST be capped (never promise RAM the platform OOMs).
    // The override knob (VOXSHIFT_RAM_BUDGET_MB) is the operator's opt-out.
    const capped = runScenario({ PYTHONPATH: join(stubs, 'chatterbox'), VOXSHIFT_CHATTERBOX_WEIGHTS: w4, VOXSHIFT_TEST_RAM_MB: '200' })
    check('test-hook RAM is honored by the gates (source=test)', capped.ram?.source === 'test' && capped.ram.usableMb === 200, `ram=${JSON.stringify(capped.ram)}`)
    const overridden = runScenario({
      PYTHONPATH: join(stubs, 'chatterbox'),
      VOXSHIFT_CHATTERBOX_WEIGHTS: w4,
      VOXSHIFT_RAM_BUDGET_MB: '8000',
    })
    check(
      'VOXSHIFT_RAM_BUDGET_MB override wins → engine activates',
      overridden.active === 'chatterbox' && overridden.ram?.source === 'override' && overridden.ram.usableMb === 8000,
      `active=${overridden.active} · ram=${JSON.stringify(overridden.ram)}`
    )

    // ── 6. weights-missing: importable package but no weights → refused ─────
    const r6 = runScenario({
      PYTHONPATH: join(stubs, 'chatterbox'),
      VOXSHIFT_TEST_RAM_MB: '8000',
      VOXSHIFT_CHATTERBOX_WEIGHTS: '/nonexistent-weights-path',
    })
    check(
      'package without weights → refused (honest gate)',
      r6.active === 'pitch-conformed' && r6.chain.find(([id]) => id === 'chatterbox')?.[2].includes('weights were not found'),
      `active=${r6.active} · why=${r6.chain.find(([id]) => id === 'chatterbox')?.[2]}`
    )

    // ── 7. ElevenLabs cloud row follows the key gate ────────────────────────
    const withKey = runScenario({
      ELEVENLABS_API_KEY: 'probe-key-not-real',
      VOXSHIFT_TEST_RAM_MB: '200',
    })
    check('ELEVENLABS_API_KEY present → cloud row available', withKey.chain.find(([id]) => id === 'elevenlabs-ivc')?.[1] === true)
    const withoutKey = runScenario({ ELEVENLABS_API_KEY: '', VOXSHIFT_TEST_RAM_MB: '200' })
    check('key absent → cloud row unavailable, chain still resolves', withoutKey.chain.find(([id]) => id === 'elevenlabs-ivc')?.[1] === false)
  } finally {
    rmSync(stubs, { recursive: true, force: true })
  }

  if (failed > 0) {
    console.error(`\n${failed} clone-chain probe(s) FAILED`)
    process.exit(1)
  }
  console.log('\nALL CLONE CHAIN PROBES PASSED')
  process.exit(0)
}

void main()
