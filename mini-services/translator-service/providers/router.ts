import { readFileSync } from 'fs'

// ─────────────────────────────────────────────────────────────────────────────
// Provider Router — multi-provider routing with POLICIES and AUTOMATIC
// FAILOVER and honest HEALTH states (master prompt v3 §15/§25/§26/§29).
//
// Provider classes (§15):  LOCAL (runtime on this machine, really executed)
//                          SERVER (self-hosted endpoint, e.g. Ollama/vLLM)
//                          CLOUD  (built-in z-ai engines, ElevenLabs clone)
//                          CUSTOM (user-registered OpenAI-compatible endpoint)
//
// Categories: asr · translate · llm · tts (voice-cloning routes through the
// dedicated cloning engine; speaker detection/embedding/diarization are
// always LOCAL DSP — see src/lib/speaker/voiceprint.ts).
//
// Routing policies (§25): auto · local_first · server_first · quality_first ·
// low_cost · privacy_first · manual · failover. Every attempt is real; the
// ACTUAL provider used is recorded on every result; failures emit
// provider.failed / provider.fallback events through the event sink.
//
// API keys live ONLY in the DB (AES-256-GCM) — never logged, never returned.
// ─────────────────────────────────────────────────────────────────────────────

import type { DetectedLocalRuntimes, LocalRuntimeStatus } from './local-runtimes'
import { detectLocalRuntimes, invalidateLocalRuntimeCache } from './local-runtimes'

export type ProviderCategory = 'asr' | 'translate' | 'llm' | 'tts'
export type ProviderClass = 'local' | 'server' | 'cloud' | 'custom'
export type RoutingPolicy =
  | 'auto'
  | 'local_first'
  | 'server_first'
  | 'quality_first'
  | 'low_cost'
  | 'privacy_first'
  | 'manual'
  | 'failover'

export const ROUTING_POLICIES: RoutingPolicy[] = [
  'auto',
  'local_first',
  'server_first',
  'quality_first',
  'low_cost',
  'privacy_first',
  'manual',
  'failover',
]

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
  /** Provider class (§15) — local | server | cloud | custom. */
  class: ProviderClass
  name: string
  baseUrl: string
  model: string | null
  voiceId: string | null
  apiKey: string | null
  /** Extra HTTP headers (server-side only; values never returned to clients). */
  headers: Record<string, string>
  priority: number
  enabled: boolean
}

export interface ProviderHealth {
  providerId: string
  name: string
  category: string
  kind: string
  class: ProviderClass
  enabled: boolean
  state: ProviderHealthState
  lastError?: string
  lastCheckedAt?: string
  consecutiveFailures: number
  cooldownUntil?: string
  /** Real latency of the last successful call (ms). */
  lastMs?: number
  model?: string | null
}

interface HealthEntry {
  state: ProviderHealthState
  lastError?: string
  lastCheckedAt?: number
  consecutiveFailures: number
  cooldownUntil?: number
  lastMs?: number
}

/** Router events (§27) — wired to the socket layer by server.ts. */
export type RouterEvent =
  | { type: 'provider.failed'; category: string; providerId: string; error: string }
  | { type: 'provider.fallback'; category: string; fromProviderId: string; toProviderId: string }

let eventSink: ((e: RouterEvent) => void) | null = null
export function setRouterEventSink(fn: ((e: RouterEvent) => void) | null): void {
  eventSink = fn
}
function emitEvent(e: RouterEvent): void {
  try {
    eventSink?.(e)
  } catch {
    /* sink errors must never break routing */
  }
}

// ── Policy store ─────────────────────────────────────────────────────────────

let routingPolicy: RoutingPolicy = ((): RoutingPolicy => {
  const env = process.env.VOXSHIFT_ROUTING_POLICY as RoutingPolicy | undefined
  return env && ROUTING_POLICIES.includes(env) ? env : 'failover'
})()

export function getRoutingPolicy(): RoutingPolicy {
  return routingPolicy
}

/** Change the active policy at runtime (socket `providers:policy`). */
export function setRoutingPolicy(policy: string): RoutingPolicy {
  if (ROUTING_POLICIES.includes(policy as RoutingPolicy)) routingPolicy = policy as RoutingPolicy
  return routingPolicy
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
let providerCache: { rows: ProviderRow[]; at: number; fingerprint: string } | null = null
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

function parseHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj).slice(0, 8)) {
      if (typeof k === 'string' && k.length <= 60 && typeof v === 'string' && v.length <= 300) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function loadProviders(): Promise<ProviderRow[]> {
  try {
    const prisma = await getPrisma()
    // Change detection (cross-process): providers are edited through the
    // Next.js API in ANOTHER process — a pure TTL here served stale chains
    // right after an edit (observed: failover test created a provider and
    // called within 2 s). count + max(updatedAt) is a ~1 ms SQLite query and
    // catches every create/update/delete/enabled-toggle.
    const [count, agg] = await Promise.all([
      prisma.userProviderConfig.count(),
      prisma.userProviderConfig.aggregate({ _max: { updatedAt: true } }),
    ])
    const fingerprint = `${count}:${agg._max.updatedAt ? new Date(agg._max.updatedAt).getTime() : 0}`
    if (providerCache && providerCache.fingerprint === fingerprint && Date.now() - providerCache.at < PROVIDER_TTL_MS) {
      return providerCache.rows
    }
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
        class: (r.class === 'local' || r.class === 'server' || r.class === 'cloud' ? r.class : 'custom') as ProviderClass,
        name: r.name,
        baseUrl: r.baseUrl,
        model: r.model,
        voiceId: r.voiceId,
        apiKey,
        headers: parseHeaders(r.headersJson),
        priority: r.priority,
        enabled: r.enabled,
      })
    }
    providerCache = { rows: decrypted, at: Date.now(), fingerprint }
    return decrypted
  } catch (err) {
    console.error('[providers] load failed (continuing with built-ins):', err instanceof Error ? err.message : err)
    providerCache = { rows: [], at: Date.now(), fingerprint: 'error' }
    return []
  }
}

/** Force-reload provider configs (called after the user edits them). */
export function invalidateProviderCache(): void {
  providerCache = null
  invalidateLocalRuntimeCache()
}

// ── LOCAL runtime rows (§14/§15 — real runtimes only) ───────────────────────

function localRows(category: ProviderCategory, rt: DetectedLocalRuntimes): ProviderRow[] {
  return rt.runtimes
    .filter(
      (r: LocalRuntimeStatus) =>
        r.available &&
        // Ollama is registered under 'llm' but also serves TRANSLATION (§21 —
        // translation is an independent service; the local LLM is one of its
        // providers). No other runtime crosses categories.
        (r.category === category || (category === 'translate' && r.category === 'llm'))
    )
    .map((r) => ({
      id: r.id,
      category,
      kind: 'local-runtime',
      class: 'local' as const,
      name: r.name,
      baseUrl: '',
      model: r.model ?? null,
      voiceId: null,
      apiKey: null,
      headers: {},
      priority: 20,
      enabled: true,
    }))
}

// ── Health tracking (§29 — real states only) ────────────────────────────────

const health = new Map<string, HealthEntry>()

function classifyError(err: unknown): { state: ProviderHealthState; message: string } {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not configured|NOT_CONFIGURED|install/i.test(msg))
    return { state: 'NOT_CONFIGURED', message: msg.slice(0, 200) }
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

function markSuccess(providerId: string, ms: number): void {
  health.set(providerId, { state: 'READY', consecutiveFailures: 0, lastCheckedAt: Date.now(), lastMs: ms })
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

function healthOf(row: ProviderRow, now: number): ProviderHealth {
  const h = health.get(row.id)
  let state = h?.state ?? 'READY'
  if (h?.cooldownUntil && h.cooldownUntil > now) state = 'COOLDOWN'
  return {
    providerId: row.id,
    name: row.name,
    category: row.category,
    kind: row.kind,
    class: row.class,
    enabled: row.enabled,
    state,
    lastError: h?.lastError,
    lastCheckedAt: h?.lastCheckedAt ? new Date(h.lastCheckedAt).toISOString() : undefined,
    consecutiveFailures: h?.consecutiveFailures ?? 0,
    cooldownUntil: h?.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : undefined,
    lastMs: h?.lastMs,
    model: row.model,
  }
}

/** Public health snapshot (socket `providers:health`). */
export async function providerHealthSnapshot(): Promise<ProviderHealth[]> {
  const rows = await loadProviders()
  const now = Date.now()
  const out: ProviderHealth[] = rows.map((r) => healthOf(r, now))

  // LOCAL runtimes — probed for real (processes on disk + Ollama HTTP probe).
  try {
    const rt = await detectLocalRuntimes()
    for (const r of rt.runtimes) {
      const h = health.get(r.id)
      out.push({
        providerId: r.id,
        name: r.name,
        category: r.category,
        kind: 'local-runtime',
        class: 'local',
        enabled: true,
        state: r.available ? (h?.state ?? 'READY') : 'NOT_CONFIGURED',
        lastError: r.available ? h?.lastError : r.detail,
        lastCheckedAt: h?.lastCheckedAt ? new Date(h.lastCheckedAt).toISOString() : undefined,
        consecutiveFailures: h?.consecutiveFailures ?? 0,
        cooldownUntil: h?.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : undefined,
        lastMs: h?.lastMs,
        model: r.model,
      })
    }
  } catch {
    /* detection must never break the snapshot */
  }

  // Built-ins (CLOUD class). Real failures surface on actual calls + self-test.
  for (const b of [
    { providerId: 'builtin:zai-asr', name: 'Z.ai ASR (built-in)', category: 'asr' },
    { providerId: 'builtin:zai-llm', name: 'GLM Translation (built-in)', category: 'translate' },
    { providerId: 'builtin:zai-reasoning', name: 'GLM Reasoning/LLM (built-in)', category: 'llm' },
    { providerId: 'builtin:zai-tts', name: 'Z.ai TTS (built-in)', category: 'tts' },
  ]) {
    const h = health.get(b.providerId)
    out.push({
      providerId: b.providerId,
      name: b.name,
      category: b.category,
      kind: 'builtin',
      class: 'cloud',
      enabled: true,
      state: h?.state ?? 'READY',
      lastError: h?.lastError,
      lastCheckedAt: h?.lastCheckedAt ? new Date(h.lastCheckedAt).toISOString() : undefined,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      cooldownUntil: h?.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : undefined,
      lastMs: h?.lastMs,
    })
  }

  // Speaker stack (§15 — SPEAKER DETECTION / EMBEDDING / DIARIZATION): the
  // built-in LOCAL DSP engine (src/lib/speaker/voiceprint.ts + speaker-tracker)
  // REALLY executes on every utterance before ASR — these rows report that
  // honestly instead of hiding the categories.
  for (const s of [
    { providerId: 'local:speaker-detection', name: 'Local speaker detection (DSP voiceprint)', category: 'speaker-detection' },
    { providerId: 'local:speaker-embedding', name: 'Local speaker embedding (DSP) [budget-v3]', category: 'speaker-embedding' },
    { providerId: 'local:diarization', name: 'Local diarization (turn clustering)', category: 'diarization' },
  ]) {
    const h = health.get(s.providerId)
    out.push({
      providerId: s.providerId,
      name: s.name,
      category: s.category,
      kind: 'local-runtime',
      class: 'local',
      enabled: true,
      state: h?.state ?? 'READY',
      lastError: h?.lastError,
      lastCheckedAt: h?.lastCheckedAt ? new Date(h.lastCheckedAt).toISOString() : undefined,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      lastMs: h?.lastMs,
      model: 'dsp-voiceprint-v2',
    })
  }

  // Voice cloning (CLOUD — ElevenLabs IVC; honest when unconfigured).
  const cloneKey = envValue('ELEVENLABS_API_KEY')
  const cloneHealth = health.get('builtin:elevenlabs-clone')
  out.push({
    providerId: 'builtin:elevenlabs-clone',
    name: 'ElevenLabs Instant Voice Cloning (built-in)',
    category: 'voice-cloning',
    kind: 'builtin',
    class: 'cloud',
    enabled: true,
    state: cloneKey ? (cloneHealth?.state ?? 'READY') : 'NOT_CONFIGURED',
    lastError: cloneKey ? cloneHealth?.lastError : 'ELEVENLABS_API_KEY not configured — voice cloning is unavailable (honest state)',
    lastCheckedAt: cloneHealth?.lastCheckedAt ? new Date(cloneHealth.lastCheckedAt).toISOString() : undefined,
    consecutiveFailures: cloneHealth?.consecutiveFailures ?? 0,
  })
  // LOCAL voice cloning has no compatible engine on this machine — honest.
  out.push({
    providerId: 'local:voice-cloning',
    name: 'Local voice cloning (F5-TTS / XTTS / CosyVoice)',
    category: 'voice-cloning',
    kind: 'local-runtime',
    class: 'local',
    enabled: true,
    state: 'NOT_CONFIGURED',
    lastError:
      'No compatible local cloning engine installed. XTTS/F5-TTS need multi-GB models + a GPU-class machine — install one and register it as a Server provider to enable.',
    consecutiveFailures: 0,
  })
  return out
}

/** Providers to try: enabled, cooled-down ones skipped unless included. */
async function userChain(category: ProviderCategory, includeCooldown = false): Promise<ProviderRow[]> {
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
  /** LOCAL executor — omitted when the category has no local path. */
  local?: () => Promise<T>
}

export interface RoutedResult<T> {
  value: T
  providerId: string
  attempts: Array<{ providerId: string; ok: boolean; ms: number; error?: string }>
}

function orderRows(policy: RoutingPolicy, rows: ProviderRow[]): ProviderRow[] {
  const byPriority = [...rows].sort((a, b) => a.priority - b.priority)
  switch (policy) {
    case 'local_first':
    case 'low_cost':
    case 'privacy_first':
      // LOCAL rows are injected separately; among user rows prefer server/custom first.
      return [...byPriority.filter((r) => r.class === 'server' || r.class === 'local'), ...byPriority.filter((r) => r.class !== 'server' && r.class !== 'local')]
    case 'server_first':
      return [...byPriority.filter((r) => r.class === 'server'), ...byPriority.filter((r) => r.class === 'custom'), ...byPriority.filter((r) => r.class === 'cloud' || r.class === 'local')]
    case 'quality_first':
      return byPriority // user priority order; builtin runs FIRST via policy order
    case 'manual':
      return byPriority.slice(0, 1)
    default:
      return byPriority
  }
}

/**
 * Run a routed call under the ACTIVE POLICY with automatic failover.
 * All attempts are real and recorded; failures/fallbacks emit events (§27).
 */
export async function routedCall<T>(category: ProviderCategory, call: RoutedCall<T>): Promise<RoutedResult<T>> {
  const attempts: RoutedResult<T>['attempts'] = []
  const policy = routingPolicy
  const rt = await detectLocalRuntimes()

  interface Step {
    id: string
    row?: ProviderRow
    kind: 'user' | 'local' | 'builtin'
    run: () => Promise<T>
  }

  const userRows = orderRows(policy, await userChain(category, false))
  const localProviders = call.local ? localRows(category, rt) : []
  const builtinId = `builtin:zai-${category === 'translate' || category === 'llm' ? 'llm' : category}`

  const steps: Step[] = []
  const pushUser = (rows: ProviderRow[]) => {
    for (const p of rows) steps.push({ id: p.id, row: p, kind: 'user', run: () => call.user(p) })
  }
  const pushLocal = () => {
    for (const p of localProviders) steps.push({ id: p.id, row: p, kind: 'local', run: () => call.local!() })
  }
  const pushBuiltin = () => steps.push({ id: builtinId, kind: 'builtin', run: () => call.builtin() })

  switch (policy) {
    case 'local_first':
    case 'low_cost':
      pushLocal()
      pushUser(userRows)
      pushBuiltin()
      break
    case 'privacy_first':
      pushLocal()
      pushUser(userRows) // NO built-in — cloud is excluded for privacy
      break
    case 'server_first':
      pushUser(userRows)
      pushLocal()
      pushBuiltin()
      break
    case 'quality_first':
      pushBuiltin()
      pushUser(userRows)
      pushLocal()
      break
    case 'manual':
      pushUser(userRows) // exactly the first enabled user row, nothing else
      break
    case 'auto':
      // AUTO: quality-sensitive categories prefer the built-in; audio capture
      // prefers whatever is already warm locally.
      if (category === 'asr') {
        pushLocal()
        pushUser(userRows)
        pushBuiltin()
      } else {
        pushBuiltin()
        pushUser(userRows)
        pushLocal()
      }
      break
    case 'failover':
    default:
      pushUser(userRows)
      pushBuiltin()
      pushLocal() // final local safety net (e.g. espeak TTS when cloud fails)
      break
  }

  let lastError: unknown = null
  let fallbackFrom: string | null = null

  // ── Per-step wall-clock budget (§29 honesty: a provider that never answers
  // must NEVER stall the pipeline). Real-world budgets: cloud SDKs normally
  // answer in 0.2–4 s; local CPU inference (Ollama 0.5–3 B) can legitimately
  // take tens of seconds. The budget bounds the WORST case so the FIFO and
  // the client always get a result or an honest error.
  const STEP_BUDGET_MS: Record<string, number> = {
    asr: 30_000,
    translate: 60_000,
    llm: 60_000,
    tts: 30_000,
  }
  const budget = STEP_BUDGET_MS[category] ?? 45_000
  const runWithBudget = async (step: Step): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        step.run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${step.id} exceeded its ${Math.round(budget / 1000)}s budget — treated as OFFLINE`)),
            budget
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const runSteps = async (list: Step[]): Promise<RoutedResult<T> | null> => {
    for (const step of list) {
      const t0 = Date.now()
      try {
        if (step.kind === 'user' && step.row && !step.row.apiKey && !isKeylessUrl(step.row.baseUrl)) {
          // User rows normally require a key; local/keyless servers are exempt.
          markFailure(step.id, new Error('API key missing'))
          attempts.push({ providerId: step.id, ok: false, ms: 0, error: 'API key missing' })
          emitEvent({ type: 'provider.failed', category, providerId: step.id, error: 'API key missing' })
          continue
        }
        const value = await runWithBudget(step)
        markSuccess(step.id, Date.now() - t0)
        attempts.push({ providerId: step.id, ok: true, ms: Date.now() - t0 })
        if (fallbackFrom) {
          emitEvent({ type: 'provider.fallback', category, fromProviderId: fallbackFrom, toProviderId: step.id })
        }
        return { value, providerId: step.id, attempts }
      } catch (err) {
        markFailure(step.id, err)
        lastError = err
        const msg = err instanceof Error ? err.message : String(err)
        attempts.push({ providerId: step.id, ok: false, ms: Date.now() - t0, error: msg })
        emitEvent({ type: 'provider.failed', category, providerId: step.id, error: msg.slice(0, 200) })
        fallbackFrom = step.id
      }
    }
    return null
  }

  // Pass 1: fresh steps.
  const result = await runSteps(steps)
  if (result) return result

  // Pass 2 (failover policies only): one final chance for cooled-down rows,
  // then the builtin as the never-empty fallback.
  if (policy !== 'manual' && policy !== 'privacy_first') {
    const cooled = (await loadProviders()).filter(
      (p) => p.category === category && health.get(p.id)?.cooldownUntil && (health.get(p.id)!.cooldownUntil ?? 0) > now2()
    )
    const retryRows = orderRows(policy, cooled)
    const retry = await runSteps(
      retryRows.map((p) => ({ id: p.id, row: p, kind: 'user' as const, run: () => call.user(p) }))
    )
    if (retry) return retry
    if (!steps.some((s) => s.kind === 'builtin')) {
      const t0 = Date.now()
      try {
        const value = await call.builtin()
        attempts.push({ providerId: builtinId, ok: true, ms: Date.now() - t0 })
        if (fallbackFrom) emitEvent({ type: 'provider.fallback', category, fromProviderId: fallbackFrom, toProviderId: builtinId })
        return { value, providerId: builtinId, attempts }
      } catch (err) {
        lastError = err
        attempts.push({ providerId: builtinId, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  const agg = lastError instanceof Error ? lastError.message : 'all providers failed'
  throw new Error(`All ${category} providers failed (${policy}) — ${attempts.map((a) => `${a.providerId}: ${a.error ?? 'failed'}`).join(' · ') || agg}`)
}

function now2(): number {
  return Date.now()
}

/** Keyless-capable endpoints: local/private servers (Ollama, vLLM, llama.cpp). */
function isKeylessUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl)
    return (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '0.0.0.0' ||
      u.hostname.startsWith('192.168.') ||
      u.hostname.startsWith('10.') ||
      u.hostname.endsWith('.local')
    )
  } catch {
    return false
  }
}

// ── OpenAI-compatible adapters ───────────────────────────────────────────────
// The concrete HTTP adapters live in ONE shared module (src/lib/providers/
// adapters.ts) used by BOTH this service (live routing) and the Next.js API
// (connection tests) so behavior can never drift between the two.

export { openAICompatibleASR, openAICompatibleChat, openAICompatibleTTS } from '../../../src/lib/providers/adapters'
