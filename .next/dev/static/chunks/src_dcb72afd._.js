(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/lib/audio/capture-processor.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// AudioWorklet processor source — captures raw mic PCM in fixed-size chunks
// and posts them to the main thread for VAD segmentation + resampling.
// Loaded at runtime via Blob URL (keeps everything in one TS module).
// ─────────────────────────────────────────────────────────────────────────────
__turbopack_context__.s([
    "CAPTURE_PROCESSOR_NAME",
    ()=>CAPTURE_PROCESSOR_NAME,
    "CAPTURE_PROCESSOR_SOURCE",
    ()=>CAPTURE_PROCESSOR_SOURCE
]);
const CAPTURE_PROCESSOR_NAME = 'live-capture-processor';
const CAPTURE_PROCESSOR_SOURCE = /* js */ `
class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._chunks = []
    this._buffered = 0
    this._chunkSize = 2048 // ~42ms @48kHz
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input[0] && input[0].length > 0) {
      // Downmix to mono (first channel) — mic is mono anyway
      const channel = input[0]
      this._chunks.push(new Float32Array(channel))
      this._buffered += channel.length

      if (this._buffered >= this._chunkSize) {
        const merged = new Float32Array(this._buffered)
        let offset = 0
        for (const c of this._chunks) {
          merged.set(c, offset)
          offset += c.length
        }
        this.port.postMessage(merged, [merged.buffer])
        this._chunks = []
        this._buffered = 0
      }
    }
    return true
  }
}
registerProcessor('${CAPTURE_PROCESSOR_NAME}', LiveCaptureProcessor)
`;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/audio/mic-recorder.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "MicRecorder",
    ()=>MicRecorder,
    "pcmFromBase64",
    ()=>pcmFromBase64,
    "pcmToBase64",
    ()=>pcmToBase64
]);
// ─────────────────────────────────────────────────────────────────────────────
// MicRecorder — captures microphone audio, runs client-side VAD segmentation
// and emits complete speech utterances as base64 PCM (Int16 LE, 16 kHz mono).
//
// Why client-side VAD? The ASR engine consumes complete utterances, and cutting
// on natural pauses keeps latency low without uploading continuous noise.
// The recorder never buffers the whole conversation — only the active utterance
// plus a short pre-roll so speech onsets are not clipped.
// ─────────────────────────────────────────────────────────────────────────────
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$capture$2d$processor$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/audio/capture-processor.ts [app-client] (ecmascript)");
;
function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for(let i = 0; i < float32.length; i++){
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}
/** Linear-interpolation resampler (good enough for ASR). */ function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outLength = Math.floor(input.length / ratio);
    const out = new Float32Array(outLength);
    for(let i = 0; i < outLength; i++){
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = input[idx] ?? 0;
        const b = input[idx + 1] ?? a;
        out[i] = a + (b - a) * frac;
    }
    return out;
}
function pcmToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = '';
    const CHUNK = 0x8000;
    for(let i = 0; i < bytes.length; i += CHUNK){
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}
class MicRecorder {
    handler;
    stream;
    audioContext;
    workletNode;
    sourceNode;
    workletUrl;
    opts;
    // Capture-rate buffers
    preRoll;
    preRollSamples;
    utterance;
    utteranceSamples;
    vad;
    noiseFloor;
    lastLevelEmit;
    running;
    /** Push-to-talk hold — when true, VAD is bypassed and capture is manual. */ pttHold;
    /**
   * Playback echo-guard (spec §9): while synthesized output plays, the VAD is
   * frozen so the translated voice is never re-recognized as new user speech.
   */ ducked;
    /** Speech samples already covered by an emitted partial snapshot. */ partialEmittedSamples;
    /** Speech onset timestamp (ms) for the live caption tick. */ speechStartedAt;
    lastTickEmit;
    constructor(handler){
        this.handler = handler;
        this.stream = null;
        this.audioContext = null;
        this.workletNode = null;
        this.sourceNode = null;
        this.workletUrl = null;
        this.preRoll = [];
        this.preRollSamples = 0;
        this.utterance = [];
        this.utteranceSamples = 0;
        this.vad = {
            phase: 'idle',
            speechRunMs: 0,
            silenceRunMs: 0
        };
        this.noiseFloor = 0.008;
        this.lastLevelEmit = 0;
        this.running = false;
        this.pttHold = false;
        this.ducked = false;
        this.partialEmittedSamples = 0;
        this.speechStartedAt = 0;
        this.lastTickEmit = 0;
        this.opts = {
            targetSampleRate: handler.targetSampleRate ?? 16000,
            silenceMs: handler.silenceMs ?? 850,
            speechStartMs: handler.speechStartMs ?? 120,
            preRollMs: handler.preRollMs ?? 320,
            maxUtteranceSec: handler.maxUtteranceSec ?? 20,
            minUtteranceSec: handler.minUtteranceSec ?? 0.45,
            partialIntervalMs: handler.partialIntervalMs ?? 1200
        };
    }
    get isRunning() {
        return this.running;
    }
    get isSpeaking() {
        return this.vad.phase === 'speaking';
    }
    /**
   * Push-to-talk press: opens an utterance immediately using the pre-roll
   * buffer (bypasses VAD onset detection; the hold decides when to stop).
   */ startPushToTalk() {
        if (!this.running || this.pttHold || this.audioContext === null) return;
        this.pttHold = true;
        if (this.vad.phase === 'idle') {
            this.vad.phase = 'speaking';
            this.vad.speechRunMs = 0;
            this.vad.silenceRunMs = 0;
            this.utterance = this.preRoll.map((c)=>Float32Array.from(c));
            this.utteranceSamples = this.preRollSamples;
            this.preRoll = [];
            this.preRollSamples = 0;
            this.handler.onSpeakingChange?.(true);
        }
    }
    /**
   * Push-to-talk release: flushes the captured audio immediately, even
   * mid-speech — the release itself is the utterance boundary.
   */ stopPushToTalk() {
        if (!this.pttHold) return;
        this.pttHold = false;
        if (this.vad.phase === 'speaking') this.flushUtterance();
    }
    /**
   * Playback echo-guard control. While `ducked` is true the VAD ignores all
   * input (level metering continues for the UI). Engaging it mid-utterance
   * flushes the utterance so it can't absorb playback audio; disengaging
   * clears the pre-roll so the playback tail can't seed the next utterance.
   */ setPlaybackDucked(ducked) {
        if (ducked === this.ducked) return;
        this.ducked = ducked;
        if (ducked) {
            if (this.vad.phase === 'speaking' && !this.pttHold) this.flushUtterance();
        } else {
            this.preRoll = [];
            this.preRollSamples = 0;
            this.vad = {
                phase: 'idle',
                speechRunMs: 0,
                silenceRunMs: 0
            };
        }
    }
    async start() {
        if (this.running) return;
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        // Create context at the device rate; we resample to 16 kHz when emitting.
        this.audioContext = new AudioContext();
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();
        const blob = new Blob([
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$capture$2d$processor$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["CAPTURE_PROCESSOR_SOURCE"]
        ], {
            type: 'application/javascript'
        });
        this.workletUrl = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(this.workletUrl);
        this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
        this.workletNode = new AudioWorkletNode(this.audioContext, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$capture$2d$processor$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["CAPTURE_PROCESSOR_NAME"]);
        this.workletNode.port.onmessage = (event)=>this.handleChunk(event.data);
        this.sourceNode.connect(this.workletNode);
        // Do NOT connect worklet to destination — no local echo of raw mic input.
        this.reset();
        this.running = true;
    }
    async stop() {
        this.running = false;
        // Flush any in-flight speech so it isn't lost on Stop.
        if (this.vad.phase === 'speaking') this.flushUtterance();
        this.workletNode?.port.close();
        try {
            this.workletNode?.disconnect();
        } catch  {}
        try {
            this.sourceNode?.disconnect();
        } catch  {}
        if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close();
        this.stream?.getTracks().forEach((t)=>t.stop());
        if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
        this.workletNode = null;
        this.sourceNode = null;
        this.audioContext = null;
        this.stream = null;
        this.workletUrl = null;
    }
    reset() {
        this.preRoll = [];
        this.preRollSamples = 0;
        this.utterance = [];
        this.utteranceSamples = 0;
        this.vad = {
            phase: 'idle',
            speechRunMs: 0,
            silenceRunMs: 0
        };
        this.noiseFloor = 0.008;
        this.pttHold = false;
        this.partialEmittedSamples = 0;
        this.speechStartedAt = 0;
        this.lastTickEmit = 0;
    }
    /**
   * Emit a live-caption snapshot of everything captured so far (fires roughly
   * every `partialIntervalMs` of continuous speech; caller decides transport).
   */ maybeEmitPartial() {
        if (!this.handler.onPartial || !this.audioContext) return;
        const captureRate = this.audioContext.sampleRate;
        const sinceLast = this.utteranceSamples - this.partialEmittedSamples;
        if (sinceLast < this.opts.partialIntervalMs / 1000 * captureRate) return;
        this.partialEmittedSamples = this.utteranceSamples;
        const merged = new Float32Array(this.utteranceSamples);
        let offset = 0;
        for (const c of this.utterance){
            merged.set(c, offset);
            offset += c.length;
        }
        const resampled = resample(merged, captureRate, this.opts.targetSampleRate);
        this.handler.onPartial(pcmToBase64(floatToInt16(resampled)));
    }
    /** Fire the caption tick (elapsed speech time) at ~4 Hz. */ maybeEmitTick(now) {
        if (!this.handler.onSpeechTick || this.speechStartedAt === 0) return;
        if (now - this.lastTickEmit < 250) return;
        this.lastTickEmit = now;
        this.handler.onSpeechTick(now - this.speechStartedAt);
    }
    handleChunk(chunk) {
        if (!this.running || !this.audioContext) return;
        const captureRate = this.audioContext.sampleRate;
        const chunkMs = chunk.length / captureRate * 1000;
        // ── Level metering (throttled ~12 Hz) ─────────────────────────────    
        let sumSquares = 0;
        for(let i = 0; i < chunk.length; i++)sumSquares += chunk[i] * chunk[i];
        const level = Math.sqrt(sumSquares / chunk.length);
        const now = performance.now();
        if (this.handler.onLevel && now - this.lastLevelEmit > 80) {
            this.lastLevelEmit = now;
            this.handler.onLevel(Math.min(1, level * 6));
        }
        // ── Playback echo-guard: freeze the VAD while output audio plays ────
        if (this.ducked && !this.pttHold) return;
        // ── Adaptive noise floor (slow minimum tracking) ──────────────────────
        this.noiseFloor = Math.max(0.004, this.noiseFloor * 0.999 + level * 0.001 * (level < this.noiseFloor ? 1 : 0.08));
        const threshold = Math.max(0.012, this.noiseFloor * 2.8);
        // ── Pre-roll ring buffer ──────────────────────────────────────────────
        this.preRoll.push(Float32Array.from(chunk));
        this.preRollSamples += chunk.length;
        const preRollMax = Math.ceil(this.opts.preRollMs / 1000 * captureRate);
        while(this.preRollSamples > preRollMax && this.preRoll.length > 0){
            const dropped = this.preRoll.shift();
            this.preRollSamples -= dropped.length;
        }
        // ── Push-to-talk hold: manual capture, VAD bypassed ────────────────────
        if (this.pttHold) {
            if (this.vad.phase === 'idle') {
                this.vad.phase = 'speaking';
                this.utterance = this.preRoll.map((c)=>Float32Array.from(c));
                this.utteranceSamples = this.preRollSamples;
                this.preRoll = [];
                this.preRollSamples = 0;
                this.partialEmittedSamples = 0;
                this.speechStartedAt = now;
                this.handler.onSpeakingChange?.(true);
            } else {
                this.utterance.push(Float32Array.from(chunk));
                this.utteranceSamples += chunk.length;
                this.maybeEmitPartial();
                this.maybeEmitTick(now);
            }
            return;
        }
        // ── VAD state machine ─────────────────────────────────────────────────
        if (level > threshold) {
            this.vad.speechRunMs += chunkMs;
            this.vad.silenceRunMs = 0;
        } else {
            this.vad.speechRunMs = 0;
            if (this.vad.phase === 'speaking') this.vad.silenceRunMs += chunkMs;
        }
        if (this.vad.phase === 'idle') {
            if (this.vad.speechRunMs >= this.opts.speechStartMs) {
                // Speech onset — open an utterance seeded with the pre-roll
                this.vad.phase = 'speaking';
                this.vad.silenceRunMs = 0;
                this.utterance = this.preRoll.map((c)=>Float32Array.from(c));
                this.utteranceSamples = this.preRollSamples;
                this.preRoll = [];
                this.preRollSamples = 0;
                this.partialEmittedSamples = 0;
                this.speechStartedAt = now;
                this.lastTickEmit = now;
                this.handler.onSpeakingChange?.(true);
            }
        } else {
            // speaking
            this.utterance.push(Float32Array.from(chunk));
            this.utteranceSamples += chunk.length;
            this.maybeEmitPartial();
            this.maybeEmitTick(now);
            const utteranceSec = this.utteranceSamples / captureRate;
            const silenceEnded = this.vad.silenceRunMs >= this.opts.silenceMs;
            const maxEnded = utteranceSec >= this.opts.maxUtteranceSec;
            if (silenceEnded || maxEnded) {
                this.flushUtterance();
            }
        }
    }
    flushUtterance() {
        this.vad.phase = 'idle';
        this.vad.silenceRunMs = 0;
        this.partialEmittedSamples = 0;
        this.speechStartedAt = 0;
        this.handler.onSpeakingChange?.(false);
        if (!this.audioContext) return;
        const captureRate = this.audioContext.sampleRate;
        const durationSec = this.utteranceSamples / captureRate;
        if (durationSec >= this.opts.minUtteranceSec) {
            // Concatenate → resample to 16 kHz → Int16 PCM → base64
            const merged = new Float32Array(this.utteranceSamples);
            let offset = 0;
            for (const c of this.utterance){
                merged.set(c, offset);
                offset += c.length;
            }
            const resampled = resample(merged, captureRate, this.opts.targetSampleRate);
            const int16 = floatToInt16(resampled);
            const base64 = pcmToBase64(int16);
            this.handler.onUtterance(base64, this.opts.targetSampleRate ? resampled.length / this.opts.targetSampleRate : durationSec);
        }
        this.utterance = [];
        this.utteranceSamples = 0;
    }
}
;
function pcmFromBase64(base64) {
    const binary = atob(base64);
    const len = Math.floor(binary.length / 2);
    const out = new Int16Array(len);
    for(let i = 0; i < len; i++){
        out[i] = binary.charCodeAt(i * 2) | binary.charCodeAt(i * 2 + 1) << 8;
    }
    return out;
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/audio/translation-player.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TranslationAudioPlayer — sequential playback queue for synthesized WAV
// utterances. Guarantees results are heard in the order they were spoken.
// ─────────────────────────────────────────────────────────────────────────────
__turbopack_context__.s([
    "TranslationAudioPlayer",
    ()=>TranslationAudioPlayer
]);
class TranslationAudioPlayer {
    callbacks;
    ctx;
    queue;
    playing;
    stopped;
    currentSource;
    /** User-controlled playback speed (0.5–2). Applies live and to queued clips. */ rate;
    constructor(callbacks = {}){
        this.callbacks = callbacks;
        this.ctx = null;
        this.queue = [];
        this.playing = false;
        this.stopped = false;
        this.currentSource = null;
        this.rate = 1;
    }
    /** Must be triggered from a user gesture (Start button) to satisfy autoplay policies. */ async init() {
        if (!this.ctx) {
            this.ctx = new AudioContext();
        }
        if (this.ctx.state === 'suspended') await this.ctx.resume();
    }
    enqueue(wavBase64) {
        if (this.stopped) return;
        this.queue.push(wavBase64);
        if (!this.playing) void this.playNext();
    }
    get isPlaying() {
        return this.playing;
    }
    /**
   * Set playback speed (0.5–2). Takes effect immediately on the clip that is
   * currently playing and on everything queued afterwards.
   */ setRate(rate) {
        const safe = Math.min(2, Math.max(0.5, Number(rate) || 1));
        this.rate = safe;
        try {
            if (this.currentSource) this.currentSource.playbackRate.value = safe;
        } catch  {
        // source already stopped — next clip picks up the new rate
        }
    }
    clear() {
        this.queue = [];
        this.stopped = true;
        try {
            this.currentSource?.stop();
        } catch  {}
        this.currentSource = null;
        this.playing = false;
        // Allow future playback after a clear (new session)
        setTimeout(()=>{
            this.stopped = false;
        }, 0);
    }
    async dispose() {
        this.clear();
        if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
        this.ctx = null;
    }
    async playNext() {
        if (!this.ctx) return;
        const next = this.queue.shift();
        if (next === undefined) {
            this.playing = false;
            this.callbacks.onPlaybackEnd?.();
            return;
        }
        this.playing = true;
        try {
            const binary = atob(next);
            const bytes = new Uint8Array(binary.length);
            for(let i = 0; i < binary.length; i++)bytes[i] = binary.charCodeAt(i);
            const audioBuffer = await this.ctx.decodeAudioData(bytes.buffer);
            await new Promise((resolve)=>{
                if (!this.ctx) return resolve();
                const source = this.ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.playbackRate.value = this.rate;
                source.connect(this.ctx.destination);
                this.currentSource = source;
                this.callbacks.onPlaybackStart?.();
                source.onended = ()=>{
                    if (this.currentSource === source) this.currentSource = null;
                    resolve();
                };
                source.start();
            });
        } catch (err) {
            console.error('[audio-player] playback failed:', err);
        }
        void this.playNext();
    }
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/realtime/socket.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "disconnectTranslatorSocket",
    ()=>disconnectTranslatorSocket,
    "getTranslatorSocket",
    ()=>getTranslatorSocket
]);
// ─────────────────────────────────────────────────────────────────────────────
// Realtime socket client — singleton connection to the translation mini
// service through the gateway. NEVER hardcode a port in the URL path:
// the gateway routes via the XTransformPort query parameter.
// ─────────────────────────────────────────────────────────────────────────────
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$2f$build$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/socket.io-client/build/esm/index.js [app-client] (ecmascript) <locals>");
;
let socketInstance = null;
function getTranslatorSocket() {
    if (!socketInstance) {
        socketInstance = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$2f$build$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["io"])('/?XTransformPort=3003', {
            transports: [
                'websocket',
                'polling'
            ],
            forceNew: false,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 800,
            reconnectionDelayMax: 4000,
            timeout: 10000
        });
    }
    return socketInstance;
}
function disconnectTranslatorSocket() {
    socketInstance?.disconnect();
    socketInstance = null;
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/types/translator.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// Shared types between the Next.js client and the realtime translator service.
__turbopack_context__.s([
    "LANG_META",
    ()=>LANG_META,
    "OTHER_LANGS",
    ()=>OTHER_LANGS,
    "getLangPair",
    ()=>getLangPair,
    "langPairFlags",
    ()=>langPairFlags
]);
const OTHER_LANGS = [
    'en',
    'de',
    'fr',
    'es',
    'ar',
    'tr',
    'it'
];
const LANG_META = {
    fa: {
        flag: '🇮🇷',
        name: 'Persian',
        rtl: true,
        sampleHint: 'سلام، حالت چطوره؟',
        tts: 'beta'
    },
    en: {
        flag: '🇬🇧',
        name: 'English',
        rtl: false,
        sampleHint: 'Hi, how are you doing today?',
        tts: 'native'
    },
    de: {
        flag: '🇩🇪',
        name: 'German',
        rtl: false,
        sampleHint: 'Guten Morgen, wie geht es dir?',
        tts: 'beta'
    },
    fr: {
        flag: '🇫🇷',
        name: 'French',
        rtl: false,
        sampleHint: "Bonjour, comment ça va aujourd'hui ?",
        tts: 'beta'
    },
    es: {
        flag: '🇪🇸',
        name: 'Spanish',
        rtl: false,
        sampleHint: 'Hola, ¿cómo estás hoy?',
        tts: 'beta'
    },
    ar: {
        flag: '🇸🇦',
        name: 'Arabic',
        rtl: true,
        sampleHint: 'مرحباً، كيف حالك اليوم؟',
        tts: 'beta'
    },
    tr: {
        flag: '🇹🇷',
        name: 'Turkish',
        rtl: false,
        sampleHint: 'Merhaba, bugün nasılsın?',
        tts: 'beta'
    },
    it: {
        flag: '🇮🇹',
        name: 'Italian',
        rtl: false,
        sampleHint: 'Ciao, come stai oggi?',
        tts: 'beta'
    }
};
function getLangPair(mode, other) {
    return mode === 'dub' ? {
        sourceLang: 'fa',
        targetLang: other
    } : {
        sourceLang: other,
        targetLang: 'fa'
    };
}
function langPairFlags(pair) {
    return `${LANG_META[pair.sourceLang]?.flag ?? '❓'} → ${LANG_META[pair.targetLang]?.flag ?? '❓'}`;
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>LiveTranslatorPage
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
// ─────────────────────────────────────────────────────────────────────────────
// VoxShift v1.0.0 — main page. App shell with five functional views:
//   Translate · Sessions · Voice Identity · Settings · About/Diagnostics
// The active view syncs to the URL hash so reloads restore context.
// ─────────────────────────────────────────────────────────────────────────────
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$headphones$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Headphones$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/headphones.js [app-client] (ecmascript) <export default as Headphones>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$keyboard$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Keyboard$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/keyboard.js [app-client] (ecmascript) <export default as Keyboard>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$messages$2d$square$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__MessagesSquare$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/messages-square.js [app-client] (ecmascript) <export default as MessagesSquare>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$monitor$2d$smartphone$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__MonitorSmartphone$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/monitor-smartphone.js [app-client] (ecmascript) <export default as MonitorSmartphone>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$radio$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Radio$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/radio.js [app-client] (ecmascript) <export default as Radio>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$settings$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Settings$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/settings.js [app-client] (ecmascript) <export default as Settings>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/hooks/use-translator.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$wake$2d$lock$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/hooks/use-wake-lock.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$mic$2d$orb$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/mic-orb.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$status$2d$pill$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/status-pill.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$pipeline$2d$visual$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/pipeline-visual.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$live$2d$panel$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/live-panel.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$transcript$2d$list$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/transcript-list.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$settings$2d$card$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/settings-card.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$latency$2d$card$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/latency-card.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$shortcuts$2d$overlay$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/shortcuts-overlay.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$conversations$2d$drawer$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/conversations-drawer.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$thread$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/thread-view.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$shell$2f$app$2d$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/shell/app-shell.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$sessions$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/sessions-view.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$voice$2d$identity$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/voice-identity-view.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$voice$2d$contacts$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/voice-contacts-view.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$identify$2d$speaker$2d$dialog$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/identify-speaker-dialog.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$speaker$2d$chip$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/speaker-chip.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$settings$2d$center$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/settings-center.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$about$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/translator/about-view.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/types/translator.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
const APP_VERSION = 'v3.0.0';
function LiveTranslatorPage() {
    _s();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslator"])();
    const { status, connected, activeStage, level, transcript, profile, profiles, profileLoading, capabilities, threadProfileId, effectiveVoiceProfile, style, voiceMode, mode, otherLang, playbackRate, playbackActive, bigButton, langPair, partial, liveCaption, pendingCount, sessionSpeechMs, sessionLangs, stats, lastError, uiPrefs, autoSaveHistory, useContext, showCaptions, autoDetect, setAutoDetect, speaker, setSpeaker, availableOtherLangs, betaLangs, setBetaLangs, historyRetentionDays, setHistoryRetentionDays, start, stop, setStyle, setVoiceMode, setMode, setOtherLang, setPlaybackRate, setBigButton, setTextSize, setCompact, setShowTranscript, setAutoSaveHistory, setUseContext, setShowCaptions, translateText, pushToTalk, replay, downloadAudio, shareTranslation, shareSaved, createProfile, selectProfile, renameProfile, deleteProfile, updateCloneSettings, clearTranscript, retryFailed, clearError, history, historyLoading, historyCursor, loadHistory, loadMoreHistory, clearHistory, toggleStar, deleteHistoryEntry, conversations, conversationsLoading, activeThread, threadLoading, threadSession, loadConversations, openThread, closeThread, createConversation, renameConversation, deleteConversation, saveThreadOverrides, // v2: voice contacts + speaker recognition + provider health
    contacts, contactsLoading, loadContacts, createContact, updateContact, deleteContact, reenrollContact, speakers, identify, startIdentify, cancelIdentify, confirmIdentify, confirmCandidate, keepUnknown, correctSpeaker, providerHealth, requestProviderHealth, reloadProviders, lastProviders, // v3: AUTO speaker detection + routing policy + realtime event feed
    detectionMode, setDetectionMode, routingPolicy, setRoutingPolicy, realtimeEvents } = t;
    const latest = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "LiveTranslatorPage.useMemo[latest]": ()=>transcript[0] ?? null
    }["LiveTranslatorPage.useMemo[latest]"], [
        transcript
    ]);
    const live = status !== 'idle' && status !== 'starting';
    /** Active speaker (v2 §29): the attribution of the most recent phrase. */ const activeSpeaker = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "LiveTranslatorPage.useMemo[activeSpeaker]": ()=>latest?.speakerKey ? speakers[latest.speakerKey] : undefined
    }["LiveTranslatorPage.useMemo[activeSpeaker]"], [
        latest,
        speakers
    ]);
    const srcMeta = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LANG_META"][langPair.sourceLang] ?? __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LANG_META"].fa;
    const tgtMeta = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LANG_META"][langPair.targetLang] ?? __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LANG_META"].en;
    const canReplayLatest = Boolean(latest?.hasAudio) && status === 'idle';
    const wakeHeld = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$wake$2d$lock$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useWakeLock"])(live);
    // ── View routing (hash-synced, spec §4 navigation) ────────────────────────
    /** Subscribe to hashchange so the view survives reloads + back/forward. */ const subscribeToHash = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "LiveTranslatorPage.useCallback[subscribeToHash]": (onChange)=>{
            window.addEventListener('hashchange', onChange);
            return ({
                "LiveTranslatorPage.useCallback[subscribeToHash]": ()=>window.removeEventListener('hashchange', onChange)
            })["LiveTranslatorPage.useCallback[subscribeToHash]"];
        }
    }["LiveTranslatorPage.useCallback[subscribeToHash]"], []);
    const view = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"])(subscribeToHash, {
        "LiveTranslatorPage.useSyncExternalStore[view]": ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$shell$2f$app$2d$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["viewFromHash"])(window.location.hash)
    }["LiveTranslatorPage.useSyncExternalStore[view]"], {
        "LiveTranslatorPage.useSyncExternalStore[view]": ()=>'translate'
    }["LiveTranslatorPage.useSyncExternalStore[view]"]);
    const changeView = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "LiveTranslatorPage.useCallback[changeView]": (next)=>{
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$shell$2f$app$2d$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["viewFromHash"])(window.location.hash) === next) return;
            window.location.hash = `/${next}`;
        }
    }["LiveTranslatorPage.useCallback[changeView]"], []);
    // Opening a thread from Sessions jumps to the live workspace.
    const openThreadAndGo = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "LiveTranslatorPage.useCallback[openThreadAndGo]": async (id)=>{
            const ok = await openThread(id);
            if (ok) changeView('translate');
        }
    }["LiveTranslatorPage.useCallback[openThreadAndGo]"], [
        openThread,
        changeView
    ]);
    // ── Conversations drawer (quick thread switching from anywhere) ──────────
    const [drawerOpen, setDrawerOpen] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            if (drawerOpen) void loadConversations();
        }
    }["LiveTranslatorPage.useEffect"], [
        drawerOpen,
        loadConversations
    ]);
    /** Thread playback: audio lives in the HistoryEntry cache. */ const replayThreadMessage = (historyEntryId)=>{
        if (!historyEntryId) return;
        try {
            const audio = new Audio(`/api/history/${historyEntryId}/audio`);
            audio.playbackRate = playbackRate;
            void audio.play();
        } catch  {
        // playback blocked — ignore
        }
    };
    // ── Presentation mode: jumbo translation text, everything else dims ────
    const [present, setPresent] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            if (!present) return;
            const onKey = {
                "LiveTranslatorPage.useEffect.onKey": (e)=>{
                    if (e.key === 'Escape') setPresent(false);
                }
            }["LiveTranslatorPage.useEffect.onKey"];
            window.addEventListener('keydown', onKey);
            return ({
                "LiveTranslatorPage.useEffect": ()=>window.removeEventListener('keydown', onKey)
            })["LiveTranslatorPage.useEffect"];
        }
    }["LiveTranslatorPage.useEffect"], [
        present
    ]);
    // ── Shortcuts overlay (? toggles; ignored while typing) ─────────────────
    const [showShortcuts, setShowShortcuts] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            const isTypingTarget = {
                "LiveTranslatorPage.useEffect.isTypingTarget": (el)=>el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
            }["LiveTranslatorPage.useEffect.isTypingTarget"];
            const onKey = {
                "LiveTranslatorPage.useEffect.onKey": (e)=>{
                    if (e.key !== '?' || e.repeat || isTypingTarget(e.target)) return;
                    e.preventDefault();
                    setShowShortcuts({
                        "LiveTranslatorPage.useEffect.onKey": (v)=>!v
                    }["LiveTranslatorPage.useEffect.onKey"]);
                }
            }["LiveTranslatorPage.useEffect.onKey"];
            window.addEventListener('keydown', onKey);
            return ({
                "LiveTranslatorPage.useEffect": ()=>window.removeEventListener('keydown', onKey)
            })["LiveTranslatorPage.useEffect"];
        }
    }["LiveTranslatorPage.useEffect"], []);
    /** Everything that is not the LivePanel fades + blurs while presenting. */ const dimCls = `transition-all duration-500 ${present ? 'opacity-20 blur-[1.5px] pointer-events-none select-none' : ''}`;
    // ── R = replay the last translation (ignored while typing) ──────────
    const replayLatestRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])({
        "LiveTranslatorPage.useRef[replayLatestRef]": ()=>{}
    }["LiveTranslatorPage.useRef[replayLatestRef]"]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            replayLatestRef.current = ({
                "LiveTranslatorPage.useEffect": ()=>{
                    if (canReplayLatest && latest) replay(latest.id);
                }
            })["LiveTranslatorPage.useEffect"];
        }
    }["LiveTranslatorPage.useEffect"], [
        canReplayLatest,
        latest,
        replay
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            const isTypingTarget = {
                "LiveTranslatorPage.useEffect.isTypingTarget": (el)=>el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
            }["LiveTranslatorPage.useEffect.isTypingTarget"];
            const onKey = {
                "LiveTranslatorPage.useEffect.onKey": (e)=>{
                    if (e.key !== 'r' && e.key !== 'R') return;
                    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
                    if (!canReplayLatest) return;
                    e.preventDefault();
                    replayLatestRef.current();
                }
            }["LiveTranslatorPage.useEffect.onKey"];
            window.addEventListener('keydown', onKey);
            return ({
                "LiveTranslatorPage.useEffect": ()=>window.removeEventListener('keydown', onKey)
            })["LiveTranslatorPage.useEffect"];
        }
    }["LiveTranslatorPage.useEffect"], [
        canReplayLatest
    ]);
    // ── Push-to-talk: hold SPACE while live (ignored while typing) ───────
    const pttRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(pushToTalk);
    const liveRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(live);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            pttRef.current = pushToTalk;
            liveRef.current = live;
        }
    }["LiveTranslatorPage.useEffect"], [
        pushToTalk,
        live
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            const isTypingTarget = {
                "LiveTranslatorPage.useEffect.isTypingTarget": (el)=>el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
            }["LiveTranslatorPage.useEffect.isTypingTarget"];
            const onKeyDown = {
                "LiveTranslatorPage.useEffect.onKeyDown": (e)=>{
                    if (e.code !== 'Space' || e.repeat || !liveRef.current || isTypingTarget(e.target)) return;
                    e.preventDefault(); // keep the page from scrolling
                    pttRef.current(true);
                }
            }["LiveTranslatorPage.useEffect.onKeyDown"];
            const onKeyUp = {
                "LiveTranslatorPage.useEffect.onKeyUp": (e)=>{
                    if (e.code !== 'Space' || !liveRef.current) return;
                    e.preventDefault();
                    pttRef.current(false);
                }
            }["LiveTranslatorPage.useEffect.onKeyUp"];
            // Release capture even if the window loses focus mid-hold
            const onBlur = {
                "LiveTranslatorPage.useEffect.onBlur": ()=>pttRef.current(false)
            }["LiveTranslatorPage.useEffect.onBlur"];
            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('keyup', onKeyUp);
            window.addEventListener('blur', onBlur);
            return ({
                "LiveTranslatorPage.useEffect": ()=>{
                    window.removeEventListener('keydown', onKeyDown);
                    window.removeEventListener('keyup', onKeyUp);
                    window.removeEventListener('blur', onBlur);
                }
            })["LiveTranslatorPage.useEffect"];
        }
    }["LiveTranslatorPage.useEffect"], []);
    /** Layout density from UI prefs (spec §4.4). */ const density = uiPrefs.compact ? 'gap-4 py-4' : 'gap-6 py-6 sm:py-8';
    const heroPad = uiPrefs.compact ? 'p-4 sm:p-6' : 'p-6 sm:p-8';
    const globalSettingsLabel = `${__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LANG_META"][mode === 'dub' ? 'fa' : otherLang].name} → ${__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LANG_META"][mode === 'dub' ? otherLang : 'fa'].name} · ${style}`;
    const isTranslating = view === 'translate';
    // Honest static-demo notice: on the GitHub Pages build there is no local
    // backend, so the socket never connects. Show it only after a grace period
    // so a normal local startup never flashes the banner.
    const [staticNotice, setStaticNotice] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "LiveTranslatorPage.useEffect": ()=>{
            if (connected) return;
            const id = setTimeout({
                "LiveTranslatorPage.useEffect.id": ()=>setStaticNotice(true)
            }["LiveTranslatorPage.useEffect.id"], 4000);
            return ({
                "LiveTranslatorPage.useEffect": ()=>clearTimeout(id)
            })["LiveTranslatorPage.useEffect"];
        }
    }["LiveTranslatorPage.useEffect"], [
        connected
    ]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$shell$2f$app$2d$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["AppShell"], {
        view: view,
        onViewChange: changeView,
        header: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("header", {
            className: `relative border-b border-zinc-800 bg-zinc-950/80 backdrop-blur ${dimCls}`,
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    "aria-hidden": true,
                    className: "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-emerald-500/25 to-transparent"
                }, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 232,
                    columnNumber: 11
                }, void 0),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                            type: "button",
                            onClick: ()=>changeView('translate'),
                            className: "flex min-w-0 items-center gap-3 text-left",
                            "aria-label": "VoxShift home",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_24px_-6px_rgba(16,185,129,0.9),inset_0_1px_0_rgba(255,255,255,0.25)]",
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$radio$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Radio$3e$__["Radio"], {
                                        className: "h-4.5 w-4.5 text-zinc-950",
                                        "aria-hidden": true
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 239,
                                        columnNumber: 17
                                    }, void 0)
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 238,
                                    columnNumber: 15
                                }, void 0),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "min-w-0",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                                            className: "truncate text-sm font-black uppercase tracking-[0.24em] text-white",
                                            children: [
                                                "Vox",
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "text-emerald-400",
                                                    children: "Shift"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/app/page.tsx",
                                                    lineNumber: 243,
                                                    columnNumber: 22
                                                }, void 0)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 242,
                                            columnNumber: 17
                                        }, void 0),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                            className: "truncate text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500",
                                            children: [
                                                srcMeta.flag,
                                                " ",
                                                srcMeta.name,
                                                " → ",
                                                tgtMeta.flag,
                                                " ",
                                                tgtMeta.name,
                                                " ·",
                                                ' ',
                                                mode === 'dub' ? 'Your Voice' : 'Interpreter β'
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 245,
                                            columnNumber: 17
                                        }, void 0)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 241,
                                    columnNumber: 15
                                }, void 0)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 237,
                            columnNumber: 13
                        }, void 0),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "flex items-center gap-2",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    onClick: ()=>setDrawerOpen(true),
                                    "aria-label": "Conversations",
                                    title: "Conversations — persistent, resumable threads",
                                    className: "inline-flex h-8 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 text-zinc-400 transition-colors hover:border-teal-700/60 hover:text-teal-300",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$messages$2d$square$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__MessagesSquare$3e$__["MessagesSquare"], {
                                            className: "h-3.5 w-3.5",
                                            "aria-hidden": true
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 260,
                                            columnNumber: 17
                                        }, void 0),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "hidden text-[11px] font-semibold sm:inline",
                                            children: "Threads"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 261,
                                            columnNumber: 17
                                        }, void 0),
                                        activeThread && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "h-1.5 w-1.5 rounded-full bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.9)]",
                                            "aria-hidden": true
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 263,
                                            columnNumber: 19
                                        }, void 0)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 253,
                                    columnNumber: 15
                                }, void 0),
                                wakeHeld && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "hidden items-center gap-1 rounded-full border border-emerald-900/50 bg-emerald-950/30 px-2 py-1 text-[10px] font-medium text-emerald-400 sm:inline-flex",
                                    title: "Screen kept awake during the live session",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$monitor$2d$smartphone$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__MonitorSmartphone$3e$__["MonitorSmartphone"], {
                                            className: "h-3 w-3",
                                            "aria-hidden": true
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 271,
                                            columnNumber: 19
                                        }, void 0),
                                        "Screen awake"
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 267,
                                    columnNumber: 17
                                }, void 0),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "hidden rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-400 sm:inline",
                                    children: APP_VERSION
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 275,
                                    columnNumber: 15
                                }, void 0),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    onClick: ()=>changeView('settings'),
                                    "aria-label": "Settings",
                                    title: "Settings",
                                    className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])('inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors', view === 'settings' ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-700/60 hover:text-emerald-300'),
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$settings$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Settings$3e$__["Settings"], {
                                        className: "h-3.5 w-3.5",
                                        "aria-hidden": true
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 291,
                                        columnNumber: 17
                                    }, void 0)
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 279,
                                    columnNumber: 15
                                }, void 0),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    onClick: ()=>setShowShortcuts((v)=>!v),
                                    "aria-label": "Keyboard shortcuts",
                                    title: "Keyboard shortcuts (?)",
                                    className: "hidden h-8 w-8 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:border-emerald-700/60 hover:text-emerald-300 sm:inline-flex",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$keyboard$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Keyboard$3e$__["Keyboard"], {
                                            className: "h-3.5 w-3.5",
                                            "aria-hidden": true
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 300,
                                            columnNumber: 17
                                        }, void 0),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "hidden font-mono text-[10px] font-bold md:inline",
                                            children: "?"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 301,
                                            columnNumber: 17
                                        }, void 0)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 293,
                                    columnNumber: 15
                                }, void 0),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$status$2d$pill$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["StatusPill"], {
                                    status: status,
                                    connected: connected
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 303,
                                    columnNumber: 15
                                }, void 0)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 251,
                            columnNumber: 13
                        }, void 0)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 236,
                    columnNumber: 11
                }, void 0)
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/page.tsx",
            lineNumber: 231,
            columnNumber: 9
        }, void 0),
        footer: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("footer", {
            className: `relative mt-auto border-t border-zinc-800 bg-zinc-950/80 backdrop-blur ${dimCls}`,
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    "aria-hidden": true,
                    className: "pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/30 to-transparent"
                }, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 310,
                    columnNumber: 11
                }, void 0),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "mx-auto flex max-w-6xl flex-col items-center justify-between gap-1.5 px-4 py-4 pb-[max(0.875rem,env(safe-area-inset-bottom))] text-[11px] text-zinc-600 sm:flex-row sm:px-6",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "font-semibold text-zinc-400",
                                    children: "VoxShift"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 316,
                                    columnNumber: 15
                                }, void 0),
                                " · ",
                                APP_VERSION,
                                " · Persian ↔ English · Deutsch · Français · Español · العربية · Türkçe · Italiano · Voice Match · Threads"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 315,
                            columnNumber: 13
                        }, void 0),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                            className: "font-mono text-[10px] uppercase tracking-wider",
                            children: "ASR · AI Translation · Voice Identity — modular engines"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 320,
                            columnNumber: 13
                        }, void 0)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 314,
                    columnNumber: 11
                }, void 0)
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/page.tsx",
            lineNumber: 309,
            columnNumber: 9
        }, void 0),
        children: [
            staticNotice && !connected && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                role: "status",
                className: "mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                    className: "rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-2.5 text-[12px] leading-relaxed text-amber-200/90",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "font-semibold",
                            children: "Static GitHub Pages demo"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 331,
                            columnNumber: 13
                        }, this),
                        " — the real-time engine (ASR · translation · voice) runs only with the local backend. Clone the repo and run it locally for full functionality:",
                        ' ',
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("a", {
                            className: "font-medium underline decoration-amber-700 underline-offset-2 transition-colors hover:text-amber-100",
                            href: "https://github.com/Dani-Devlop/Vox-Shift",
                            target: "_blank",
                            rel: "noreferrer",
                            children: "github.com/Dani-Devlop/Vox-Shift"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 334,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 330,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 329,
                columnNumber: 9
            }, this),
            isTranslating && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])('flex flex-col', density),
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "lt-enter flex min-w-0 flex-col gap-6",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
                                        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])('lt-card relative overflow-hidden rounded-2xl border bg-zinc-900/40 transition-colors duration-500', heroPad, live ? 'border-emerald-900/60' : 'border-zinc-800', dimCls),
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                "aria-hidden": true,
                                                className: "lt-grid-texture pointer-events-none absolute inset-0"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 361,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                "aria-hidden": true,
                                                className: "lt-vignette pointer-events-none absolute inset-0"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 362,
                                                columnNumber: 17
                                            }, this),
                                            live && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                "aria-hidden": true,
                                                className: "pointer-events-none absolute inset-0 opacity-60",
                                                style: {
                                                    background: 'radial-gradient(420px 220px at 50% -40px, rgba(16,185,129,0.12), transparent 70%)'
                                                }
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 364,
                                                columnNumber: 19
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "relative flex flex-col items-center gap-7",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$mic$2d$orb$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["MicOrb"], {
                                                        status: status,
                                                        level: level,
                                                        onStart: ()=>void start(),
                                                        onStop: ()=>void stop()
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 373,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                        className: "flex h-2 w-full max-w-xs items-center gap-1",
                                                        "aria-hidden": true,
                                                        children: Array.from({
                                                            length: 28
                                                        }).map((_, i)=>{
                                                            const center = Math.abs(i - 13.5) / 13.5;
                                                            const threshold = 1 - center * 0.9;
                                                            const on = live && level > threshold * 0.45;
                                                            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                className: `h-full flex-1 rounded-full transition-colors duration-75 ${on ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-zinc-800'}`
                                                            }, i, false, {
                                                                fileName: "[project]/src/app/page.tsx",
                                                                lineNumber: 381,
                                                                columnNumber: 25
                                                            }, this);
                                                        })
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 375,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$pipeline$2d$visual$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["PipelineVisual"], {
                                                        activeStage: activeStage,
                                                        status: status,
                                                        voiceName: voiceMode === 'profile' && effectiveVoiceProfile ? effectiveVoiceProfile.mode === 'clone' ? `Voice Clone → ${effectiveVoiceProfile.name}` : `Voice Match → ${effectiveVoiceProfile.mappedVoice} ×${effectiveVoiceProfile.pitchRatio?.toFixed(2)}` : 'Default',
                                                        sourceLangName: srcMeta.name,
                                                        targetLangName: tgtMeta.name
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 390,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                        className: "flex items-center gap-2",
                                                        "aria-live": "polite",
                                                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$speaker$2d$chip$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SpeakerChip"], {
                                                            info: activeSpeaker,
                                                            fallback: latest?.speakerRole === 'B' ? 'Speaker B' : latest ? 'Speaker A' : undefined,
                                                            onStartIdentify: startIdentify,
                                                            onConfirmCandidate: confirmCandidate,
                                                            onKeepUnknown: keepUnknown
                                                        }, void 0, false, {
                                                            fileName: "[project]/src/app/page.tsx",
                                                            lineNumber: 405,
                                                            columnNumber: 21
                                                        }, this)
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 404,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 372,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 353,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: dimCls,
                                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$live$2d$panel$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LivePanel"], {
                                            latest: latest,
                                            status: status,
                                            activeStage: activeStage,
                                            langPair: langPair,
                                            partial: partial,
                                            liveCaption: liveCaption,
                                            pendingCount: pendingCount,
                                            canReplay: canReplayLatest,
                                            onReplay: ()=>latest && replay(latest.id),
                                            onDownload: latest?.hasAudio ? ()=>downloadAudio(latest.id, latest.translated) : undefined,
                                            onShare: latest ? ()=>void shareTranslation(latest.id, latest.translated, latest.translated) : undefined,
                                            onTranslateText: translateText,
                                            onPushToTalk: live ? pushToTalk : undefined,
                                            bigButton: bigButton,
                                            present: present,
                                            onTogglePresent: ()=>setPresent((v)=>!v),
                                            abProfile: effectiveVoiceProfile ? {
                                                mappedVoice: effectiveVoiceProfile.mappedVoice,
                                                speedAdjust: effectiveVoiceProfile.speedAdjust,
                                                pitchRatio: effectiveVoiceProfile.pitchRatio
                                            } : null,
                                            abProfileId: effectiveVoiceProfile?.id ?? null,
                                            playbackActive: playbackActive,
                                            lastError: lastError,
                                            onRetryFailed: lastError?.payload ? ()=>retryFailed() : undefined,
                                            onDismissError: clearError,
                                            textScale: uiPrefs.textSize,
                                            speaker: speaker,
                                            onSpeakerChange: setSpeaker,
                                            speakerNote: 'Manual attribution fallback for testing — identity is whatever you label it, not recognized.',
                                            detectionMode: detectionMode,
                                            onDetectionModeChange: setDetectionMode,
                                            activeSpeaker: activeSpeaker,
                                            sessionSpeakers: Object.values(speakers),
                                            contacts: contacts.map((c)=>({
                                                    id: c.id,
                                                    name: c.name,
                                                    disabled: c.disabled
                                                })),
                                            onStartIdentify: startIdentify,
                                            onConfirmCandidate: confirmCandidate,
                                            onKeepUnknown: keepUnknown
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 417,
                                            columnNumber: 17
                                        }, this)
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 416,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: dimCls,
                                        children: activeThread ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$thread$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ThreadView"], {
                                            thread: activeThread,
                                            voiceProfiles: profiles.map((p)=>({
                                                    id: p.id,
                                                    name: p.name,
                                                    mode: p.mode
                                                })),
                                            globalSettingsLabel: globalSettingsLabel,
                                            liveSessionActive: live && threadSession?.status === 'live',
                                            onClose: ()=>closeThread(),
                                            onRename: (id, title)=>renameConversation(id, title),
                                            onSaveOverrides: (overrides)=>saveThreadOverrides(overrides),
                                            onReplay: (m)=>replayThreadMessage(m.historyEntryId)
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 460,
                                            columnNumber: 19
                                        }, this) : uiPrefs.showTranscript ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$transcript$2d$list$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["TranscriptList"], {
                                            entries: transcript,
                                            onClear: clearTranscript,
                                            onReplay: replay,
                                            speakers: speakers,
                                            onStartIdentify: startIdentify,
                                            onConfirmCandidate: confirmCandidate,
                                            onKeepUnknown: keepUnknown
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 471,
                                            columnNumber: 19
                                        }, this) : null
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 458,
                                        columnNumber: 15
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 351,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `lt-enter lt-enter-d1 flex flex-col gap-6 ${dimCls}`,
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$settings$2d$card$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SettingsCard"], {
                                        style: style,
                                        onStyleChange: (s)=>setStyle(s),
                                        voiceMode: voiceMode,
                                        onVoiceModeChange: setVoiceMode,
                                        hasProfile: !!effectiveVoiceProfile,
                                        profileMode: effectiveVoiceProfile?.mode,
                                        mode: mode,
                                        onModeChange: setMode,
                                        otherLang: otherLang,
                                        onOtherLangChange: setOtherLang,
                                        autoDetect: autoDetect,
                                        onAutoDetectChange: setAutoDetect,
                                        availableLangs: availableOtherLangs,
                                        playbackRate: playbackRate,
                                        onPlaybackRateChange: setPlaybackRate,
                                        bigButton: bigButton,
                                        onBigButtonChange: setBigButton,
                                        uiPrefs: uiPrefs,
                                        onTextSizeChange: setTextSize,
                                        onCompactChange: setCompact,
                                        onShowTranscriptChange: setShowTranscript
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 486,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$latency$2d$card$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LatencyCard"], {
                                        stats: stats,
                                        speechMs: sessionSpeechMs,
                                        langsUsed: sessionLangs
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 509,
                                        columnNumber: 15
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 485,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 349,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["cn"])('mx-auto mt-6 flex max-w-xl items-center justify-center gap-2 text-center text-[11px] leading-relaxed text-zinc-600', dimCls),
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$headphones$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Headphones$3e$__["Headphones"], {
                                className: "h-3.5 w-3.5 shrink-0 text-zinc-500",
                                "aria-hidden": true
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 515,
                                columnNumber: 13
                            }, this),
                            "Tip: use headphones to hear your dubbing without feedback — the mic pauses while output plays, so the translation is never re-heard as new speech."
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 514,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 348,
                columnNumber: 9
            }, this),
            view === 'sessions' && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$sessions$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SessionsView"], {
                conversations: conversations,
                conversationsLoading: conversationsLoading,
                activeThreadId: activeThread?.conversation.id ?? null,
                onLoad: loadConversations,
                onOpenThread: openThreadAndGo,
                onCreate: createConversation,
                onRename: renameConversation,
                onDelete: deleteConversation,
                history: history,
                historyLoading: historyLoading,
                historyCursor: historyCursor,
                onLoadHistory: loadHistory,
                onLoadMoreHistory: ()=>loadMoreHistory(),
                onClearHistory: clearHistory,
                onToggleStar: (id)=>toggleStar(id),
                onDeleteHistory: (id)=>deleteHistoryEntry(id),
                onShareSaved: (entry)=>void shareSaved(entry.id, entry.translated, entry.translated, entry.hasAudio),
                onReuse: (entry)=>void translateText(entry.source),
                playbackRate: playbackRate,
                historyCount: history?.length ?? 0
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 524,
                columnNumber: 9
            }, this),
            view === 'contacts' && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$voice$2d$contacts$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["VoiceContactsView"], {
                contacts: contacts,
                loading: contactsLoading,
                onLoad: ()=>void loadContacts(),
                onCreate: createContact,
                onUpdate: updateContact,
                onDelete: deleteContact,
                onReenroll: reenrollContact
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 550,
                columnNumber: 9
            }, this),
            view === 'voice' && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$voice$2d$identity$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["VoiceIdentityView"], {
                profile: profile,
                profiles: profiles,
                loading: profileLoading,
                capabilities: capabilities,
                onCreate: createProfile,
                onSelect: selectProfile,
                onRename: renameProfile,
                onDelete: deleteProfile,
                onUpdateClone: updateCloneSettings,
                previewLang: langPair.targetLang
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 563,
                columnNumber: 9
            }, this),
            view === 'settings' && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$settings$2d$center$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SettingsCenter"], {
                mode: mode,
                otherLang: otherLang,
                style: style,
                voiceMode: voiceMode,
                playbackRate: playbackRate,
                bigButton: bigButton,
                textSize: uiPrefs.textSize,
                compact: uiPrefs.compact,
                showTranscript: uiPrefs.showTranscript,
                autoSaveHistory: autoSaveHistory,
                useContext: useContext,
                showCaptions: showCaptions,
                profiles: profiles,
                profile: profile,
                onModeChange: setMode,
                onOtherLangChange: setOtherLang,
                onStyleChange: setStyle,
                onVoiceModeChange: setVoiceMode,
                onPlaybackRateChange: setPlaybackRate,
                onBigButtonChange: setBigButton,
                onTextSizeChange: setTextSize,
                onCompactChange: setCompact,
                onShowTranscriptChange: setShowTranscript,
                onAutoSaveHistoryChange: setAutoSaveHistory,
                onUseContextChange: setUseContext,
                onShowCaptionsChange: setShowCaptions,
                autoDetect: autoDetect,
                onAutoDetectChange: setAutoDetect,
                betaLangs: betaLangs,
                onBetaLangsChange: setBetaLangs,
                historyRetentionDays: historyRetentionDays,
                onHistoryRetentionDaysChange: setHistoryRetentionDays,
                availableLangs: availableOtherLangs,
                onOpenSelfTest: ()=>changeView('about'),
                onSelectProfile: selectProfile,
                onClearHistory: clearHistory,
                historyCount: history?.length ?? 0,
                providerHealth: providerHealth,
                onRequestProviderHealth: requestProviderHealth,
                onReloadProviders: reloadProviders,
                routingPolicy: routingPolicy,
                onRoutingPolicyChange: setRoutingPolicy,
                realtimeEvents: realtimeEvents
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 579,
                columnNumber: 9
            }, this),
            view === 'about' && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$about$2d$view$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["AboutView"], {
                connected: connected,
                speaker: speaker
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 627,
                columnNumber: 28
            }, this),
            threadLoading && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "fixed inset-x-0 top-16 z-50 flex justify-center",
                "aria-live": "polite",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 shadow-lg",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent",
                            "aria-hidden": true
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 632,
                            columnNumber: 13
                        }, this),
                        "Opening conversation…"
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 631,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 630,
                columnNumber: 9
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$conversations$2d$drawer$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ConversationsDrawer"], {
                open: drawerOpen,
                onOpenChange: setDrawerOpen,
                conversations: conversations,
                loading: conversationsLoading,
                activeThreadId: activeThread?.conversation.id ?? null,
                onLoad: (q)=>void loadConversations(q),
                onOpenThread: (id)=>void openThread(id),
                onCreate: (title)=>createConversation(title),
                onRename: renameConversation,
                onDelete: deleteConversation
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 639,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$shortcuts$2d$overlay$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ShortcutsOverlay"], {
                open: showShortcuts,
                onClose: ()=>setShowShortcuts(false)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 653,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$translator$2f$identify$2d$speaker$2d$dialog$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["IdentifySpeakerDialog"], {
                open: Boolean(identify),
                clusterKey: identify?.clusterKey ?? '',
                phase: identify?.phase ?? 'loading',
                sample: identify?.sample,
                error: identify?.error,
                onConfirm: confirmIdentify,
                onCancel: cancelIdentify
            }, `${identify?.clusterKey ?? 'none'}-${identify ? 'open' : 'closed'}`, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 657,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 227,
        columnNumber: 5
    }, this);
}
_s(LiveTranslatorPage, "+MoskxdodyXHk86RfoiTEHMClVI=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslator"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$wake$2d$lock$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useWakeLock"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"]
    ];
});
_c = LiveTranslatorPage;
var _c;
__turbopack_context__.k.register(_c, "LiveTranslatorPage");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_dcb72afd._.js.map