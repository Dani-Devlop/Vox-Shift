'use client'

// ─────────────────────────────────────────────────────────────────────────────
// AboutView (spec §14 + §16) — version, provider status (no secrets), live
// pipeline self-test with REAL per-stage requests (status · duration · error
// code · explainable message), client transport state, and an honest
// known-limitations list. No invented values, no demo successes.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import { Activity, Check, CircleAlert, Loader2, MinusCircle, PlayCircle, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SpeakerRole } from '@/types/translator'

interface DiagnosticsData {
  version: string
  providers: Record<string, { engine: string; configured: boolean; mode?: string }>
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
  cloneProvider: 'Voice cloning provider',
  speakerEngine: 'Speaker recognition engine (local)',
  database: 'Database (write → read → delete)',
  transport: 'Realtime transport (translator service)',
}

const STAGE_ORDER = ['speech', 'translation', 'voice', 'cloneProvider', 'speakerEngine', 'database', 'transport']

const VERSION_LABEL = 'v2.2.0'

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
                VoxShift <span className="font-mono text-xs font-bold text-emerald-400">{VERSION_LABEL}</span>
              </h2>
              <p className="text-[11px] text-zinc-500">Real-time bidirectional speech translation with voice identity</p>
            </div>
          </div>
          {diag && <span className="font-mono text-[10px] text-zinc-600">server {new Date(diag.serverTime).toLocaleTimeString()}</span>}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Persian ↔ English (plus Deutsch, Français, Español, العربية, Türkçe, Italiano) · Auto-detect
          two-way direction · Manual speaker turns · Natural / Clean / Literal / Formal / Casual
          styles · pitch-conformed Voice Match + real ElevenLabs cloning · persistent resumable
          conversations · live captions · latency telemetry.
        </p>
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
          round-trip), translates via the LLM, probes the cloning provider account, performs a
          database write→read→delete, and health-checks the realtime service. Results are measured
          values — duration, status, error code and an explainable message. Nothing is simulated.
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
            <span className="font-semibold text-zinc-300">Voice identity has two modes.</span> With{' '}
            <span className="font-mono text-emerald-400">ELEVENLABS_API_KEY</span> configured,
            enrollment performs REAL cross-language cloning (ElevenLabs IVC, up to 3 takes merged):
            the generated speech comes from your enrolled voice. Without the key, the engine uses a
            pitch-conformed preset match — always labeled honestly, never presented as a clone.
          </li>
          <li>
            <span className="font-semibold text-zinc-300">Speaker recognition is local DSP — not a neural model.</span>{' '}
            Voiceprints (pitch register + spectral timbre) are computed on this machine and matched by cosine
            similarity. Different people are reliably separated; near-identical voices, heavy noise, or a shared
            microphone can stay honestly <span className="font-mono text-amber-400">Unknown N</span> — the system
            never guesses a name (Unknown is better than wrong). Ambiguous matches ask you to confirm.
          </li>
          <li>
            <span className="font-semibold text-zinc-300">β languages.</span> Persian output and all
            non-English targets are synthesized with accented engine voices (translation quality is
            unaffected); English is the only native-quality voice today.
          </li>
          <li>Live-session replays keep the last 12 utterances in memory; Saved Phrases keeps audio server-side per the retention policy.</li>
          <li>Provider rate limits are retried automatically; under sustained limiting, completed phrases remain safe and the failed segment can be retried manually.</li>
        </ul>
      </section>
    </div>
  )
}
