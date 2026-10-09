import { readFileSync } from 'fs'

// ─────────────────────────────────────────────────────────────────────────────
// Provider Router — multi-provider routing with AUTOMATIC FAILOVER and honest
// HEALTH states (master prompt v2 §22/§23/§30).
//
// Chain per category (ASR / Translation / TTS):
//   1. User-registered OpenAI-compatible providers (DB, priority order)
//   2. Built-in z-ai engines (always last — the never-empty fallback)
//
// REAL failures only: timeout · invalid key · missing key · quota · rate
// limit · provider offline · model unavailable. A failing provider is put on
// an exponential cooldown; the ACTUAL provider used is recorded on every
// result (§23 "Record the actual provider used"). Faked fallbacks: never.
//
// API keys live ONLY in the DB (AES-256-GCM encrypted by the Next.js side)
// and are used here for outbound calls — they are never logged, never
// returned over the socket, and never included in error messages.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderCategory = 'asr' | 'translate' | 'tts'
export type ProviderHealthState =
  | 'READY'
  | 'NOT_CONFIGURED'
  | 'API_KEY_MISSING'
  | 'INVALID_KEY'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'OFFLINE'
  | 'MODEL_NOT_INSTALLED'
  | 'UNSUPPORTED'
  | 'ERROR'
  | 'COOLDOWN'

export interface ProviderRow {
  id: string
  category: string
  kind: string
  name: string
  baseUrl: string
  model: string | null
  voiceId: string | null
  apiKey: string | null
  priority: number
  enabled: boolean
}

export interface ProviderHealth {
  providerId: string
  name: string
  category: string
  kind: string
  enabled: boolean
  state: ProviderHealthState
  lastError?: string
  lastCheckedAt?: string
  consecutiveFailures: number
  cooldownUntil?: string
}

interface HealthEntry {
  state: ProviderHealthState
  lastError?: string
  lastCheckedAt?: number
  consecutiveFailures: number
  cooldownUntil?: number
}

// ── .env helper (mirrors voice-clone.ts; keys never leave this process) ─────

function envValue(name: string): string | null {
  if (process.env[name]) return process.env[name] as string
  try {
    const text = readFileSync('/home/z/my-project/.env', 'utf8')
    const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\r\\n#]+)"?\\s*$`, 'm'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

// ── User provider store (SQLite via Prisma — READ-ONLY here) ────────────────

type PrismaClientType = import('@prisma/client').PrismaClient
let prismaPromise: Promise<PrismaClientType> | null = null
let providerCache: { rows: ProviderRow[]; at: number } | null = null
const PROVIDER_TTL_MS = 30_000

async function getPrisma(): Promise<PrismaClientType> {
  if (!prismaPromise) {
    prismaPromise = (async () => {
      const { PrismaClient } = await import('@prisma/client')
      const url = envValue('DATABASE_URL') ?? 'file:/home/z/my-project/db/custom.db'
      return new PrismaClient({ datasourceUrl: url })
    })()
  }
  return prismaPromise
}

async function loadProviders(): Promise<ProviderRow[]> {
  if (providerCache && Date.now() - providerCache.at < PROVIDER_TTL_MS) return providerCache.rows
  try {
    const prisma = await getPrisma()
    const rows = await prisma.userProviderConfig.findMany({
      where: { enabled: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    })
    const decrypted: ProviderRow[] = []
    for (const r of rows) {
      let apiKey: string | null = null
      if (r.encKey) {
        try {
          const { decryptSecret } = await import('../../../src/lib/secret-box')
          apiKey = decryptSecret(r.encKey)
        } catch {
          apiKey = null // decrypt failure → provider will fail with API_KEY_MISSING
        }
      }
      decrypted.push({
        id: r.id,
        category: r.category,
        kind: r.kind,
        name: r.name,
        baseUrl: r.baseUrl,
        model: r.model,
        voiceId: r.voiceId,
        apiKey,
        priority: r.priority,
        enabled: r.enabled,
      })
    }
    providerCache = { rows: decrypted, at: Date.now() }
    return decrypted
  } catch (err) {
    console.error('[providers] load failed (continuing with built-ins):', err instanceof Error ? err.message : err)
    providerCache = { rows: [], at: Date.now() }
    return []
  }
}

/** Force-reload provider configs (called after the user edits them). */
export function invalidateProviderCache(): void {
  providerCache = null
}

// ── Health tracking (§30 — real states only) ────────────────────────────────

const health = new Map<string, HealthEntry>()

function classifyError(err: unknown): { state: ProviderHealthState; message: string } {
  const msg = err instanceof Error ? err.message : String(err)
  if (/timeout|timed out|abort/i.test(msg)) return { state: 'OFFLINE', message: 'Provider timed out' }
  if (/401|403|unauthorized|forbidden|invalid[_ ]api[_ ]key|invalid[_ ]key|incorrect api key/i.test(msg))
    return { state: 'INVALID_KEY', message: 'Authentication rejected by the provider (check the API key)' }
  if (/429|rate|too many/i.test(msg)) return { state: 'RATE_LIMITED', message: 'Provider rate limit reached' }
  if (/quota|billing|insufficient/i.test(msg)) return { state: 'QUOTA_EXCEEDED', message: 'Provider quota/billing issue' }
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|refused/i.test(msg))
    return { state: 'OFFLINE', message: 'Provider unreachable (network/DNS/base URL)' }
  if (/model/i.test(msg)) return { state: 'MODEL_NOT_INSTALLED', message: 'Model not available at this provider' }
  if (/5\d\d|internal server|bad gateway|unavailable/i.test(msg))
    return { state: 'ERROR', message: 'Provider server error (5xx)' }
  return { state: 'ERROR', message: msg.slice(0, 200) }
}

function markSuccess(providerId: string): void {
  health.set(providerId, { state: 'READY', consecutiveFailures: 0, lastCheckedAt: Date.now() })
}

function markFailure(providerId: string, err: unknown): void {
  const { state, message } = classifyError(err)
  const prev = health.get(providerId)
  const failures = (prev?.consecutiveFailures ?? 0) + 1
  // Exponential cooldown: 10s → 20s → 40s … capped at 5 min.
  const cooldown = state === 'RATE_LIMITED' || state === 'QUOTA_EXCEEDED' || state === 'INVALID_KEY' || state === 'OFFLINE'
  health.set(providerId, {
    state,
    lastError: message,
    lastCheckedAt: Date.now(),
    consecutiveFailures: failures,
    cooldownUntil: cooldown ? Date.now() + Math.min(10_000 * 2 ** (failures - 1), 300_000) : undefined,
  })
}

/** Public health snapshot (socket `providers:health`). */
export async function providerHealthSnapshot(): Promise<ProviderHealth[]> {
  const rows = await loadProviders()
  const now = Date.now()
  const out: ProviderHealth[] = []
  for (const r of rows) {
    const h = health.get(r.id)
    let state = h?.state ?? 'READY'
    if (h?.cooldownUntil && h.cooldownUntil > now) state = 'COOLDOWN'
    out.push({
      providerId: r.id,
      name: r.name,
      category: r.category,
      kind: r.kind,
      enabled: r.enabled,
      state,
      lastError: h?.lastError,
      lastCheckedAt: h?.lastCheckedAt ? new Date(h.lastCheckedAt).toISOString() : undefined,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      cooldownUntil: h?.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : undefined,
    })
  }
  // Built-ins are reported as READY (no separate probe exists — real failures
  // surface on actual calls and in the self-test, never as fake states).
  for (const b of [
    { providerId: 'builtin:zai-asr', name: 'Z.ai ASR (built-in)', category: 'asr' },
    { providerId: 'builtin:zai-llm', name: 'GLM Translation (built-in)', category: 'translate' },
    { providerId: 'builtin:zai-tts', name: 'Z.ai TTS (built-in)', category: 'tts' },
  ]) {
    out.push({
      providerId: b.providerId,
      name: b.name,
      category: b.category,
      kind: 'builtin',
      enabled: true,
      state: 'READY',
      consecutiveFailures: 0,
    })
  }
  return out
}

/** Providers to try: enabled, cooled-down ones skipped unless included. */
async function chain(category: ProviderCategory, includeCooldown = false): Promise<ProviderRow[]> {
  const rows = await loadProviders()
  const now = Date.now()
  return rows.filter((r) => {
    if (r.category !== category) return false
    const h = health.get(r.id)
    if (h?.cooldownUntil && h.cooldownUntil > now && !includeCooldown) return false
    return true
  })
}

export interface RoutedCall<T> {
  builtin: () => Promise<T>
  user: (p: ProviderRow) => Promise<T>
}

export interface RoutedResult<T> {
  value: T
  providerId: string
  attempts: Array<{ providerId: string; ok: boolean; ms: number; error?: string }>
}

/**
 * Run a routed call with automatic failover: every user provider is tried in
 * priority order (cooled-down ones skipped, then given a last chance), then
 * the built-in. All failures are real and recorded (§23).
 */
export async function routedCall<T>(category: ProviderCategory, call: RoutedCall<T>): Promise<RoutedResult<T>> {
  const attempts: RoutedResult<T>['attempts'] = []
  let lastError: unknown = null

  const tryUserProviders = async (rows: ProviderRow[]): Promise<RoutedResult<T> | null> => {
    for (const p of rows) {
      if (!p.apiKey) {
        markFailure(p.id, new Error('API key missing'))
        attempts.push({ providerId: p.id, ok: false, ms: 0, error: 'API key missing' })
        continue
      }
      const t0 = Date.now()
      try {
        const value = await call.user(p)
        markSuccess(p.id)
        attempts.push({ providerId: p.id, ok: true, ms: Date.now() - t0 })
        return { value, providerId: p.id, attempts }
      } catch (err) {
        markFailure(p.id, err)
        lastError = err
        attempts.push({ providerId: p.id, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return null
  }

  const tryBuiltin = async (): Promise<RoutedResult<T>> => {
    const id = `builtin:zai-${category === 'translate' ? 'llm' : category}`
    const t0 = Date.now()
    try {
      const value = await call.builtin()
      attempts.push({ providerId: id, ok: true, ms: Date.now() - t0 })
      return { value, providerId: id, attempts }
    } catch (err) {
      lastError = err
      attempts.push({ providerId: id, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) })
      throw new Error(`All ${category} providers failed — ${attempts.map((a) => `${a.providerId}: ${a.error ?? 'failed'}`).join(' · ')}`)
    }
  }

  // Pass 1: healthy user providers → built-in on their failure.
  const fresh = await chain(category, false)
  const result = await tryUserProviders(fresh)
  if (result) return result
  try {
    return await tryBuiltin()
  } catch {
    // Pass 2: give cooled-down user providers one final real chance.
    const now = Date.now()
    const cooled = (await loadProviders()).filter(
      (p) => p.category === category && health.get(p.id)?.cooldownUntil && (health.get(p.id)!.cooldownUntil ?? 0) > now
    )
    const retry = await tryUserProviders(cooled)
    if (retry) return retry
    try {
      return await tryBuiltin()
    } catch (finalErr) {
      throw finalErr
    }
  }
}

// ── OpenAI-compatible adapters ───────────────────────────────────────────────
// The concrete HTTP adapters live in ONE shared module (src/lib/providers/
// adapters.ts) used by BOTH this service (live routing) and the Next.js API
// (connection tests) so behavior can never drift between the two.

export { openAICompatibleASR, openAICompatibleChat, openAICompatibleTTS } from '../../../src/lib/providers/adapters'
