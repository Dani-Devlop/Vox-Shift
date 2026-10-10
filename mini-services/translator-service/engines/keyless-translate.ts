// ─────────────────────────────────────────────────────────────────────────────
// Keyless last-resort translation tier — `free:gtx-translate`.
//
// Google Translate public `gtx` endpoint: no API key, no registration. It is
// the FINAL failover tier in the provider router: it only runs after every
// user-registered provider, the built-in GLM engine AND all local runtimes
// have failed (e.g. a fresh deployment with zero configured providers).
//
// Honesty contract (§27/§29): every attempt is real and recorded — the
// pipeline reports `free:gtx-translate` as the provider actually used, so the
// UI can show exactly who served the translation. Quality note: gtx is plain
// MT — style modes (natural/clean/formal…) and conversational context are NOT
// applied on this tier; the LLM tiers remain the quality path.
// ─────────────────────────────────────────────────────────────────────────────

const GTX_TIMEOUT_MS = 9_000

/** Languages this tier can serve (mirrors the app's enabled set). */
export const GTX_LANGS = ['fa', 'en', 'de', 'fr', 'es', 'ar', 'tr', 'it'] as const

export interface GtxTranslit {
  /** Romanization of the SOURCE text (e.g. fa «سلام» → "salam"). */
  source?: string
  /** Romanization of the TRANSLATED text (e.g. en→fa output «سلام» → "salam"). */
  translated?: string
}

interface GtxResult {
  text: string
  detected?: string
  /** Present only when the gtx response carried romanization (dt=rm). */
  translit?: GtxTranslit
}

async function gtxFetch(text: string, from: string, to: string): Promise<GtxResult> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=bd&dt=rm' +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`
  const r = await fetch(url, {
    signal: AbortSignal.timeout(GTX_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
    },
  })
  if (!r.ok) throw new Error(`gtx HTTP ${r.status}`)
  const j = (await r.json()) as unknown[]
  const first = Array.isArray(j?.[0]) ? (j[0] as unknown[]) : []
  // Translation sentences: [translated, source, ...] pairs.
  const out = first
    .filter((s): s is [string, unknown] => Array.isArray(s))
    .map((s) => (typeof s?.[0] === 'string' ? s[0] : ''))
    .join('')
    .trim()
  if (!out) throw new Error('gtx empty response')
  // Romanization rides in a trailing sentence entry: [null, null,
  //  translitOfTranslated?, translitOfSource?] — only ever present when the
  //  respective side is non-Latin (fa/ar → latin reading aid). Zero extra
  //  requests: this comes from the SAME response (dt=rm).
  let translit: GtxTranslit | undefined
  for (const s of first) {
    if (!Array.isArray(s)) continue
    const translated = typeof s[2] === 'string' && s[2] ? s[2] : undefined
    const source = typeof s[3] === 'string' && s[3] ? s[3] : undefined
    if (translated || source) {
      translit = {
        translated: translated ?? translit?.translated,
        source: source ?? translit?.source,
      }
    }
  }
  const detected = typeof j?.[2] === 'string' ? (j[2] as string) : undefined
  return { text: out, detected, translit }
}

/** Plain explicit-direction translation (sourceLang may be 'auto'). */
export async function gtxTranslate(text: string, sourceLang: string, targetLang: string): Promise<string> {
  const from = GTX_LANGS.includes(sourceLang as (typeof GTX_LANGS)[number]) ? sourceLang : 'auto'
  const { text: out } = await gtxFetch(text, from, targetLang)
  return out
}

/** Full explicit-direction result INCLUDING romanization (pipeline uses this
 *  to surface the translit reading aid on the keyless tier). */
export async function gtxTranslateFull(text: string, sourceLang: string, targetLang: string): Promise<GtxResult> {
  const from = GTX_LANGS.includes(sourceLang as (typeof GTX_LANGS)[number]) ? sourceLang : 'auto'
  return gtxFetch(text, from, targetLang)
}

/**
 * AUTO-mode translation: detect + translate in one gtx round-trip.
 * Returns the same shape as the LLM auto engine. Romanized Persian (Finglish)
 * gets the same treatment the LLM prompt enforces: Latin-script Persian is
 * still Persian — gtx often mis-detects it as English, so a token heuristic
 * corrects it before the result is reported.
 */
export async function gtxTranslateAuto(
  text: string,
  targetLang: string,
  candidates?: string[]
): Promise<{ detectedLang: string; text: string; translit?: GtxTranslit; retargeted?: boolean }> {
  const first = await gtxFetch(text, 'auto', targetLang)
  let detectedLang = (first.detected ?? '').slice(0, 2).toLowerCase()
  if (detectedLang === 'en' && !/[\u0600-\u06FF]/.test(text) && /[A-Za-z]/.test(text)) {
    const finglish =
      /\b(salam|khoob|khoub|cheturi|chetoor|mamnoon|mersi|khodahafez|bekheir|shoma|sb|dobare|kheyli|mamnnoon|midonam|nemidonam|ast|hastam|hasti|beyn|bishtar|lotfan|bebakhshid|merci|farda|emrooz|dost|khanoom|agha)\b/i
    if (finglish.test(text)) detectedLang = 'fa'
  }
  const allowed = (candidates ?? []).filter((l) => (GTX_LANGS as readonly string[]).includes(l))
  const validSet = allowed.length >= 2 ? allowed : [...GTX_LANGS]
  if (!validSet.includes(detectedLang as (typeof GTX_LANGS)[number])) detectedLang = validSet[0]

  // ── Pair-echo repair (bidirectional conversation contract) ──────────────
  // The AUTO-pair pipeline asks for targetLang = pairA and expects the OTHER
  // side of the pair relative to the DETECTED source language. gtx needs a
  // fixed target per call: when the detected source language EQUALS the
  // target we asked for, the first pass is a same-language echo (fa input,
  // tl=fa → fa text back) and must be re-fetched toward the other side.
  // Detected-language normalization above runs BEFORE this check so the
  // Finglish correction also triggers the repair.
  if (allowed.length >= 2 && detectedLang === targetLang) {
    const other = allowed.find((l) => l !== targetLang)
    if (other) {
      const second = await gtxFetch(text, detectedLang, other)
      if (second.text) {
        return { detectedLang, text: second.text, translit: second.translit ?? first.translit, retargeted: true }
      }
    }
  }
  return { detectedLang, text: first.text, translit: first.translit }
}
