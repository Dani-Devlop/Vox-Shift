import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server } from 'socket.io'
import type { StageEvent as PipelineStageEvent, TextTranslateRequest, TranslationEvent as PipelineTranslationEvent, UtteranceError as PipelineError, UtteranceRequest, UtteranceResult as PipelineResult } from './types'
import { DEFAULTS } from './types'
import { processAsrPartial, processTextTranslate, processUtterance, clearSession, type PipelineHandlers, type PipelineEvent } from './pipeline'
import { SpeakerTracker, type TrackedContact } from './engines/speaker-tracker'
import { invalidateProviderCache, providerHealthSnapshot, recordTestResult, setRouterEventSink, setRoutingPolicy, getRoutingPolicy, ROUTING_POLICIES } from './providers/router'
import { pcmToWav } from './engines/audio-utils'
import { prewarmTTS, ttsWorkerState } from './engines/local-tts'
import { VoiceIdentityEngine } from './engines/voice'
import type { SpeakerInfo } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Realtime transport — socket.io gateway for the live translator pipeline.
// NOTE: path MUST stay '/' (Caddy gateway forwards ?XTransformPort=3003 here).
//
// v2 additions (master prompt): per-session SpeakerTracker (contacts sync,
// unknown-speaker enrollment sample assembly, labeling/corrections) and the
// provider health channel (§30). Speaker identity is computed SERVER-SIDE
// from a local voiceprint — never guessed, never fabricated.
// ─────────────────────────────────────────────────────────────────────────────

/** Sanitize the manual speaker-turn label ('A' default). */
function speakerRole(value: unknown): 'A' | 'B' | undefined {
  return value === 'A' || value === 'B' ? value : undefined
}

// ── Router events (§27) — broadcast to every connected client ───────────────
// provider.failed / provider.fallback are service-wide facts, not per-socket.
setRouterEventSink((e) => {
  io.emit(e.type, e)
})

const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 12e6, // utterance PCM + enrollment samples can be several MB
})

/** Max queued utterances per socket (protects memory, keeps playback order). */
const MAX_QUEUE = 4

/** Sanitize a client-synced contact list (defense in depth). */
function sanitizeContacts(raw: unknown): TrackedContact[] {
  if (!Array.isArray(raw)) return []
  const out: TrackedContact[] = []
  for (const c of raw.slice(0, 200)) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (typeof o.contactId !== 'string' || typeof o.name !== 'string') continue
    if (!Array.isArray(o.vector) || o.vector.length === 0 || o.vector.length > 256) continue
    const vector: number[] = []
    for (const v of o.vector.slice(0, 256)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) { vector.length = 0; break }
      vector.push(n)
    }
    if (vector.length === 0) continue
    out.push({
      contactId: o.contactId.slice(0, 64),
      name: o.name.slice(0, 80),
      vector,
      threshold: typeof o.threshold === 'number' && o.threshold >= 0.5 && o.threshold <= 0.99 ? o.threshold : undefined,
      disabled: o.disabled === true,
    })
  }
  return out
}

io.on('connection', (socket) => {
  console.log(`[translator] client connected: ${socket.id}`)

  /** Per-socket speaker tracker (real-time recognition + enrollment audio). */
  const tracker = new SpeakerTracker()

  /** Last attributed speaker — drives speaker.started/changed events (§27). */
  let lastSpeaker: SpeakerInfo | null = null

  /** Map a pipeline speaker.info event to the semantic speaker.* events. */
  const emitSpeakerEvents = (info: SpeakerInfo) => {
    if (!lastSpeaker || lastSpeaker.clusterKey !== info.clusterKey) {
      socket.emit(lastSpeaker ? 'speaker.changed' : 'speaker.started', {
        from: lastSpeaker ? { clusterKey: lastSpeaker.clusterKey, name: lastSpeaker.name ?? null } : null,
        to: { clusterKey: info.clusterKey, contactId: info.contactId ?? null, name: info.name ?? null, status: info.status },
      })
    }
    if (info.status === 'verified' && info.name) {
      socket.emit('speaker.recognized', {
        clusterKey: info.clusterKey,
        contactId: info.contactId ?? null,
        name: info.name,
        confidence: info.confidence ?? null,
      })
    } else if (info.status === 'unknown') {
      socket.emit('speaker.unknown', { clusterKey: info.clusterKey, name: info.name ?? null })
    }
    lastSpeaker = info
  }

  /** FIFO queue per socket so playback order matches speech order. */
  const queue: Array<{ kind: 'audio'; req: UtteranceRequest } | { kind: 'text'; req: TextTranslateRequest }> = []
  let busy = false

  const drain = () => {
    if (busy || queue.length === 0) return
    const item = queue.shift()!
    busy = true
    const handlers = {
      onStage: (e: PipelineStageEvent) => socket.emit('stage', e),
      onTranslation: (e: PipelineTranslationEvent) => socket.emit('translation', e),
      onEvent: (e: PipelineEvent) => {
        // §27 real-time event model — the frontend reacts to THESE, never to
        // timers or mock data.
        if (e.type === 'speaker.info' && e.speaker) {
          emitSpeakerEvents(e.speaker as SpeakerInfo)
          return
        }
        // The remaining pipeline events are forwarded under their own names.
        const { type, ...payload } = e
        socket.emit(type, payload)
      },
      onResult: (r: PipelineResult) => {
        socket.emit('result', r)
        busy = false
        drain()
      },
      onError: (e: PipelineError) => {
        socket.emit('utterance:error', e)
        busy = false
        drain()
      },
    }
    const processor =
      item.kind === 'audio' ? processUtterance(item.req, handlers, tracker) : processTextTranslate(item.req, handlers)
    processor.catch((err) => {
      console.error(`[translator] pipeline crash: ${err}`)
      socket.emit('utterance:error', {
        utteranceId: item.req.utteranceId,
        stage: item.kind === 'audio' ? 'asr' : 'translate',
        message: 'internal pipeline error',
      })
      busy = false
      drain()
    })
  }

  socket.on(
    'utterance',
    (data: Partial<UtteranceRequest> & { utteranceId: string }) => {
      if (!data?.utteranceId || !data?.audioBase64) {
        socket.emit('utterance:error', {
          utteranceId: data?.utteranceId ?? '?',
          stage: 'queue',
          message: 'malformed utterance payload',
        })
        return
      }
      const req: UtteranceRequest = {
        utteranceId: data.utteranceId,
        sessionId: socket.id,
        audioBase64: data.audioBase64,
        sampleRate: data.sampleRate || DEFAULTS.sampleRate,
        sourceLang: data.sourceLang || DEFAULTS.sourceLang,
        targetLang: data.targetLang || DEFAULTS.targetLang,
        style: data.style || DEFAULTS.style,
        voice: data.voice || DEFAULTS.voice,
        speed: typeof data.speed === 'number' ? data.speed : DEFAULTS.speed,
        pitchRatio: typeof data.pitchRatio === 'number' ? data.pitchRatio : undefined,
        profileMode: data.profileMode === 'clone' || data.profileMode === 'voice-match' ? data.profileMode : undefined,
        providerProfileId: typeof data.providerProfileId === 'string' ? data.providerProfileId : undefined,
        providerModel: typeof data.providerModel === 'string' ? data.providerModel : undefined,
        stability: typeof data.stability === 'number' ? data.stability : undefined,
        providerSimilarity: typeof data.providerSimilarity === 'number' ? data.providerSimilarity : undefined,
        providerStyle: typeof data.providerStyle === 'number' ? data.providerStyle : undefined,
        speakerRole: speakerRole(data.speakerRole),
        detectionMode: data.detectionMode === 'manual' ? 'manual' : 'auto',
        ttsEcho: data.ttsEcho === true,
        autoPair: typeof data.autoPair === 'string' ? data.autoPair.slice(0, 20) : undefined,
      }
      // Test 10 (§30): never recognize VoxShift's own TTS as a human speaker.
      if (req.ttsEcho) {
        socket.emit('utterance:error', {
          utteranceId: req.utteranceId,
          stage: 'queue',
          message: 'echo-suppressed',
        })
        return
      }
      if (queue.length >= MAX_QUEUE) {
        socket.emit('utterance:error', {
          utteranceId: req.utteranceId,
          stage: 'queue',
          message: 'utterance queue full — speak a bit slower',
        })
        return
      }
      queue.push({ kind: 'audio', req })
      drain()
    }
  )

  socket.on('session:reset', () => {
    clearSession(socket.id)
    socket.emit('session:reset-ok')
  })

  // ── v2: speaker recognition protocol ─────────────────────────────────────

  /** Client announces its user id (non-secret cookie id) + syncs contacts. */
  socket.on('session:init', (data: { userId?: string; contacts?: unknown }) => {
    if (data?.contacts !== undefined) tracker.setContacts(sanitizeContacts(data.contacts))
    socket.emit('session:init-ok', { speakers: tracker.snapshot() })
  })

  /** Full contact-list sync (after create/rename/delete/enable). */
  socket.on('contacts:sync', (data: { contacts?: unknown }) => {
    tracker.setContacts(sanitizeContacts(data?.contacts))
    socket.emit('contacts:sync-ok', { count: tracker.getContactsSnapshot().length })
  })

  /** New conversation → fresh speaker registry. */
  socket.on('speakers:reset', () => {
    tracker.reset()
    socket.emit('speakers:reset-ok')
  })

  /** Thread reopen → seed prior speaker clusters so ids stay stable. */
  socket.on('speakers:seed', (data: { clusters?: Array<{ clusterKey?: string; contactId?: string | null; name?: string | null; vector?: unknown }> }) => {
    const clusters = (data?.clusters ?? [])
      .filter((c) => c && typeof c.clusterKey === 'string')
      .slice(0, 50)
      .map((c) => ({
        clusterKey: String(c.clusterKey).slice(0, 24),
        contactId: typeof c.contactId === 'string' ? c.contactId.slice(0, 64) : null,
        name: typeof c.name === 'string' ? c.name.slice(0, 80) : null,
        vector: Array.isArray(c.vector) && c.vector.every((v) => Number.isFinite(Number(v))) ? (c.vector as number[]).map(Number) : null,
      }))
    tracker.seed(clusters)
    socket.emit('speakers:seed-ok', { count: clusters.length })
  })

  /** User identifies / corrects a speaker (spec §11/§18). */
  socket.on('speakers:label', (data: { clusterKey?: string; contactId?: string | null; name?: string | null; vector?: unknown }) => {
    if (!data?.clusterKey) return
    const vector =
      Array.isArray(data.vector) && data.vector.length > 0 && data.vector.every((v) => Number.isFinite(Number(v)))
        ? (data.vector as number[]).map(Number)
        : undefined
    const info = tracker.label(String(data.clusterKey).slice(0, 24), {
      contactId: data.contactId === undefined ? undefined : typeof data.contactId === 'string' ? data.contactId.slice(0, 64) : null,
      name: typeof data.name === 'string' ? data.name.slice(0, 80) : undefined,
      vector,
    })
    socket.emit('speakers:labeled', info ?? { clusterKey: data.clusterKey })
  })

  /** Assemble the enrollment sample for an unknown speaker (spec §6/§7). */
  socket.on('speakers:identify', (data: { clusterKey?: string }) => {
    const clusterKey = String(data?.clusterKey ?? '').slice(0, 24)
    if (!clusterKey) return
    try {
      const sample = tracker.enrollmentSample(clusterKey)
      if (!sample) {
        socket.emit('speakers:sample:error', {
          clusterKey,
          message:
            'Not enough usable speech collected yet for this speaker (need ~10 s; short replies do not count). Keep them talking a little more, then try again.',
        })
        return
      }
      const wav = pcmToWav(sample.wavPcm, sample.sampleRate)
      socket.emit('speakers:sample', {
        clusterKey,
        wavBase64: wav.toString('base64'),
        sampleRate: sample.sampleRate,
        durationSec: Number((sample.wavPcm.length / 2 / sample.sampleRate).toFixed(2)),
        speechSec: sample.speechSec,
      })
    } catch (err) {
      socket.emit('speakers:sample:error', {
        clusterKey,
        message: err instanceof Error ? err.message : 'Could not assemble the voice sample',
      })
    }
  })

  /** Drop stored enrollment audio for a cluster (privacy control). */
  socket.on('speakers:discard-sample', (data: { clusterKey?: string }) => {
    if (data?.clusterKey) tracker.clearSegments(String(data.clusterKey).slice(0, 24))
  })

  // ── v2: provider health channel (§30) ────────────────────────────────────

  socket.on('providers:health', () => {
    providerHealthSnapshot()
      .then((providers) =>
        socket.emit('providers:health', {
          providers,
          tts: ttsWorkerState(),
          updatedAt: new Date().toISOString(),
        })
      )
      .catch(() =>
        socket.emit('providers:health', {
          providers: [],
          tts: ttsWorkerState(),
          updatedAt: new Date().toISOString(),
          error: 'health snapshot unavailable',
        })
      )
  })

  socket.on('providers:reload', () => {
    invalidateProviderCache()
    socket.emit('providers:reload-ok')
  })

  // Round-10 language-switch prewarm: when the user picks a new OUTPUT
  // language we spawn the matching resident piper worker IMMEDIATELY so the
  // first phrase in that language doesn't pay the 1–2 s cold start. Idempotent
  // (warmWorkers map) — re-requesting an already-warm voice is a cheap no-op.
  // Only fa/en have piper voices; other languages fall back honestly.
  socket.on('voice:prewarm', (data: { lang?: string }, ack?: (r: { ok: boolean; lang?: string; tts?: ReturnType<typeof ttsWorkerState>; error?: string }) => void) => {
    const lang = data?.lang === 'fa' || data?.lang === 'en' ? data.lang : undefined
    if (!lang) {
      ack?.({ ok: false, error: 'no piper voice for this language' })
      return
    }
    prewarmTTS([lang])
      .then(() => ack?.({ ok: true, lang, tts: ttsWorkerState() }))
      .catch((err: unknown) =>
        ack?.({ ok: false, lang, error: err instanceof Error ? err.message : String(err) })
      )
  })

  // Manual/auto test verdicts from the Setup card — recorded into the SAME
  // health map the router uses, so a failing provider stops showing READY
  // in the chain preview before it costs a real phrase.
  socket.on(
    'providers:report-test',
    (
      payload: { providerId?: string; ok?: boolean; ms?: number; message?: string },
      ack?: (r: { ok: boolean }) => void
    ) => {
      if (!payload || typeof payload.providerId !== 'string' || !payload.providerId) {
        ack?.({ ok: false })
        return
      }
      try {
        recordTestResult(
          payload.providerId,
          payload.ok === true,
          Number(payload.ms) || 0,
          typeof payload.message === 'string' ? payload.message : undefined
        )
        ack?.({ ok: true })
      } catch {
        ack?.({ ok: false })
      }
    }
  )

  // ── v3 §25: live routing-policy switch (Settings → Routing policy card).
  // The policy is service-wide (it shapes every provider chain); the change is
  // acknowledged with the effective policy so the UI can verify the round trip.
  socket.on('providers:policy', (data: { policy?: string }) => {
    const requested = String(data?.policy ?? '')
    const effective = setRoutingPolicy(requested)
    socket.emit('providers:policy-ok', { policy: effective, accepted: effective === requested })
  })

  // Live captions: mid-speech ASR snapshots, OUTSIDE the FIFO (never queues,
  // one in flight per socket — extras are dropped, client re-sends later).
  let partialBusy = false
  socket.on(
    'asr:partial',
    (data: { utteranceId?: string; audioBase64?: string; sampleRate?: number; sourceLang?: string }) => {
      if (partialBusy) return
      if (!data?.utteranceId || !data?.audioBase64) return
      partialBusy = true
      processAsrPartial({
        utteranceId: data.utteranceId,
        sessionId: socket.id,
        audioBase64: data.audioBase64,
        sampleRate: data.sampleRate || DEFAULTS.sampleRate,
        sourceLang: data.sourceLang || DEFAULTS.sourceLang,
      })
        .then((res) => socket.emit('asr:partial:result', res))
        .catch(() => socket.emit('asr:partial:result', { utteranceId: data.utteranceId ?? '?', text: '', final: false }))
        .finally(() => {
          partialBusy = false
        })
    }
  )

  // Typed-text translation (skips ASR; shares translate + TTS + result path)
  socket.on(
    'translate:text',
    (data: Partial<TextTranslateRequest> & { utteranceId: string; text?: string }) => {
      const text = (data?.text ?? '').trim().slice(0, 1000)
      if (!data?.utteranceId || !text) {
        socket.emit('utterance:error', {
          utteranceId: data?.utteranceId ?? '?',
          stage: 'translate',
          message: 'malformed text payload',
        })
        return
      }
      const req: TextTranslateRequest = {
        utteranceId: data.utteranceId,
        sessionId: socket.id,
        text,
        sourceLang: data.sourceLang || DEFAULTS.sourceLang,
        targetLang: data.targetLang || DEFAULTS.targetLang,
        style: data.style || DEFAULTS.style,
        voice: data.voice || DEFAULTS.voice,
        speed: typeof data.speed === 'number' ? data.speed : DEFAULTS.speed,
        pitchRatio: typeof data.pitchRatio === 'number' ? data.pitchRatio : undefined,
        profileMode: data.profileMode === 'clone' || data.profileMode === 'voice-match' ? data.profileMode : undefined,
        providerProfileId: typeof data.providerProfileId === 'string' ? data.providerProfileId : undefined,
        providerModel: typeof data.providerModel === 'string' ? data.providerModel : undefined,
        stability: typeof data.stability === 'number' ? data.stability : undefined,
        providerSimilarity: typeof data.providerSimilarity === 'number' ? data.providerSimilarity : undefined,
        providerStyle: typeof data.providerStyle === 'number' ? data.providerStyle : undefined,
        speakerRole: speakerRole(data.speakerRole),
        autoPair: typeof data.autoPair === 'string' ? data.autoPair.slice(0, 20) : undefined,
      }
      if (queue.length >= MAX_QUEUE) {
        socket.emit('utterance:error', {
          utteranceId: req.utteranceId,
          stage: 'queue',
          message: 'queue full — try again in a moment',
        })
        return
      }
      queue.push({ kind: 'text', req })
      drain()
    }
  )

  socket.on('disconnect', () => {
    clearSession(socket.id)
    queue.length = 0
    console.log(`[translator] client disconnected: ${socket.id}`)
  })

  socket.on('error', (error) => {
    console.error(`[translator] socket error (${socket.id}):`, error)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v3.6.0 — Loopback REST preview endpoint ("Test my voice").
// The socket.io server owns path '/' (engine.io intercepts EVERY request on
// that server), so REST gets its OWN loopback-only listener. The Next.js
// /api/voice-preview route calls it with the profile fields it already
// resolved + ownership-checked, and this side runs the FULL synthesis chain:
//   clone mode     → the local-first priority chain (Fish Speech → F5-TTS →
//                    Chatterbox → ElevenLabs IVC → pitch-conformed, labeled)
//   voice-match    → routed TTS (local piper → user endpoints → built-in z-ai)
// This is what makes "Test my voice" work on deployments WITHOUT a z-ai
// config: the local piper/pitch-conformed engines serve the preview.
// Security: bound to 127.0.0.1 only — never exposed through the gateway; the
// caller (app backend) is responsible for auth/ownership.
// ─────────────────────────────────────────────────────────────────────────────

const REST_PORT = Number(process.env.TRANSLATOR_REST_PORT || 3004)

/** Direction-aware preview sentence so the audition sounds like real usage. */
const PREVIEW_LINES: Record<string, string> = {
  en: "Hi! This is how your voice sounds in the translation. Pretty close, right?",
  fa: 'سلام! این هم صدای شما در ترجمهٔ زنده است. حالا می‌توانید صحبت کنید و انگلیسی را با همین صدا بشنوید.',
  de: 'Hallo! So klingt deine Stimme in der Übersetzung. Ganz nah dran, oder?',
  fr: "Salut ! Voilà comment ta voix sonne dans la traduction. Plutôt proche, non ?",
  es: '¡Hola! Así suena tu voz en la traducción. Bastante parecida, ¿verdad?',
  ar: 'مرحباً! هكذا تبدو صوتك في الترجمة. قريب جداً، أليس كذلك؟',
  tr: 'Merhaba! Çeviride sesin böyle görünüyor. Oldukça yakın, değil mi?',
  it: "Ciao! Questo è come suona la tua voce nella traduzione. Molto simile, vero?",
}

/** The full identity engine for previews (same chain as realtime synthesis). */
const previewVoiceEngine = new VoiceIdentityEngine()

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 2_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>)
      } catch (e) {
        reject(e instanceof Error ? e : new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function handlePreviewVoice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Content-Type', 'application/json')
  try {
    const body = await readJsonBody(req)
    const lang = typeof body.lang === 'string' && PREVIEW_LINES[body.lang] ? body.lang : 'en'
    const rawCustom = typeof body.text === 'string' ? body.text : ''
    const custom = rawCustom.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    const text = custom || PREVIEW_LINES[lang]

    const num = (v: unknown, lo: number, hi: number, fb: number) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb
    }
    const out = await previewVoiceEngine.synthesize(text, {
      voice: typeof body.voice === 'string' ? body.voice.slice(0, 40) : 'kazi',
      speed: num(body.speed, 0.5, 2, 1),
      pitchRatio: body.pitchRatio === undefined ? undefined : num(body.pitchRatio, 0.75, 1.33, 1),
      profileMode: body.profileMode === 'clone' || body.profileMode === 'voice-match' ? body.profileMode : undefined,
      providerProfileId: typeof body.providerProfileId === 'string' ? body.providerProfileId.slice(0, 80) : undefined,
      profileId: typeof body.profileId === 'string' ? body.profileId.slice(0, 80) : undefined,
      providerModel: typeof body.providerModel === 'string' ? body.providerModel.slice(0, 40) : undefined,
      stability: num(body.stability, 0, 1, 0.5),
      providerSimilarity: num(body.providerSimilarity, 0, 1, 0.8),
      providerStyle: num(body.providerStyle, 0, 0.45, 0),
      lang,
    })
    res.statusCode = 200
    res.end(
      JSON.stringify({
        ok: true,
        audioBase64: out.buffer.toString('base64'),
        providerId: out.providerId,
        degraded: out.degraded === true,
        voiceMode: body.profileMode ?? 'default',
        cloneAttempts: out.cloneAttempts ?? undefined,
        lang,
      })
    )
  } catch (err) {
    const attempts = (err as { cloneAttempts?: unknown }).cloneAttempts
    res.statusCode = 502
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : 'Voice preview synthesis failed',
        cloneAttempts: attempts ?? undefined,
      })
    )
  }
}

const restServer = createServer((req, res) => {
  if (req.method === 'POST' && (req.url ?? '').startsWith('/preview-voice')) {
    handlePreviewVoice(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: 'internal preview error' }))
      }
    })
    return
  }
  // Honest health probe for the app-side diagnostics.
  if (req.method === 'GET' && (req.url ?? '').startsWith('/healthz')) {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 200
    res.end(JSON.stringify({ ok: true, service: 'translator-rest', tts: ttsWorkerState() }))
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`[translator] realtime translation service running on port ${PORT}`)
  // Best-effort: prewarm BOTH resident piper voices (English + Persian) so the
  // first phrase in either direction after a deploy/restart is already fast.
  // Measured cost ≈180MB RSS per worker — fits the container RAM budget.
  void prewarmTTS(['en', 'fa']).catch(() => undefined)
})

// Loopback-only REST listener — the app's /api/voice-preview route is the only
// intended client (auth + profile ownership stay in the Next.js backend).
restServer.listen(REST_PORT, '127.0.0.1', () => {
  console.log(`[translator] loopback REST preview endpoint on 127.0.0.1:${REST_PORT}`)
})

process.on('SIGTERM', () => {
  restServer.close()
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  restServer.close()
  httpServer.close(() => process.exit(0))
})
