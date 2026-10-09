import { createServer } from 'http'
import { Server } from 'socket.io'
import type { StageEvent as PipelineStageEvent, TextTranslateRequest, TranslationEvent as PipelineTranslationEvent, UtteranceError as PipelineError, UtteranceRequest, UtteranceResult as PipelineResult } from './types'
import { DEFAULTS } from './types'
import { processAsrPartial, processTextTranslate, processUtterance, clearSession, type PipelineHandlers, type PipelineEvent } from './pipeline'
import { SpeakerTracker, type TrackedContact } from './engines/speaker-tracker'
import { invalidateProviderCache, providerHealthSnapshot, setRouterEventSink, setRoutingPolicy, getRoutingPolicy, ROUTING_POLICIES } from './providers/router'
import { pcmToWav } from './engines/audio-utils'
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
      .then((providers) => socket.emit('providers:health', { providers, updatedAt: new Date().toISOString() }))
      .catch(() =>
        socket.emit('providers:health', {
          providers: [],
          updatedAt: new Date().toISOString(),
          error: 'health snapshot unavailable',
        })
      )
  })

  socket.on('providers:reload', () => {
    invalidateProviderCache()
    socket.emit('providers:reload-ok')
  })

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

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`[translator] realtime translation service running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
