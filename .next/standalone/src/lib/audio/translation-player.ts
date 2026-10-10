// ─────────────────────────────────────────────────────────────────────────────
// TranslationAudioPlayer — sequential playback queue for synthesized WAV
// utterances. Guarantees results are heard in the order they were spoken.
// ─────────────────────────────────────────────────────────────────────────────

export class TranslationAudioPlayer {
  private ctx: AudioContext | null = null
  private queue: string[] = []
  private playing = false
  private stopped = false
  private currentSource: AudioBufferSourceNode | null = null
  /** User-controlled playback speed (0.5–2). Applies live and to queued clips. */
  private rate = 1

  constructor(private callbacks: { onPlaybackStart?: () => void; onPlaybackEnd?: () => void } = {}) {}

  /** Must be triggered from a user gesture (Start button) to satisfy autoplay policies. */
  async init(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  enqueue(wavBase64: string) {
    if (this.stopped) return
    this.queue.push(wavBase64)
    if (!this.playing) void this.playNext()
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /**
   * Set playback speed (0.5–2). Takes effect immediately on the clip that is
   * currently playing and on everything queued afterwards.
   */
  setRate(rate: number) {
    const safe = Math.min(2, Math.max(0.5, Number(rate) || 1))
    this.rate = safe
    try {
      if (this.currentSource) this.currentSource.playbackRate.value = safe
    } catch {
      // source already stopped — next clip picks up the new rate
    }
  }

  clear() {
    this.queue = []
    this.stopped = true
    try {
      this.currentSource?.stop()
    } catch { /* noop */ }
    this.currentSource = null
    this.playing = false
    // Allow future playback after a clear (new session)
    setTimeout(() => { this.stopped = false }, 0)
  }

  async dispose() {
    this.clear()
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close()
    this.ctx = null
  }

  private async playNext(): Promise<void> {
    if (!this.ctx) return
    const next = this.queue.shift()
    if (next === undefined) {
      this.playing = false
      this.callbacks.onPlaybackEnd?.()
      return
    }

    this.playing = true
    try {
      const binary = atob(next)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const audioBuffer = await this.ctx.decodeAudioData(bytes.buffer)

      await new Promise<void>((resolve) => {
        if (!this.ctx) return resolve()
        const source = this.ctx.createBufferSource()
        source.buffer = audioBuffer
        source.playbackRate.value = this.rate
        source.connect(this.ctx.destination)
        this.currentSource = source
        this.callbacks.onPlaybackStart?.()
        source.onended = () => {
          if (this.currentSource === source) this.currentSource = null
          resolve()
        }
        source.start()
      })
    } catch (err) {
      console.error('[audio-player] playback failed:', err)
    }

    void this.playNext()
  }
}
