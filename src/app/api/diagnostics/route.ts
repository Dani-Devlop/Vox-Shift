import { NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { cloneConfigured, cloneSetupInstructions, CLONE_ENGINE_ID } from '@/lib/voice/clone-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/diagnostics — provider configuration status WITHOUT any secret
// values (booleans only). Safe to render in the client.
// POST /api/diagnostics — pipeline self-test: runs a tiny LLM translation and
// a tiny TTS synthesis for real, reports per-stage latency or the exact error.
// Never exposes API keys — only provider health the app itself depends on.
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION = '1.1.0'

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
  const stages: Record<string, { ok: boolean; ms: number; error?: string }> = {}

  // Stage 1 — LLM translation (1 short phrase, real request).
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
    stages.translation = { ok: text.length > 0, ms: Date.now() - t0, error: text.length ? undefined : 'empty reply' }
  } catch (err) {
    stages.translation = { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : 'failed' }
  }

  // Stage 2 — TTS (1 short word, real request).
  const t1 = Date.now()
  try {
    const zai = await ZAI.create()
    const res = await zai.audio.tts.create({
      input: 'Hi',
      voice: 'kazi',
      speed: 1,
      response_format: 'wav',
      stream: false,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    stages.voice = {
      ok: buf.length > 1000,
      ms: Date.now() - t1,
      error: buf.length > 1000 ? undefined : 'suspiciously small audio',
    }
  } catch (err) {
    stages.voice = { ok: false, ms: Date.now() - t1, error: err instanceof Error ? err.message : 'failed' }
  }

  // Stage 3 — Cloned-voice provider: a configured-but-broken key must surface
  // here, so when cloning is configured we make one tiny REAL request (list
  // voices) and report the result verbatim. When not configured → honest MISS.
  const t2 = Date.now()
  if (cloneConfigured()) {
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' },
        signal: AbortSignal.timeout(10_000),
      })
      stages.cloneProvider = {
        ok: res.ok,
        ms: Date.now() - t2,
        error: res.ok ? undefined : `provider responded ${res.status} — check the API key`,
      }
    } catch (err) {
      stages.cloneProvider = {
        ok: false,
        ms: Date.now() - t2,
        error: err instanceof Error ? err.message : 'clone provider unreachable',
      }
    }
  } else {
    stages.cloneProvider = {
      ok: false,
      ms: Date.now() - t2,
      error: 'not configured — voice cloning disabled (voice-match mode used instead)',
    }
  }

  // Stage 4 — ASR shares the SDK; a real transcription needs real audio, so the
  // honest check here is SDK instantiation (the same client the engine uses).
  const t3 = Date.now()
  try {
    const zai = await ZAI.create()
    stages.speech = { ok: Boolean(zai), ms: Date.now() - t3 }
  } catch (err) {
    stages.speech = { ok: false, ms: Date.now() - t3, error: err instanceof Error ? err.message : 'failed' }
  }

  const allOk = Object.entries(stages).every(([k, s]) => k === 'cloneProvider' || s.ok)
  return NextResponse.json({ ok: allOk, stages, testedAt: new Date().toISOString() })
}
