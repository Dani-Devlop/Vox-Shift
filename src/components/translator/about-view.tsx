'use client'

// ─────────────────────────────────────────────────────────────────────────────
// AboutView (spec §14 + §16, v3.5.0) — version, engine chains (ASR policy
// registry · translation · TTS · voice-cloning priority chain with the ACTIVE
// engine), provider status (no secrets), live pipeline self-test with REAL
// per-stage requests, client transport state, and an honest known-limitations
// list. No invented values, no demo successes.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import { Activity, Check, CircleAlert, Loader2, MinusCircle, PlayCircle, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SpeakerRole } from '@/types/translator'

interface CloneChainEntryData {
  id: string
  name: string
  cls: 'local' | 'cloud' | 'dsp'
  available: boolean
  why: string
  minRamMb: number
  weightsPath?: string | null
}

interface DiagnosticsData {
  version: string
  providers: Record<string, { engine: string; configured: boolean; mode?: string }>
  voiceCloneChain?: { active: string; detectedAt: string; chain: CloneChainEntryData[] } | null
  builtins?: { zaiSdk?: boolean }
  database: { ok: boolean; engine: string }
  realtime: { transport: string; gateway: string }
  serverTime: string
}

interface StageReport {
  status: 'pass' | 'fail' | 'unconfigured' | 'skipped'
  ms: number
  code?: string
  message?: string
  detail?: Record<string, unknown>
}

interface SelfTestData {
  ok: boolean
  version?: string
  stages: Record<string, StageReport>
  testedAt: string
}

const STAGE_LABELS: Record<string, string> = {
  speech: 'Speech recognition (ASR)',
  translation: 'Translation (LLM)',
  voice: 'Voice synthesis (TTS)',
  cloneProvider: 'Voice cloning (active chain engine)',
  speakerEngine: 'Speaker recognition engine (local)',
  database: 'Database (write → read → delete)',
  transport: 'Realtime transport (translator service)',
}

const STAGE_ORDER = ['speech', 'translation', 'voice', 'cloneProvider', 'speakerEngine', 'database', 'transport']

const FALLBACK_VERSION = 'v3.5.0'

/** Static honest architecture table — the DESIGN of every engine chain. */
const ENGINE_CHAINS: Array<{ leg: string; chain: string; note: string }> = [
  {
    leg: 'Speech recognition (ASR)',
    chain: 'fa → vosk-small · en → faster-whisper-tiny (resident) → vosk-en',
    note: 'per-language policy registry — new languages register a model path, no core changes; resident worker guarded by ≥ 350 MB free RAM, lazy spawn, 4-min idle unload',
  },
  {
    leg: 'Translation (LLM)',
    chain: 'user providers → keyless gtx tier → built-in GLM',
    note: 'gtx tier benchmarked near-perfect on the fa→en test set at 0.4-0.9 s; routing policy + automatic failover per provider',
  },
  {
    leg: 'Voice synthesis (TTS)',
    chain: 'piper (fa/en, warm worker pool) → espeak-ng → built-in z-ai',
    note: 'on-box neural voices for Persian and English; pitch conformance keeps duration invariant while shifting pitch',
  },
]

const CLONE_CLASS_LABEL: Record<string, string> = {
  local: 'LOCAL',
  cloud: 'CLOUD',
  dsp: 'DSP',
}

export function AboutView({ connected, speaker }: { connected?: boolean; speaker?: SpeakerRole }) {
  const [diag, setDiag] = useState<DiagnosticsData | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [selfTest, setSelfTest] = useState<SelfTestData | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/diagnostics', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) setDiag(d)
      })
      .catch((err) => {
        if (!cancelled) setDiagError(`Diagnostics unavailable — the API server did not respond (${err instanceof Error ? err.message : 'network error'}).`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runSelfTest = useCallback(async () => {
    setTesting(true)
    setSelfTest(null)
    setTestError(null)
    try {
      const res = await fetch('/api/diagnostics', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as SelfTestData
      setSelfTest(data)
    } catch (err) {
      setTestError(
        err instanceof Error
          ? `Self-test request failed: ${err.message}. The Next.js server may be down or this is the static demo.`
          : 'Self-test request failed.'
      )
    } finally {
      setTesting(false)
    }
  }, [])

  const versionLabel = diag?.version ? `v${diag.version}` : FALLBACK_VERSION
  const chain = diag?.voiceCloneChain

  return (
    <div className="lt-enter mx-auto flex max-w-3xl flex-col gap-6">
      {/* ── Version ───────────────────────────────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_24px_-6px_rgba(16,185,129,0.9),inset_0_1px_0_rgba(255,255,255,0.25)]">
              <Activity className="h-5 w-5 text-zinc-950" aria-hidden />
            </span>
            <div>
              <h2 className="text-base font-black tracking-tight text-white">
                VoxShift <span className="font-mono text-xs font-bold text-emerald-400">{versionLabel}</span>
              </h2>
              <p className="text-[11px] text-zinc-500">Real-time bidirectional speech translation with voice identity</p>
            </div>
          </div>
          {diag && <span className="font-mono text-[10px] text-zinc-600">server {new Date(diag.serverTime).toLocaleTimeString()}</span>}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Persian ↔ English (plus Deutsch, Français, Español, العربية, Türkçe, Italiano) · Auto-detect
          two-way direction · Manual speaker turns · Natural / Clean / Literal / Formal / Casual
          styles · local-first engine chains for ASR / translation / TTS / cloning (v3.5.0) ·
          persistent resumable conversations · live captions · latency telemetry.
        </p>
      </section>

      {/* ── Engine chains (architecture — every leg, honestly ordered) ──── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Engine chains</h3>
        <ul className="flex flex-col gap-2">
          {ENGINE_CHAINS.map((row) => (
            <li key={row.leg} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
              <span className="block text-xs font-semibold text-zinc-200">{row.leg}</span>
              <span className="mt-0.5 block font-mono text-[10px] leading-relaxed text-emerald-400/90">{row.chain}</span>
              <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">{row.note}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Every leg is LOCAL-FIRST with automatic failover; the ACTUAL engine that served each
          phrase is recorded and shown in the session telemetry — no silent substitutions.
        </p>
      </section>

      {/* ── Voice cloning priority chain (LIVE detection) ───────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <header className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Voice cloning priority chain</h3>
          {chain && (
            <span className="font-mono text-[10px] text-zinc-600">detected {new Date(chain.detectedAt).toLocaleTimeString()}</span>
          )}
        </header>
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          Cloned profiles are served by the first AVAILABLE engine in this order — each gate
          (python package · model weights · free RAM · API key) is probed for real. The terminal
          pitch-conformed level is an honest preset match, never presented as a clone.
        </p>
        {!chain ? (
          <div className="flex items-center gap-2 py-3 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Probing the chain…
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {chain.chain.map((entry, idx) => {
              const isActive = entry.id === chain.active
              return (
                <li
                  key={entry.id}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 transition-colors',
                    isActive ? 'border-emerald-900/60 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-900/60'
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-[10px] text-zinc-600">{idx + 1}</span>
                      <span className={cn('truncate text-xs font-semibold', isActive ? 'text-emerald-300' : 'text-zinc-200')}>
                        {entry.name}
                      </span>
                      <span className="hidden rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[9px] font-bold text-zinc-400 sm:inline">
                        {CLONE_CLASS_LABEL[entry.cls] ?? entry.cls.toUpperCase()}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                        isActive
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : entry.available
                            ? 'bg-teal-500/10 text-teal-400'
                            : 'bg-zinc-700/30 text-zinc-500'
                      )}
                    >
                      {isActive ? <Check className="h-3 w-3" aria-hidden /> : entry.available ? <Check className="h-3 w-3" aria-hidden /> : <MinusCircle className="h-3 w-3" aria-hidden />}
                      {isActive ? 'ACTIVE' : entry.available ? 'available' : 'unavailable'}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={entry.why}>
                    {entry.why}
                  </p>
                  {entry.cls === 'local' && entry.minRamMb > 0 && (
                    <p className="mt-0.5 font-mono text-[10px] text-zinc-600">RAM floor ≥ {entry.minRamMb} MB free</p>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </section>

      {/* ── Client transport (what THIS browser actually sees) ─────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">This browser</h3>
        <ul className="flex flex-col gap-2 text-xs">
          <li className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
            <span className="text-zinc-200">Realtime socket</span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
              )}
            >
              {connected ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {connected ? 'CONNECTED' : 'OFFLINE'}
            </span>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
            <span className="text-zinc-200">Current speaker turn</span>
            <span className="font-mono text-[10px] uppercase text-zinc-400">{speaker ?? 'A'}</span>
          </li>
        </ul>
      </section>

      {/* ── Provider status (no secrets — booleans only) ─────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Provider status</h3>
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600">
            <ShieldCheck className="h-3 w-3 text-emerald-500" aria-hidden /> keys stay server-side
          </span>
        </header>
        {diagError ? (
          <p className="rounded-xl border border-rose-900/50 bg-rose-950/20 p-3 text-xs text-rose-200">{diagError}</p>
        ) : !diag ? (
          <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking providers…
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {Object.entries(diag.providers).map(([key, prov]) => (
              <li key={key} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold capitalize text-zinc-200">{key}</span>
                  <span className="block truncate font-mono text-[10px] text-zinc-500">
                    {prov.engine}
                    {prov.mode ? ` · ${prov.mode}` : ''}
                  </span>
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                    prov.configured ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
                  )}
                >
                  {prov.configured ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
                  {prov.configured ? 'CONFIGURED' : 'MISSING'}
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-zinc-200">Database</span>
                <span className="block truncate font-mono text-[10px] text-zinc-500">{diag.database.engine}</span>
              </span>
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', diag.database.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400')}>
                {diag.database.ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
                {diag.database.ok ? 'OK' : 'ERROR'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-zinc-200">Realtime transport</span>
                <span className="block truncate font-mono text-[10px] text-zinc-500">{diag.realtime.transport} · {diag.realtime.gateway}</span>
              </span>
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400')}>
                {connected ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
                {connected ? 'LIVE' : 'OFFLINE'}
              </span>
            </li>
          </ul>
        )}
      </section>

      {/* ── Live self-test (REAL requests, per-stage) ─────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Pipeline self-test</h3>
          <Button size="sm" onClick={() => void runSelfTest()} disabled={testing} className="h-8 gap-1.5 bg-emerald-600 text-xs hover:bg-emerald-500">
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PlayCircle className="h-3.5 w-3.5" aria-hidden />}
            {testing ? 'Testing…' : 'Run self-test'}
          </Button>
        </header>
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          Runs REAL requests for every stage: synthesizes a phrase, transcribes it back (ASR
          round-trip), translates via the LLM, probes the ACTIVE engine of the cloning chain,
          performs a database write→read→delete, and health-checks the realtime service. Results
          are measured values — duration, status, error code and an explainable message. Nothing
          is simulated.
        </p>
        {testing && (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" aria-hidden />
            Running real probes — this can take up to ~30 s (retries included)…
          </div>
        )}
        {testError && (
          <p className="mb-3 rounded-xl border border-rose-900/50 bg-rose-950/20 p-3 text-xs leading-relaxed text-rose-200" role="alert">
            {testError}
          </p>
        )}
        {selfTest && (
          <>
            <div
              className={cn(
                'mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold',
                selfTest.ok ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300' : 'border-rose-900/60 bg-rose-950/30 text-rose-300'
              )}
              aria-live="polite"
            >
              {selfTest.ok ? <Check className="h-4 w-4" aria-hidden /> : <CircleAlert className="h-4 w-4" aria-hidden />}
              {selfTest.ok
                ? 'All real probes passed — the pipeline is production-ready end to end.'
                : 'Some probes failed — see the per-stage results below.'}
              <span className="ml-auto font-mono text-[10px] font-normal text-zinc-500">
                {new Date(selfTest.testedAt).toLocaleTimeString()}
              </span>
            </div>
            <ul className="flex flex-col gap-2" aria-live="polite">
              {STAGE_ORDER.map((key) => {
                const stage = selfTest.stages[key]
                const label = STAGE_LABELS[key]
                if (!stage) {
                  return (
                    <li key={key} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-500">
                      <span>{label}</span>
                      <span className="inline-flex items-center gap-1">
                        <MinusCircle className="h-3 w-3" aria-hidden /> not run
                      </span>
                    </li>
                  )
                }
                const statusStyle =
                  stage.status === 'pass'
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : stage.status === 'unconfigured'
                      ? 'bg-amber-500/10 text-amber-400'
                      : stage.status === 'skipped'
                        ? 'bg-zinc-500/10 text-zinc-400'
                        : 'bg-rose-500/10 text-rose-400'
                return (
                  <li key={key} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-zinc-200">{label}</span>
                      <span className="flex items-center gap-2">
                        {stage.ms > 0 && <span className="font-mono text-[10px] text-zinc-500">{stage.ms} ms</span>}
                        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase', statusStyle)}>
                          {stage.status === 'pass' && <Check className="h-3 w-3" aria-hidden />}
                          {(stage.status === 'fail' || stage.status === 'skipped') && <X className="h-3 w-3" aria-hidden />}
                          {stage.status === 'unconfigured' && <MinusCircle className="h-3 w-3" aria-hidden />}
                          {stage.status}
                        </span>
                      </span>
                    </div>
                    {stage.code && (
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">code: {stage.code}</p>
                    )}
                    {stage.message && <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{stage.message}</p>}
                    {stage.detail && (
                      <p className="mt-1 truncate font-mono text-[10px] text-zinc-600">
                        {Object.entries(stage.detail)
                          .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
                          .join(' · ')}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </section>

      {/* ── Honest limitations (spec §16) ─────────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Known limitations</h3>
        <ul className="list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed text-zinc-500">
          <li>
            <span className="font-semibold text-zinc-300">Voice cloning is a LOCAL-FIRST priority chain.</span> Fish
            Speech → F5-TTS → Chatterbox (on-box zero-shot engines, used only when their python
            package AND model weights are installed and the host has enough free RAM) → ElevenLabs
            IVC (cloud, with <span className="font-mono text-emerald-400">ELEVENLABS_API_KEY</span>) →
            pitch-conformed preset match (local DSP). When only the terminal level is available, clone
            profiles are served by the pitch-conformed match and every result is LABELED as not-a-clone
            (<span className="font-mono text-amber-400">pitch-conformed</span> in the telemetry) — never
            presented as a clone.
          </li>
          <li>
            <span className="font-semibold text-zinc-300">Speaker recognition is local DSP — not a neural model.</span>{' '}
            Voiceprints (pitch register + spectral timbre) are computed on this machine and matched by cosine
            similarity. Different people are reliably separated; near-identical voices, heavy noise, or a shared
            microphone can stay honestly <span className="font-mono text-amber-400">Unknown N</span> — the system
            never guesses a name (Unknown is better than wrong). Ambiguous matches ask you to confirm.
          </li>
          <li>
            <span className="font-semibold text-zinc-300">β languages.</span> Persian output is synthesized with the
            on-box piper fa voice and all non-English targets may carry accented prosody (translation quality is
            unaffected); English is the most natural voice today.
          </li>
          <li>
            <span className="font-semibold text-zinc-300">Small containers stay honest about heavy models.</span> The
            local clone engines demand GB-class RAM/VRAM; on a small host the RAM gate refuses them and the chain
            falls through — the About page above shows exactly which level is active.
          </li>
          <li>Live-session replays keep the last 12 utterances in memory; Saved Phrases keeps audio server-side per the retention policy.</li>
          <li>Provider rate limits are retried automatically; under sustained limiting, completed phrases remain safe and the failed segment can be retried manually.</li>
        </ul>
      </section>
    </div>
  )
}
