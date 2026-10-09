import { createServer } from 'http'
import { Server } from 'socket.io'
import type { StageEvent as PipelineStageEvent, TextTranslateRequest, TranslationEvent as PipelineTranslationEvent, UtteranceError as PipelineError, UtteranceRequest, UtteranceResult as PipelineResult } from './types'
import { DEFAULTS } from './types'
import { processAsrPartial, processTextTranslate, processUtterance, clearSession, type PipelineHandlers } from './pipeline'

// ─────────────────────────────────────────────────────────────────────────────
// Realtime transport — socket.io gateway for the live translator pipeline.
// NOTE: path MUST stay '/' (Caddy gateway forwards ?XTransformPort=3003 here).
// ─────────────────────────────────────────────────────────────────────────────

const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 8e6, // utterance PCM can be a few MB
})

/** Max queued utterances per socket (protects memory, keeps playback order). */
const MAX_QUEUE = 4

io.on('connection', (socket) => {
  console.log(`[translator] client connected: ${socket.id}`)

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
      item.kind === 'audio' ? processUtterance(item.req, handlers) : processTextTranslate(item.req, handlers)
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
