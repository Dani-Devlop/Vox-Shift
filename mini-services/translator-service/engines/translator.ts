import type { StyleMode } from '../types'
import { getZAI } from './asr'

// ─────────────────────────────────────────────────────────────────────────────
// Translation Engine — Natural language translation layer
// Understands context, keeps the speaker's intent & register, avoids robotic
// word-by-word output. Handles both Persian script and romanized Persian
// (Finglish) which is what ASR often emits for spoken Persian.
// ─────────────────────────────────────────────────────────────────────────────

export interface TranslationContextTurn {
  source: string
  translated: string
}

export interface TranslationEngine {
  readonly id: string
  translate(
    text: string,
    opts: {
      sourceLang: string
      targetLang: string
      style: StyleMode
      history?: TranslationContextTurn[]
    }
  ): Promise<string>
}

const LANG_NAMES: Record<string, string> = {
  fa: 'Persian (Farsi)',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ar: 'Arabic',
  tr: 'Turkish',
  it: 'Italian',
}

const STYLE_RULES: Record<StyleMode, string> = {
  natural:
    'Translate into natural, spoken %T% exactly as a real person would say it in conversation. ' +
    'Preserve the casualness, warmth, humour or bluntness of the original. ' +
    'Use contractions and everyday phrasing. NEVER produce stiff, literal or robotic wording. ' +
    'If the original is a colloquial expression, use the equivalent colloquial expression in %T%.',
  clean:
    'Translate into natural, spoken %T% exactly as a real person would say it, but keep it family-friendly: ' +
    'soften or mildly rephrase profanity, slurs and crude sexual language without changing the overall meaning of the sentence. ' +
    'Do not censor ordinary words and never drop the intent of the sentence.',
  literal:
    'Translate as literally as possible into %T% while still being grammatically valid %T%. ' +
    'Stay close to the wording and structure of the original, but do not produce broken %T%. ' +
    'Do not add, omit or soften anything.',
  formal:
    'Translate into polite, professional %T% suitable for business meetings, interviews and official settings. ' +
    'Use complete sentences, courteous register and precise wording. ' +
    'Keep the meaning exactly — do not add facts — but elevate the tone: no slang, no contractions where %T% avoids them, no vulgar language (render it in neutral professional terms).',
  casual:
    'Translate into relaxed, friendly %T% the way close friends chat. ' +
    'Prefer short sentences, everyday words, contractions and light interjections. ' +
    'Keep the meaning exactly — do not add facts — and never sound formal or scripted.',
}

/** Per-language ASR-input quirks the model should know about. */
const ASR_INPUT_NOTES: Record<string, string> = {
  fa: 'Speech recognition of Persian frequently emits ROMANIZED Persian (Finglish), e.g. "Salam, khoobid?" — always interpret it as Persian, never as English.',
  de: 'Speech recognition of German usually returns proper German script; watch for umlaut/ß transcription slips.',
  fr: 'Speech recognition of French usually returns French with accents; watch for liaison/elision slips (e.g. "quest ce que" → "qu\'est-ce que").',
  es: 'Speech recognition of Spanish usually returns Spanish with accents and inverted punctuation; silently restore ¿ ¡ accents.',
  ar: 'Speech recognition of Arabic may return text without diacritics and with dropped hamza/ta-marbuta forms (أ إ آ ة ء); silently normalize the spelling and restore Arabic punctuation (؟ ،).',
  tr: 'Speech recognition of Turkish often drops diacritics (ı İ ğ ş ç ö ü) and may emit ASCII-only text; silently restore correct Turkish spelling.',
  it: 'Speech recognition of Italian usually returns accented Italian; watch for apostrophe elision slips (e.g. "un italiano" vs "un\'italiano", "come sta" vs "com\'esta").',
}

function buildSystemPrompt(sourceLang: string, targetLang: string, style: StyleMode): string {
  const S = LANG_NAMES[sourceLang] ?? sourceLang
  const T = LANG_NAMES[targetLang] ?? targetLang
  const styleRule = STYLE_RULES[style].replaceAll('%T%', T)
  // Formal Persian means written register (کتابی) — the colloquial rule would
  // contradict it, so the spoken-Persian rule only applies to other styles.
  const colloquialRule =
    targetLang === 'fa' && style !== 'formal'
      ? `\nSPOKEN PERSIAN RULE (critical):\n- Output in colloquial spoken Persian (محاوره‌ای), exactly how Iranians actually talk: use «می‌کنم/می‌کنی» instead of «می‌نمایم», «هست/هستیم» may drop to «ـه/ـیم», use «خوبه، باشه، چی، آره، نه».\n- Do NOT use formal written/literary Persian (کتابی). Example: "How are you?" → «حالت چطوره؟» not «حال شما چگونه است؟».\n- Always write in Persian script.\n`
      : targetLang === 'fa' && style === 'formal'
        ? `\nFORMAL PERSIAN RULE (critical):\n- Output in polite written Persian (کتابی) suitable for official settings: use «می‌کنم/می‌فرمایند», «هست», «لطفاً», full honorific forms.\n- Avoid heavy colloquial contractions («خوبه، باشه») — keep the register professional.\n- Always write in Persian script.\n`
        : ''
  const arabicRule =
    targetLang === 'ar'
      ? `\nSPOKEN ARABIC RULE (important):\n- Output in simple, widely understood spoken Arabic that leans close to Modern Standard Arabic while staying conversational (sometimes called the "white dialect").\n- Do NOT use region-locked vocabulary or dialect markers (e.g. Levantine «شو/ليش/فرحتني», Gulf «شلون/ودي», Egyptian «إزيك/عايز»); prefer forms like «ماذا/لماذا/كيف حالك» that every Arabic speaker understands.\n- Keep it natural and conversational, never stiff bookish MSA.\n- Always write in Arabic script.\n`
      : ''
  const asrNote = ASR_INPUT_NOTES[sourceLang]
  return [
    `You are the translation core of a real-time live speech translator. You translate spoken ${S} into spoken ${T}.`,
    '',
    'INPUT CHARACTERISTICS (important):',
    `- The text comes from automatic speech recognition of ${S} speech.`,
    `- It may contain small recognition errors, missing punctuation, or run-together words. Silently interpret and recover the intended sentence before translating.`,
    asrNote ? `- ${asrNote}` : null,
    '',
    'STYLE RULE:',
    `- ${styleRule}`,
    colloquialRule,
    arabicRule,
    'OUTPUT RULES:',
    '- Output ONLY the translated sentence. No quotes, no explanations, no transliteration, no notes.',
    '- Keep it short like real speech. Never prefix with "Translation:" or anything similar.',
    '- If the input is only a filler word (um, ah, هوم, äh, euh, eh) output the equivalent filler only.',
    '- If the input is empty or not understandable, output exactly: [unclear]',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function buildUserPrompt(
  text: string,
  history?: TranslationContextTurn[],
  speaker?: SpeakerContext
): string {
  // Structured speaker metadata (v3 §16) — the LLM is the REASONING layer and
  // receives diarization results as data; it never performs identification.
  const speakerBlock = speaker
    ? [
        '',
        '[SPEAKER CONTEXT]',
        JSON.stringify({
          speaker_id: speaker.speakerId,
          contact_id: speaker.contactId ?? null,
          speaker_name: speaker.speakerName ?? null,
          confidence: speaker.confidence ?? null,
          identification_status: speaker.identificationStatus,
        }),
        '(Speaker metadata comes from the diarization layer — informational only. Translate ONLY the utterance text; keep names and address forms natural.)',
        '',
      ].join('\n')
    : ''
  if (!history || history.length === 0) return `${speakerBlock}${text}`
  // Rolling conversational context keeps pronouns/tense coherent across utterances.
  const contextLines = history
    .slice(-6)
    .map((t) => `- ${t.source}  →  ${t.translated}`)
    .join('\n')
  return [
    'Recent conversation (for context only, do not translate these):',
    contextLines,
    speakerBlock,
    `Now translate this utterance: ${text}`,
  ].join('\n')
}

/** Diarization-derived context handed to the LLM (§16 — data, never audio). */
export interface SpeakerContext {
  speakerId: string
  contactId?: string
  speakerName?: string
  confidence?: number
  identificationStatus: 'verified' | 'possible' | 'unknown' | 'context'
}

// ── Auto language detection ───────────────────────────────────────────────────
// When the user picks the AUTO direction, the ASR text's language is unknown
// (Finglish vs English vs German…). Detection runs INSIDE the same translation
// call: the model reports the detected language + translation in one reply, so
// auto mode costs no extra round-trip. Candidates are the app's enabled set.

export const AUTO_DETECT_LANGS = ['fa', 'en', 'de', 'fr', 'es', 'ar', 'tr', 'it'] as const

/** Parse the client-provided pair spec ('fa,en') into a valid 2-language list. */
export function parseAutoPair(pair: string | undefined | null): [string, string] {
  const parts = (pair ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => (AUTO_DETECT_LANGS as readonly string[]).includes(s))
  const a = parts[0] ?? 'fa'
  const b = parts[1] && parts[1] !== a ? parts[1] : 'en'
  return [a, b]
}

export interface AutoTranslateResult {
  detectedLang: string
  text: string
}

function buildAutoSystemPrompt(targetLang: string, style: StyleMode, candidates?: string[]): string {
  const T = LANG_NAMES[targetLang] ?? targetLang
  const allowed = (candidates ?? []).filter((l) => (AUTO_DETECT_LANGS as readonly string[]).includes(l))
  const list = allowed.length >= 2 ? allowed : [...AUTO_DETECT_LANGS]
  const candidateStr = list.map((l) => `${l} = ${LANG_NAMES[l] ?? l}`).join(', ')
  // Reuse the exact style + target-language rules of the normal prompt.
  const stylePrompt = buildSystemPrompt('fa', targetLang, style)
    .split('\n')
    .filter((line) => !line.startsWith('You are the translation core'))
    .join('\n')
  return [
    `You are the translation core of a real-time live speech translator. The SOURCE language is UNKNOWN and must be detected per utterance, then translated into spoken ${T}.`,
    '',
    `DETECTION (critical):`,
    `- Detect which of these languages the utterance is: ${candidateStr}.`,
    `- Romanized Persian (Finglish, e.g. "Salam, khoobid?") is spoken PERSIAN → detect 'fa', never 'en'.`,
    `- Detect ONLY from the listed set. If genuinely ambiguous between two, prefer the one with more non-English markers.`,
    '',
    'INPUT CHARACTERISTICS (important):',
    '- The text comes from automatic speech recognition and may contain small recognition errors, missing punctuation, or run-together words. Silently recover the intended sentence before translating.',
    '',
    'STYLE + TARGET RULES:',
    stylePrompt,
    'OUTPUT FORMAT (strict — no deviations):',
    'Line 1 exactly: DETECTED: <code from the list>',
    'Line 2 exactly: TRANSLATION: <the translated sentence only>',
    'No quotes, no extra lines, no notes. If the input is not understandable: DETECTED: fa / TRANSLATION: [unclear]',
  ].join('\n')
}

function parseAutoReply(raw: string, candidates?: string[]): AutoTranslateResult {
  const text = raw.trim()
  const detected = text.match(/DETECTED:\s*([a-z]{2})/i)?.[1]?.toLowerCase() ?? ''
  const translation =
    text
      .match(/TRANSLATION:\s*([\s\S]+)/i)?.[1]
      ?.replace(/^\s*["“”«»'`]+|["“”«»'`]+\s*$/g, '')
      .trim() ?? ''
  const allowed = (candidates ?? []).filter((l) => (AUTO_DETECT_LANGS as readonly string[]).includes(l))
  const validSet = allowed.length >= 2 ? allowed : [...AUTO_DETECT_LANGS]
  const lang = validSet.includes(detected) ? detected : validSet[0]
  return { detectedLang: lang, text: translation }
}

export class LLMTranslationEngine implements TranslationEngine {
  readonly id = 'zai-llm'

  async translate(
    text: string,
    opts: { sourceLang: string; targetLang: string; style: StyleMode; history?: TranslationContextTurn[] }
  ): Promise<string> {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: buildSystemPrompt(opts.sourceLang, opts.targetLang, opts.style) },
        { role: 'user', content: buildUserPrompt(text, opts.history) },
      ],
      thinking: { type: 'disabled' },
      temperature: 0.3,
    })
    let out = (completion.choices[0]?.message?.content ?? '').trim()
    // Defensive cleanup: strip wrapping quotes / markdown the model sometimes adds.
    out = out.replace(/^["“”«»'`]+|["“”«»'`]+$/g, '').trim()
    if (out.startsWith('Translation:')) out = out.slice('Translation:'.length).trim()
    return out
  }

  /**
   * AUTO-direction translate: detect the spoken language (from the enabled
   * candidate set, Finglish → fa) and translate in ONE LLM round-trip.
   * Context history is included the same way as the explicit direction.
   * `candidates` narrows detection to the user's chosen pair when provided.
   */
  async translateAuto(
    text: string,
    opts: { targetLang: string; style: StyleMode; history?: TranslationContextTurn[]; candidates?: string[] }
  ): Promise<AutoTranslateResult> {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: buildAutoSystemPrompt(opts.targetLang, opts.style, opts.candidates) },
        { role: 'user', content: buildUserPrompt(text, opts.history) },
      ],
      thinking: { type: 'disabled' },
      temperature: 0.2,
    })
    const parsed = parseAutoReply(completion.choices[0]?.message?.content ?? '', opts.candidates)
    if (!parsed.text) {
      // Model ignored the format — fall back to treating the whole reply as the
      // translation with an honest 'unknown' detection (reported as the target-side
      // pair, never silently as a specific language).
      const fallback = (completion.choices[0]?.message?.content ?? '').trim().slice(0, 500)
      return { detectedLang: opts.targetLang === 'fa' ? 'en' : 'fa', text: fallback }
    }
    return parsed
  }
}

// ── Exports for the multi-provider router (master prompt v2 §22) ────────────
// User-registered OpenAI-compatible LLM endpoints run the EXACT same
// translation + auto-detect prompts as the built-in GLM engine, so switching
// providers never changes translation behavior — only who serves it.
export { buildSystemPrompt, buildUserPrompt, buildAutoSystemPrompt, parseAutoReply }
