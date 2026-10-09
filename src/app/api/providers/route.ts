import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateUserId } from '@/lib/user'
import { encryptSecret, keyHint } from '@/lib/secret-box'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ─────────────────────────────────────────────────────────────────────────────
// User-provided API providers (master prompt v2 §24) + REAL connection test.
//
// GET    /api/providers          → the user's providers, keys MASKED (hint only)
// POST   /api/providers          → create { category, name, baseUrl, apiKey, model?, voiceId?, priority? }
// PATCH  /api/providers          → update { id, ...fields } (apiKey omitted = keep)
// DELETE /api/providers?id=      → remove
// POST   /api/providers?action=test&id= → REAL request against the provider
//
// SECURITY (§24/§33): keys are AES-256-GCM encrypted at rest, NEVER returned
// to the frontend (masked hint only), NEVER logged, NEVER included in errors.
// The realtime engine reads them server-side to route calls (failover §23).
// ─────────────────────────────────────────────────────────────────────────────

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
const CATEGORIES = ['asr', 'translate', 'tts'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_INFO: Record<Category, { label: string; endpoint: string; defaultModel: string }> = {
  asr: { label: 'Speech recognition (ASR)', endpoint: 'POST {baseUrl}/audio/transcriptions', defaultModel: 'whisper-1' },
  translate: { label: 'Translation (LLM chat)', endpoint: 'POST {baseUrl}/chat/completions', defaultModel: 'gpt-4o-mini' },
  tts: { label: 'Speech synthesis (TTS)', endpoint: 'POST {baseUrl}/audio/speech', defaultModel: 'tts-1' },
}

function mask(row: {
  id: string
  category: string
  kind: string
  name: string
  baseUrl: string
  model: string | null
  voiceId: string | null
  keyHint: string | null
  encKey: string | null
  priority: number
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    category: row.category,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    voiceId: row.voiceId,
    hasKey: Boolean(row.encKey),
    keyHint: row.keyHint,
    priority: row.priority,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function validateBaseUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return url.replace(/\/$/, '')
  } catch {
    return null
  }
}

export async function GET() {
  try {
    const userId = await getOrCreateUserId()
    const rows = await db.userProviderConfig.findMany({
      where: { userId },
      orderBy: [{ category: 'asc' }, { priority: 'asc' }],
    })
    return NextResponse.json({ providers: rows.map(mask), categories: CATEGORY_INFO })
  } catch (err) {
    console.error('[api/providers] GET failed:', err)
    return NextResponse.json({ error: 'Could not load providers' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const url = new URL(req.url)
    const action = url.searchParams.get('action')

    // ── REAL connection test (§32 "Provider failure" + honest diagnostics) ──
    if (action === 'test') {
      const id = url.searchParams.get('id') ?? ''
      if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
      const row = await db.userProviderConfig.findFirst({ where: { id, userId } })
      if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
      if (!row.encKey) {
        return NextResponse.json({ ok: false, code: 'API_KEY_MISSING', message: 'No API key stored for this provider.', ms: 0 })
      }
      const { decryptSecret } = await import('@/lib/secret-box')
      let apiKey: string
      try {
        apiKey = decryptSecret(row.encKey)
      } catch {
        return NextResponse.json({ ok: false, code: 'DECRYPT_FAILED', message: 'Stored key could not be decrypted (server secret changed?) — re-enter the key.', ms: 0 })
      }
      const base = row.baseUrl.replace(/\/$/, '')
      const provider = {
        id: row.id,
        category: row.category,
        kind: row.kind,
        name: row.name,
        baseUrl: base,
        model: row.model,
        voiceId: row.voiceId,
        apiKey,
        priority: row.priority,
        enabled: row.enabled,
      }
      const t0 = Date.now()
      try {
        if (row.category === 'asr') {
          // Real end-to-end: 1 s of 440 Hz tone as WAV → transcriptions.
          const { pcmToWav } = await import('@/lib/voice/pitch-shift')
          const tone = Buffer.alloc(16000 * 2)
          for (let i = 0; i < 16000; i++) tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 9000), i * 2)
          const { openAICompatibleASR } = await import('@/lib/providers/adapters')
          const text = await openAICompatibleASR(provider, pcmToWav(tone, 16000).toString('base64'))
          return NextResponse.json({ ok: true, ms: Date.now() - t0, detail: { returnedText: text || '(empty — tone recognized as silence, connection OK)' } })
        }
        if (row.category === 'translate') {
          const { openAICompatibleChat } = await import('@/lib/providers/adapters')
          const reply = await openAICompatibleChat(provider, 'You are a connection test. Reply with exactly: OK', 'Ping?', 0)
          const ok = /^ok\b/i.test(reply)
          return NextResponse.json({
            ok,
            ms: Date.now() - t0,
            detail: { reply: reply.slice(0, 80) },
            message: ok ? undefined : 'Endpoint answered but not with the expected test token.',
          })
        }
        if (row.category === 'tts') {
          const { openAICompatibleTTS } = await import('@/lib/providers/adapters')
          const { bytes, format } = await openAICompatibleTTS(provider, 'Connection test.', 1)
          return NextResponse.json({ ok: bytes.length > 1000, ms: Date.now() - t0, detail: { bytes: bytes.length, format } })
        }
        return NextResponse.json({ ok: false, code: 'UNSUPPORTED', message: `Unsupported category ${row.category}`, ms: 0 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const code = /401|403|unauthorized|api key/i.test(msg)
          ? 'AUTH'
          : /429|rate|quota/i.test(msg)
            ? 'RATE_LIMIT'
            : /ECONN|ENOTFOUND|fetch failed|network|abort/i.test(msg)
              ? 'NETWORK'
              : /5\d\d/.test(msg)
                ? 'PROVIDER_5XX'
                : 'PROVIDER_ERROR'
        return NextResponse.json({ ok: false, code, message: msg.slice(0, 300), ms: Date.now() - t0 })
      }
    }

    // ── Create ──────────────────────────────────────────────────────────────
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

    const category = typeof body.category === 'string' ? (body.category as Category) : ('' as Category)
    if (!CATEGORIES.includes(category)) {
      return NextResponse.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, { status: 400 })
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : ''
    if (!name) return NextResponse.json({ error: 'A display name is required' }, { status: 400 })
    const baseUrl = typeof body.baseUrl === 'string' ? validateBaseUrl(body.baseUrl) : null
    if (!baseUrl) return NextResponse.json({ error: 'baseUrl must be a valid http(s) URL (e.g. https://api.openai.com/v1)' }, { status: 400 })
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (!apiKey) return NextResponse.json({ error: 'An API key is required' }, { status: 400 })

    const created = await db.userProviderConfig.create({
      data: {
        userId,
        category,
        kind: 'openai-compatible',
        name,
        baseUrl,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 80) : null,
        voiceId: typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim().slice(0, 80) : null,
        encKey: encryptSecret(apiKey),
        keyHint: keyHint(apiKey),
        priority: typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.round(body.priority) : 50,
        enabled: body.enabled === false ? false : true,
      },
    })
    return NextResponse.json({ provider: mask(created) }, { status: 201 })
  } catch (err) {
    console.error('[api/providers] POST failed:', err)
    return NextResponse.json({ error: 'Could not save the provider' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const id = typeof body?.id === 'string' && ID_RE.test(body.id) ? body.id : null
    if (!id || !body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

    const row = await db.userProviderConfig.findFirst({ where: { id, userId } })
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 60)
    if (typeof body.baseUrl === 'string') {
      const clean = validateBaseUrl(body.baseUrl)
      if (!clean) return NextResponse.json({ error: 'baseUrl must be a valid http(s) URL' }, { status: 400 })
      data.baseUrl = clean
    }
    if (typeof body.model === 'string') data.model = body.model.trim().slice(0, 80) || null
    if (typeof body.voiceId === 'string') data.voiceId = body.voiceId.trim().slice(0, 80) || null
    if (typeof body.priority === 'number' && Number.isFinite(body.priority)) data.priority = Math.round(body.priority)
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      data.encKey = encryptSecret(body.apiKey.trim())
      data.keyHint = keyHint(body.apiKey.trim())
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    await db.userProviderConfig.update({ where: { id }, data })
    const updated = await db.userProviderConfig.findUnique({ where: { id } })
    return NextResponse.json({ provider: updated ? mask(updated) : null })
  } catch (err) {
    console.error('[api/providers] PATCH failed:', err)
    return NextResponse.json({ error: 'Could not update the provider' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const userId = await getOrCreateUserId()
    const id = new URL(req.url).searchParams.get('id') ?? ''
    if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    const row = await db.userProviderConfig.findFirst({ where: { id, userId }, select: { id: true } })
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    await db.userProviderConfig.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/providers] DELETE failed:', err)
    return NextResponse.json({ error: 'Could not delete the provider' }, { status: 500 })
  }
}
