// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible provider adapters — SHARED between the Next.js API routes
// (connection tests) and the translator mini-service (live routing).
// Pure fetch code, no state, no secrets in logs. Timeouts are real.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterProvider {
  baseUrl: string
  apiKey: string | null
  model?: string | null
  voiceId?: string | null
}

function requireKey(p: AdapterProvider): string {
  if (!p.apiKey) throw new Error('API key missing for this provider')
  return p.apiKey
}

const CALL_TIMEOUT_MS = 30_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** ASR via POST {baseUrl}/audio/transcriptions (multipart, whisper-style). */
export async function openAICompatibleASR(p: AdapterProvider, wavBase64: string): Promise<string> {
  const bytes = Buffer.from(wavBase64, 'base64')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', p.model ?? 'whisper-1')
  const res = await fetchWithTimeout(`${p.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireKey(p)}` },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${body.slice(0, 160)}`)
  }
  const data = (await res.json()) as { text?: string }
  return (data.text ?? '').trim()
}

/** Translation via POST {baseUrl}/chat/completions. */
export async function openAICompatibleChat(
  p: AdapterProvider,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.3
): Promise<string> {
  const res = await fetchWithTimeout(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({
      model: p.model ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${body.slice(0, 160)}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (data.choices?.[0]?.message?.content ?? '').trim()
}

/** TTS via POST {baseUrl}/audio/speech. Returns raw audio bytes + format. */
export async function openAICompatibleTTS(
  p: AdapterProvider,
  text: string,
  speed: number
): Promise<{ bytes: Buffer; format: 'wav' | 'mp3' }> {
  const res = await fetchWithTimeout(`${p.baseUrl.replace(/\/$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({
      model: p.model ?? 'tts-1',
      input: text,
      voice: p.voiceId ?? 'alloy',
      response_format: 'wav',
      speed: Math.min(4, Math.max(0.25, speed)),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${body.slice(0, 160)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const isWav = buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF'
  return { bytes: buf, format: isWav ? 'wav' : 'mp3' }
}
