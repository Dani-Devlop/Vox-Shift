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

function buildUserPrompt(text: string, history?: TranslationContextTurn[]): string {
  if (!history || history.length === 0) return text
  // Rolling conversational context keeps pronouns/tense coherent across utterances.
  const contextLines = history
    .slice(-6)
    .map((t) => `- ${t.source}  →  ${t.translated}`)
    .join('\n')
  return [
    'Recent conversation (for context only, do not translate these):',
    contextLines,
    '',
    `Now translate this utterance: ${text}`,
  ].join('\n')
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
}
