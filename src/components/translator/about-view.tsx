'use client'

// ─────────────────────────────────────────────────────────────────────────────
// AboutView (spec §14 + §16) — version, provider status (no secrets), live
// pipeline self-test with per-stage latency, capability notes and honest
// known-limitations list.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import { Activity, Check, Loader2, PlayCircle, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DiagnosticsData {
  version: string
  providers: Record<string, { engine: string; configured: boolean; mode?: string }>
  database: { ok: boolean; engine: string }
  realtime: { transport: string; gateway: string }
  serverTime: string
}

interface SelfTestData {
  ok: boolean
  stages: Record<string, { ok: boolean; ms: number; error?: string }>
  testedAt: string
}

const STAGE_LABELS: Record<string, string> = {
  speech: 'Speech recognition (ASR)',
  translation: 'Translation (LLM)',
  voice: 'Voice synthesis (TTS)',
  cloneProvider: 'Voice cloning provider',
}

export function AboutView() {
  const [diag, setDiag] = useState<DiagnosticsData | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [selfTest, setSelfTest] = useState<SelfTestData | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/diagnostics', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setDiag(d)
      })
      .catch(() => {
        if (!cancelled) setDiagError('Diagnostics unavailable — the API server did not respond.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runSelfTest = useCallback(async () => {
    setTesting(true)
    setSelfTest(null)
    try {
      const res = await fetch('/api/diagnostics', { method: 'POST' })
      const data = (await res.json()) as SelfTestData
      setSelfTest(data)
    } catch {
      setSelfTest({ ok: false, stages: {}, testedAt: new Date().toISOString() })
    } finally {
      setTesting(false)
    }
  }, [])

  return (
    <div className="lt-enter mx-auto flex max-w-3xl flex-col gap-6">
      {/* ── Version ───────────────────────────────────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_24px_-6px_rgba(16,185,129,0.9),inset_0_1px_0_rgba(255,255,255,0.25)]">
              <Activity className="h-5 w-5 text-zinc-950" aria-hidden />
            </span>
            <div>
              <h2 className="text-base font-black tracking-tight text-white">
                VoxShift <span className="font-mono text-xs font-bold text-emerald-400">v1.0.0 demo</span>
              </h2>
              <p className="text-[11px] text-zinc-500">Real-time bidirectional speech translation with voice identity</p>
            </div>
          </div>
          {diag && (
            <span className="font-mono text-[10px] text-zinc-600">server {new Date(diag.serverTime).toLocaleTimeString()}</span>
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Persian ↔ English (plus Deutsch, Français, Español, العربية, Türkçe, Italiano) · Natural /
          Clean / Literal / Formal / Casual styles · pitch-conformed Voice Match · persistent
          resumable conversations · live captions · latency telemetry.
        </p>
      </section>

      {/* ── Provider status (no secrets — booleans only) ──────────────────── */}
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
                    {prov.engine}{prov.mode ? ` · ${prov.mode}` : ''}
                  </span>
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                    prov.configured ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
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
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                <Check className="h-3 w-3" aria-hidden /> LIVE
              </span>
            </li>
          </ul>
        )}
      </section>

      {/* ── Live self-test (spec §14 diagnostics) ─────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Pipeline self-test</h3>
          <Button size="sm" onClick={() => void runSelfTest()} disabled={testing} className="h-8 gap-1.5 bg-emerald-600 text-xs hover:bg-emerald-500">
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PlayCircle className="h-3.5 w-3.5" aria-hidden />}
            {testing ? 'Testing…' : 'Run self-test'}
          </Button>
        </header>
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          Sends one tiny real request through translation and voice synthesis and reports the
          measured latency of each stage — actual values, never estimates.
        </p>
        {selfTest && (
          <ul className="flex flex-col gap-2" aria-live="polite">
            {Object.entries(STAGE_LABELS).map(([key, label]) => {
              const stage = selfTest.stages[key]
              if (!stage) {
                return (
                  <li key={key} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-500">
                    <span>{label}</span>
                    <span>not run</span>
                  </li>
                )
              }
              return (
                <li key={key} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
                  <span className="text-xs font-medium text-zinc-200">{label}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-zinc-500">{stage.ms} ms</span>
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', stage.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400')}>
                      {stage.ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
                      {stage.ok ? 'OK' : 'FAIL'}
                    </span>
                  </span>
                  {stage.error && <span className="w-full truncate text-[10px] text-rose-300">{stage.error}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ── Honest limitations (spec §16) ─────────────────────────────────── */}
      <section className="lt-card rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 sm:p-6">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-zinc-300">Known limitations</h3>
        <ul className="list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed text-zinc-500">
          <li>
            <span className="font-semibold text-zinc-300">Voice identity has two modes.</span>{' '}
            With <span className="font-mono text-emerald-400">ELEVENLABS_API_KEY</span> configured,
            enrollment performs REAL cross-language cloning (ElevenLabs IVC): the generated English
            speech comes from your enrolled voice. Without the key, the engine falls back to a
            pitch-conformed preset match — always labeled honestly in the UI, never presented as a
            clone.
          </li>
          <li>Speaker attribution relies on whoever is near the microphone — there is no diarization. For two-person conversations, pass the device or use headphones.</li>
          <li>Translation audio replays for live-session phrases are kept for the last 12 utterances in memory; Saved Phrases keeps audio server-side per the retention policy.</li>
          <li>Rate limits from the voice provider are retried three times automatically; under sustained limiting, completed phrases remain safe and the failed segment can be retried manually.</li>
          <li>The dark console theme is the product identity; text size, density and transcript visibility are customizable.</li>
        </ul>
      </section>
    </div>
  )
}
