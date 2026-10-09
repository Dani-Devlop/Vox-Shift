import { NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { randomUUID } from 'crypto'
import { cloneConfigured, cloneSetupInstructions, CLONE_ENGINE_ID } from '@/lib/voice/clone-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/diagnostics — provider configuration status WITHOUT any secret
// values (booleans only). Safe to render in the client.
// POST /api/diagnostics — pipeline self-test with REAL end-to-end requests:
//   · ASR: synthesize a real phrase (TTS) → transcribe it back (ASR) → verify
//     the transcript. A genuine round trip, not an SDK instantiation.
//   · Translation: real LLM request, verified non-empty.
//   · TTS: real synthesis request, verified by audio size.
//   · Voice clone provider: real account request when configured (reports the
//     subscription tier honestly); honest `unconfigured` state otherwise.
//   · Database: real write → read → delete cycle on the app's own tables.
//   · Realtime transport: real HTTP health probe of the translator mini-service.
// Every stage reports { status, ms, code?, message? } — no invented values, no
// demo successes, no secrets ever returned.
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION = '1.2.0'
/**
 * Transport probe target — the translator mini-service directly. The probe
 * performs a REAL engine.io v4 polling handshake (the same first request a
 * browser's socket.io makes). Override with TRANSLATOR_SERVICE_URL if the
 * service runs elsewhere.
 */
const TRANSLATOR_SERVICE_URL = process.env.TRANSLATOR_SERVICE_URL ?? 'http://127.0.0.1:3003'

type StageStatus = 'pass' | 'fail' | 'unconfigured' | 'skipped'
interface StageReport {
  status: StageStatus
  ms: number
  /** Stable machine-readable error code (undefined when passing). */
  code?: string
  /** Human-explainable message (honest, actionable, no secrets). */
  message?: string
  /** Extra non-secret factual detail (e.g. detected transcript, tier name). */
  detail?: Record<string, unknown>
}

/** Map any thrown error to a stable, understandable error code. */
function errorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/timeout|timed out|AbortError/i.test(msg)) return 'TIMEOUT'
  if (/401|403|unauthorized|forbidden|api key|invalid[_ ]key/i.test(msg)) return 'AUTH'
  if (/429|rate|too many|quota/i.test(msg)) return 'RATE_LIMIT'
  if (/ECONN|fetch failed|network|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return 'NETWORK'
  if (/5\d\d|internal server|bad gateway|service unavailable/i.test(msg)) return 'PROVIDER_5XX'
  return 'PROVIDER_ERROR'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function GET() {
  let providerConfigured = false
  try {
    const zai = await ZAI.create()
    providerConfigured = Boolean(zai)
  } catch {
    providerConfigured = false
  }

  let dbOk = true
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbOk = false
  }

  return NextResponse.json({
    version: APP_VERSION,
    providers: {
      // One SDK provisions ASR + LLM + TTS — report the shared truth, no secrets.
      asr: { engine: 'zai-asr', configured: providerConfigured },
      translation: { engine: 'glm-llm', configured: providerConfigured },
      voice: { engine: 'zai-tts', configured: providerConfigured, mode: 'voice-match + pitch-conform' },
      // REAL cloning provider — reported honestly: configured means enrolled
      // samples are cloned for cross-language synthesis. No secrets returned.
      voiceClone: {
        engine: CLONE_ENGINE_ID,
        configured: cloneConfigured(),
        mode: 'real cross-language voice cloning (instant) → your own voice in the translation',
        setup: cloneConfigured() ? null : cloneSetupInstructions(),
      },
    },
    database: { ok: dbOk, engine: 'sqlite (prisma)' },
    realtime: { transport: 'socket.io', gateway: 'caddy :81 → :3000 + :3003' },
    serverTime: new Date().toISOString(),
  })
}

export async function POST() {
  const stages: Record<string, StageReport> = {}

  // ── Stage 1 — TTS: synthesize the ASR test phrase for real ───────────────
  // (Runs first so the ASR stage can transcribe REAL speech audio.)
  const asrInputText = 'Hello, how are you doing today?'
  let asrWavBase64: string | null = null
  const tTts = Date.now()
  try {
    const zai = await ZAI.create()
    const res = await zai.audio.tts.create({
      input: asrInputText,
      voice: 'kazi',
      speed: 1,
      response_format: 'wav',
      stream: false,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const ok = buf.length > 1000
    stages.voice = {
      status: ok ? 'pass' : 'fail',
      ms: Date.now() - tTts,
      code: ok ? undefined : 'EMPTY_RESULT',
      message: ok ? undefined : 'The synthesis request succeeded but returned suspiciously small audio.',
      detail: ok ? { bytes: buf.length, voice: 'kazi', format: 'wav' } : undefined,
    }
    if (ok) asrWavBase64 = buf.toString('base64')
  } catch (err) {
    stages.voice = {
      status: 'fail',
      ms: Date.now() - tTts,
      code: errorCode(err),
      message: `TTS synthesis failed: ${errorMessage(err)}`,
    }
  }

  // ── Stage 2 — ASR: transcribe the real synthesized audio back ────────────
  // Genuine round trip: TTS audio in → recognized text out. Skipped honestly
  // (not faked) when the TTS leg could not produce audio.
  const tAsr = Date.now()
  if (!asrWavBase64) {
    stages.speech = {
      status: 'skipped',
      ms: 0,
      code: 'DEPENDENCY_FAILED',
      message: 'Skipped because the TTS stage produced no audio to transcribe. Fix TTS, then re-run.',
    }
  } else {
    try {
      const zai = await ZAI.create()
      const res = await zai.audio.asr.create({ file_base64: asrWavBase64 })
      const text = (res?.text ?? '').trim()
      const plausible = text.length > 0 && /hel|how|today|are|you/i.test(text)
      stages.speech = {
        status: plausible ? 'pass' : 'fail',
        ms: Date.now() - tAsr,
        code: plausible ? undefined : 'EMPTY_RESULT',
        message: plausible
          ? undefined
          : `Transcription returned "${text.slice(0, 80) || '(empty)'}" — did not match the spoken test phrase.`,
        detail: { transcribed: text.slice(0, 120), expectedPhrase: asrInputText },
      }
    } catch (err) {
      stages.speech = {
        status: 'fail',
        ms: Date.now() - tAsr,
        code: errorCode(err),
        message: `Speech recognition failed: ${errorMessage(err)}`,
      }
    }
  }

  // ── Stage 3 — Translation LLM: real request, verified non-empty ──────────
  const t0 = Date.now()
  try {
    const zai = await ZAI.create()
    const res = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: 'Translate to English. Reply with the translation only.' },
        { role: 'user', content: 'سلام' },
      ],
      temperature: 0,
      max_tokens: 20,
    })
    const text = res.choices?.[0]?.message?.content ?? ''
    const ok = text.trim().length > 0
    stages.translation = {
      status: ok ? 'pass' : 'fail',
      ms: Date.now() - t0,
      code: ok ? undefined : 'EMPTY_RESULT',
      message: ok ? undefined : 'The model replied with an empty translation.',
      detail: ok ? { sample: text.trim().slice(0, 60) } : undefined,
    }
  } catch (err) {
    stages.translation = {
      status: 'fail',
      ms: Date.now() - t0,
      code: errorCode(err),
      message: `Translation request failed: ${errorMessage(err)}`,
    }
  }

  // ── Stage 4 — Voice clone provider: real account probe when configured ───
  // Reports the subscription tier + quota so the user can see whether Instant
  // Voice Cloning is actually available on their plan. Not configured is an
  // honest separate state — the app works without it in voice-match mode.
  const t2 = Date.now()
  if (cloneConfigured()) {
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        stages.cloneProvider = {
          status: 'fail',
          ms: Date.now() - t2,
          code: res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR',
          message: `The provider rejected the request (HTTP ${res.status}) — check ELEVENLABS_API_KEY.`,
        }
      } else {
        const body = (await res.json()) as {
          subscription?: { tier?: string; character_count?: number; character_limit?: number }
        }
        stages.cloneProvider = {
          status: 'pass',
          ms: Date.now() - t2,
          detail: {
            tier: body.subscription?.tier ?? 'unknown',
            charactersUsed: body.subscription?.character_count,
            characterLimit: body.subscription?.character_limit,
          },
        }
      }
    } catch (err) {
      stages.cloneProvider = {
        status: 'fail',
        ms: Date.now() - t2,
        code: errorCode(err),
        message: `Clone provider unreachable: ${errorMessage(err)}`,
      }
    }
  } else {
    stages.cloneProvider = {
      status: 'unconfigured',
      ms: 0,
      code: 'NOT_CONFIGURED',
      message:
        'ELEVENLABS_API_KEY is not set — cloning is honestly disabled. The app still works in voice-match mode; translations use your pitch-conformed match, not a clone.',
    }
  }

  // ── Stage 5 — Database: real write → read → delete cycle ─────────────────
  const tDb = Date.now()
  try {
    const probeId = `diag_${randomUUID().slice(0, 8)}`
    await db.user.create({ data: { id: probeId, prefsJson: JSON.stringify({ probe: true }) } })
    const readBack = await db.user.findUnique({ where: { id: probeId } })
    const roundTripOk = readBack?.id === probeId
    await db.user.delete({ where: { id: probeId } }).catch(() => {})
    stages.database = {
      status: roundTripOk ? 'pass' : 'fail',
      ms: Date.now() - tDb,
      code: roundTripOk ? undefined : 'DB_ERROR',
      message: roundTripOk ? undefined : 'The written probe row could not be read back.',
      detail: { engine: 'sqlite (prisma)', op: 'create → findUnique → delete' },
    }
  } catch (err) {
    stages.database = {
      status: 'fail',
      ms: Date.now() - tDb,
      code: errorCode(err) === 'PROVIDER_ERROR' ? 'DB_ERROR' : errorCode(err),
      message: `Database write/read failed: ${errorMessage(err)}`,
    }
  }

  // ── Stage 6 — Realtime transport: REAL socket.io engine handshake ────────
  // The service's socket.io owns path '/', so the honest probe is an actual
  // engine.io polling handshake (the same one a browser performs on connect).
  const tTr = Date.now()
  try {
    const res = await fetch(`${TRANSLATOR_SERVICE_URL}/?EIO=4&transport=polling`, {
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    })
    const bodyText = await res.text()
    // A healthy engine.io v4 handshake answers '0{...sid...}' with HTTP 200.
    const handshakeOk = res.ok && bodyText.startsWith('0')
    if (!handshakeOk) {
      stages.transport = {
        status: 'fail',
        ms: Date.now() - tTr,
        code: 'SERVICE_DOWN',
        message: `The translator service answered the engine handshake with HTTP ${res.status} — live translation will not work until it is healthy.`,
        detail: { reply: bodyText.slice(0, 60) },
      }
    } else {
      let sid: string | undefined
      try {
        sid = (JSON.parse(bodyText.slice(1)) as { sid?: string }).sid
      } catch {
        /* sid stays undefined */
      }
      stages.transport = {
        status: 'pass',
        ms: Date.now() - tTr,
        detail: { service: 'translator-service (:3003)', engine: 'socket.io v4 polling handshake', sessionId: sid?.slice(0, 8) },
      }
    }
  } catch (err) {
    stages.transport = {
      status: 'fail',
      ms: Date.now() - tTr,
      code: 'SERVICE_DOWN',
      message: `The translator mini-service is unreachable at ${TRANSLATOR_SERVICE_URL} (${errorMessage(err)}). Start it with: cd mini-services/translator-service && bun run dev`,
    }
  }

  // Overall verdict: 'unconfigured' clone stage does not fail the pipeline —
  // the app is fully usable without cloning (honest voice-match mode).
  const failing = Object.entries(stages).filter(([, s]) => s.status === 'fail' || s.status === 'skipped')
  return NextResponse.json({
    ok: failing.length === 0,
    version: APP_VERSION,
    stages,
    testedAt: new Date().toISOString(),
  })
}
