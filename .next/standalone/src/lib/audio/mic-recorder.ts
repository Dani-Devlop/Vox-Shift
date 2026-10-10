// ─────────────────────────────────────────────────────────────────────────────
// MicRecorder — captures microphone audio, runs client-side VAD segmentation
// and emits complete speech utterances as base64 PCM (Int16 LE, 16 kHz mono).
//
// Why client-side VAD? The ASR engine consumes complete utterances, and cutting
// on natural pauses keeps latency low without uploading continuous noise.
// The recorder never buffers the whole conversation — only the active utterance
// plus a short pre-roll so speech onsets are not clipped.
// ─────────────────────────────────────────────────────────────────────────────

import { CAPTURE_PROCESSOR_NAME, CAPTURE_PROCESSOR_SOURCE } from './capture-processor'

export interface MicRecorderOptions {
  /** Called when a complete utterance is segmented. */
  onUtterance: (pcmBase64: string, durationSec: number) => void
  /**
   * Mid-speech snapshot (base64 PCM of everything captured so far) for live
   * captions — fired roughly every `partialIntervalMs` while speech continues.
   */
  onPartial?: (pcmBase64: string) => void
  /** Realtime input level (0..1), throttled for UI meters. */
  onLevel?: (level: number) => void
  /** Fires when the VAD state flips (user started/stopped talking). */
  onSpeakingChange?: (speaking: boolean) => void
  /** Optional live caption tick while speech continues (elapsed ms). */
  onSpeechTick?: (elapsedMs: number) => void
  onError?: (error: Error) => void
  targetSampleRate?: number // default 16000
  silenceMs?: number // pause length that ends an utterance (default 850)
  speechStartMs?: number // speech length that starts an utterance (default 120)
  preRollMs?: number // audio kept before speech onset (default 320)
  maxUtteranceSec?: number // force-flush long speech (default 20)
  minUtteranceSec?: number // drop very short blips (default 0.45)
  partialIntervalMs?: number // snapshot cadence for live captions (default 1200)
}

interface VADState {
  phase: 'idle' | 'speaking'
  speechRunMs: number
  silenceRunMs: number
}

function floatToInt16(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Linear-interpolation resampler (good enough for ASR). */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = input[idx] ?? 0
    const b = input[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

function pcmToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[])
  }
  return btoa(binary)
}

export class MicRecorder {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletUrl: string | null = null

  private opts: Required<Pick<MicRecorderOptions, 'targetSampleRate' | 'silenceMs' | 'speechStartMs' | 'preRollMs' | 'maxUtteranceSec' | 'minUtteranceSec' | 'partialIntervalMs'>>

  // Capture-rate buffers
  private preRoll: Float32Array[] = []
  private preRollSamples = 0
  private utterance: Float32Array[] = []
  private utteranceSamples = 0

  private vad: VADState = { phase: 'idle', speechRunMs: 0, silenceRunMs: 0 }
  private noiseFloor = 0.008
  private lastLevelEmit = 0
  private running = false
  /** Push-to-talk hold — when true, VAD is bypassed and capture is manual. */
  private pttHold = false
  /**
   * Playback echo-guard (spec §9): while synthesized output plays, the VAD is
   * frozen so the translated voice is never re-recognized as new user speech.
   */
  private ducked = false
  /** Speech samples already covered by an emitted partial snapshot. */
  private partialEmittedSamples = 0
  /** Speech onset timestamp (ms) for the live caption tick. */
  private speechStartedAt = 0
  private lastTickEmit = 0

  constructor(private handler: MicRecorderOptions) {
    this.opts = {
      targetSampleRate: handler.targetSampleRate ?? 16000,
      silenceMs: handler.silenceMs ?? 850,
      speechStartMs: handler.speechStartMs ?? 120,
      preRollMs: handler.preRollMs ?? 320,
      maxUtteranceSec: handler.maxUtteranceSec ?? 20,
      minUtteranceSec: handler.minUtteranceSec ?? 0.45,
      partialIntervalMs: handler.partialIntervalMs ?? 1200,
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  get isSpeaking(): boolean {
    return this.vad.phase === 'speaking'
  }

  /**
   * Push-to-talk press: opens an utterance immediately using the pre-roll
   * buffer (bypasses VAD onset detection; the hold decides when to stop).
   */
  startPushToTalk(): void {
    if (!this.running || this.pttHold || this.audioContext === null) return
    this.pttHold = true
    if (this.vad.phase === 'idle') {
      this.vad.phase = 'speaking'
      this.vad.speechRunMs = 0
      this.vad.silenceRunMs = 0
      this.utterance = this.preRoll.map((c) => Float32Array.from(c))
      this.utteranceSamples = this.preRollSamples
      this.preRoll = []
      this.preRollSamples = 0
      this.handler.onSpeakingChange?.(true)
    }
  }

  /**
   * Push-to-talk release: flushes the captured audio immediately, even
   * mid-speech — the release itself is the utterance boundary.
   */
  stopPushToTalk(): void {
    if (!this.pttHold) return
    this.pttHold = false
    if (this.vad.phase === 'speaking') this.flushUtterance()
  }

  /**
   * Playback echo-guard control. While `ducked` is true the VAD ignores all
   * input (level metering continues for the UI). Engaging it mid-utterance
   * flushes the utterance so it can't absorb playback audio; disengaging
   * clears the pre-roll so the playback tail can't seed the next utterance.
   */
  setPlaybackDucked(ducked: boolean): void {
    if (ducked === this.ducked) return
    this.ducked = ducked
    if (ducked) {
      if (this.vad.phase === 'speaking' && !this.pttHold) this.flushUtterance()
    } else {
      this.preRoll = []
      this.preRollSamples = 0
      this.vad = { phase: 'idle', speechRunMs: 0, silenceRunMs: 0 }
    }
  }

  async start(): Promise<void> {
    if (this.running) return

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    // Create context at the device rate; we resample to 16 kHz when emitting.
    this.audioContext = new AudioContext()
    if (this.audioContext.state === 'suspended') await this.audioContext.resume()

    const blob = new Blob([CAPTURE_PROCESSOR_SOURCE], { type: 'application/javascript' })
    this.workletUrl = URL.createObjectURL(blob)
    await this.audioContext.audioWorklet.addModule(this.workletUrl)

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
    this.workletNode = new AudioWorkletNode(this.audioContext, CAPTURE_PROCESSOR_NAME)
    this.workletNode.port.onmessage = (event) => this.handleChunk(event.data as Float32Array)
    this.sourceNode.connect(this.workletNode)
    // Do NOT connect worklet to destination — no local echo of raw mic input.

    this.reset()
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    // Flush any in-flight speech so it isn't lost on Stop.
    if (this.vad.phase === 'speaking') this.flushUtterance()
    this.workletNode?.port.close()
    try { this.workletNode?.disconnect() } catch { /* noop */ }
    try { this.sourceNode?.disconnect() } catch { /* noop */ }
    if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close()
    this.stream?.getTracks().forEach((t) => t.stop())
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl)
    this.workletNode = null
    this.sourceNode = null
    this.audioContext = null
    this.stream = null
    this.workletUrl = null
  }

  private reset() {
    this.preRoll = []
    this.preRollSamples = 0
    this.utterance = []
    this.utteranceSamples = 0
    this.vad = { phase: 'idle', speechRunMs: 0, silenceRunMs: 0 }
    this.noiseFloor = 0.008
    this.pttHold = false
    this.partialEmittedSamples = 0
    this.speechStartedAt = 0
    this.lastTickEmit = 0
  }

  /**
   * Emit a live-caption snapshot of everything captured so far (fires roughly
   * every `partialIntervalMs` of continuous speech; caller decides transport).
   */
  private maybeEmitPartial() {
    if (!this.handler.onPartial || !this.audioContext) return
    const captureRate = this.audioContext.sampleRate
    const sinceLast = this.utteranceSamples - this.partialEmittedSamples
    if (sinceLast < (this.opts.partialIntervalMs / 1000) * captureRate) return
    this.partialEmittedSamples = this.utteranceSamples
    const merged = new Float32Array(this.utteranceSamples)
    let offset = 0
    for (const c of this.utterance) {
      merged.set(c, offset)
      offset += c.length
    }
    const resampled = resample(merged, captureRate, this.opts.targetSampleRate)
    this.handler.onPartial(pcmToBase64(floatToInt16(resampled)))
  }

  /** Fire the caption tick (elapsed speech time) at ~4 Hz. */
  private maybeEmitTick(now: number) {
    if (!this.handler.onSpeechTick || this.speechStartedAt === 0) return
    if (now - this.lastTickEmit < 250) return
    this.lastTickEmit = now
    this.handler.onSpeechTick(now - this.speechStartedAt)
  }

  private handleChunk(chunk: Float32Array) {
    if (!this.running || !this.audioContext) return
    const captureRate = this.audioContext.sampleRate
    const chunkMs = (chunk.length / captureRate) * 1000

    // ── Level metering (throttled ~12 Hz) ─────────────────────────────    
    let sumSquares = 0
    for (let i = 0; i < chunk.length; i++) sumSquares += chunk[i] * chunk[i]
    const level = Math.sqrt(sumSquares / chunk.length)

    const now = performance.now()
    if (this.handler.onLevel && now - this.lastLevelEmit > 80) {
      this.lastLevelEmit = now
      this.handler.onLevel(Math.min(1, level * 6))
    }

    // ── Playback echo-guard: freeze the VAD while output audio plays ────
    if (this.ducked && !this.pttHold) return

    // ── Adaptive noise floor (slow minimum tracking) ──────────────────────
    this.noiseFloor = Math.max(
      0.004,
      this.noiseFloor * 0.999 + level * 0.001 * (level < this.noiseFloor ? 1 : 0.08)
    )
    const threshold = Math.max(0.012, this.noiseFloor * 2.8)

    // ── Pre-roll ring buffer ──────────────────────────────────────────────
    this.preRoll.push(Float32Array.from(chunk))
    this.preRollSamples += chunk.length
    const preRollMax = Math.ceil((this.opts.preRollMs / 1000) * captureRate)
    while (this.preRollSamples > preRollMax && this.preRoll.length > 0) {
      const dropped = this.preRoll.shift()!
      this.preRollSamples -= dropped.length
    }

    // ── Push-to-talk hold: manual capture, VAD bypassed ────────────────────
    if (this.pttHold) {
      if (this.vad.phase === 'idle') {
        this.vad.phase = 'speaking'
        this.utterance = this.preRoll.map((c) => Float32Array.from(c))
        this.utteranceSamples = this.preRollSamples
        this.preRoll = []
        this.preRollSamples = 0
        this.partialEmittedSamples = 0
        this.speechStartedAt = now
        this.handler.onSpeakingChange?.(true)
      } else {
        this.utterance.push(Float32Array.from(chunk))
        this.utteranceSamples += chunk.length
        this.maybeEmitPartial()
        this.maybeEmitTick(now)
      }
      return
    }

    // ── VAD state machine ─────────────────────────────────────────────────
    if (level > threshold) {
      this.vad.speechRunMs += chunkMs
      this.vad.silenceRunMs = 0
    } else {
      this.vad.speechRunMs = 0
      if (this.vad.phase === 'speaking') this.vad.silenceRunMs += chunkMs
    }

    if (this.vad.phase === 'idle') {
      if (this.vad.speechRunMs >= this.opts.speechStartMs) {
        // Speech onset — open an utterance seeded with the pre-roll
        this.vad.phase = 'speaking'
        this.vad.silenceRunMs = 0
        this.utterance = this.preRoll.map((c) => Float32Array.from(c))
        this.utteranceSamples = this.preRollSamples
        this.preRoll = []
        this.preRollSamples = 0
        this.partialEmittedSamples = 0
        this.speechStartedAt = now
        this.lastTickEmit = now
        this.handler.onSpeakingChange?.(true)
      }
    } else {
      // speaking
      this.utterance.push(Float32Array.from(chunk))
      this.utteranceSamples += chunk.length

      this.maybeEmitPartial()
      this.maybeEmitTick(now)

      const utteranceSec = this.utteranceSamples / captureRate
      const silenceEnded = this.vad.silenceRunMs >= this.opts.silenceMs
      const maxEnded = utteranceSec >= this.opts.maxUtteranceSec

      if (silenceEnded || maxEnded) {
        this.flushUtterance()
      }
    }
  }

  private flushUtterance() {
    this.vad.phase = 'idle'
    this.vad.silenceRunMs = 0
    this.partialEmittedSamples = 0
    this.speechStartedAt = 0
    this.handler.onSpeakingChange?.(false)

    if (!this.audioContext) return
    const captureRate = this.audioContext.sampleRate
    const durationSec = this.utteranceSamples / captureRate

    if (durationSec >= this.opts.minUtteranceSec) {
      // Concatenate → resample to 16 kHz → Int16 PCM → base64
      const merged = new Float32Array(this.utteranceSamples)
      let offset = 0
      for (const c of this.utterance) {
        merged.set(c, offset)
        offset += c.length
      }
      const resampled = resample(merged, captureRate, this.opts.targetSampleRate)
      const int16 = floatToInt16(resampled)
      const base64 = pcmToBase64(int16)
      this.handler.onUtterance(base64, this.opts.targetSampleRate ? resampled.length / this.opts.targetSampleRate : durationSec)
    }

    this.utterance = []
    this.utteranceSamples = 0
  }
}

export { pcmToBase64, pcmFromBase64 }
function pcmFromBase64(base64: string): Int16Array {
  const binary = atob(base64)
  const len = Math.floor(binary.length / 2)
  const out = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8)
  }
  return out
}
