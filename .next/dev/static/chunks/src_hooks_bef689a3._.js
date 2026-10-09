(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/hooks/use-translator.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "useTranslator",
    ()=>useTranslator
]);
// ─────────────────────────────────────────────────────────────────────────────
// useTranslator — the client-side live translation state machine.
// Wires: MicRecorder (VAD utterances) → socket.io pipeline → AudioPlayer.
// ─────────────────────────────────────────────────────────────────────────────
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$mic$2d$recorder$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/audio/mic-recorder.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$translation$2d$player$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/audio/translation-player.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/realtime/socket.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/types/translator.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$toast$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/hooks/use-toast.ts [app-client] (ecmascript)");
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
const SETTINGS_KEY = 'lt-settings';
const STYLES = [
    'clean',
    'natural',
    'literal',
    'formal',
    'casual'
];
const PREFS_SAVE_DEBOUNCE_MS = 800;
/** Provider routing policies (v3 §25) — mirrors mini-services router. */ const ROUTING_POLICY_VALUES = [
    'auto',
    'local_first',
    'server_first',
    'quality_first',
    'low_cost',
    'privacy_first',
    'manual',
    'failover'
];
const DEFAULT_VOICE = 'kazi';
const OTHER_LANG_GUARDS = [
    'en',
    'de',
    'fr',
    'es',
    'ar',
    'tr',
    'it'
];
const PLAYBACK_RATES = [
    0.75,
    1,
    1.25,
    1.5
];
function useTranslator() {
    _s();
    const { toast } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$toast$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useToast"])();
    const [status, setStatus] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('idle');
    const [connected, setConnected] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [activeStage, setActiveStage] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [level, setLevel] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(0);
    const [transcript, setTranscript] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    const [profile, setProfile] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [profileLoading, setProfileLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    /** Honest voice-identity capability report (from /api/voice-profile). */ const [capabilities, setCapabilities] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    /** Per-thread voice profile override (ThreadOverrides.profileId). */ const [threadProfileId, setThreadProfileId] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const threadProfileIdRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const [style, setStyle] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('natural');
    const [voiceMode, setVoiceMode] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('profile');
    const [mode, setModeState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('dub');
    const [otherLang, setOtherLangState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('en');
    /** Output playback speed (0.75×–1.5×) — persisted, applies live. */ const [playbackRate, setPlaybackRateState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(1);
    /** Big-button talk mode — oversized push-to-talk for phone interpreters. */ const [bigButton, setBigButtonState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    /** AUTO direction + language availability + history retention (persisted). */ const [autoDetect, setAutoDetectState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [betaLangs, setBetaLangsState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    const [historyRetentionDays, setHistoryRetentionDaysState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(0);
    /** Manual speaker turn for two-person conversations ('A' = primary). NOT
   *  persisted — a per-session state. ONLY used in MANUAL detection mode;
   *  AUTO mode (default) uses the server-side voiceprint pipeline instead. */ const [speaker, setSpeakerState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('A');
    // ── v3: AUTO speaker detection + provider routing policy (§1/§9/§25) ────
    const [detectionMode, setDetectionModeState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('auto');
    const [routingPolicy, setRoutingPolicyState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('failover');
    /** Ring buffer of real backend events (§27) for the UI event feed. */ const [realtimeEvents, setRealtimeEvents] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    const pushRealtimeEvent = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[pushRealtimeEvent]": (type, detail)=>{
            setRealtimeEvents({
                "useTranslator.useCallback[pushRealtimeEvent]": (prev)=>[
                        {
                            id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                            type,
                            at: Date.now(),
                            detail
                        },
                        ...prev
                    ].slice(0, 12)
            }["useTranslator.useCallback[pushRealtimeEvent]"]);
        }
    }["useTranslator.useCallback[pushRealtimeEvent]"], []);
    const langPair = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useTranslator.useMemo[langPair]": ()=>// AUTO direction: detect the spoken language per utterance; the server
            // picks the target as the OTHER side of the declared pair (autoPair).
            autoDetect ? {
                sourceLang: 'auto',
                targetLang: 'auto'
            } : (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$types$2f$translator$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getLangPair"])(mode, otherLang)
    }["useTranslator.useMemo[langPair]"], [
        mode,
        otherLang,
        autoDetect
    ]);
    /** The two sides of an AUTO conversation, e.g. 'fa,en'. */ const autoPair = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useTranslator.useMemo[autoPair]": ()=>`fa,${otherLang}`
    }["useTranslator.useMemo[autoPair]"], [
        otherLang
    ]);
    /** Languages offered in pickers — β (accented-TTS) ones hideable. */ const availableOtherLangs = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useTranslator.useMemo[availableOtherLangs]": ()=>betaLangs ? [
                'en',
                'de',
                'fr',
                'es',
                'ar',
                'tr',
                'it'
            ] : [
                'en'
            ]
    }["useTranslator.useMemo[availableOtherLangs]"], [
        betaLangs
    ]);
    const [stats, setStats] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({
        count: 0,
        lastTotalMs: 0,
        avgTotalMs: 0,
        avgAsrMs: 0,
        avgTranslateMs: 0,
        avgTtsMs: 0,
        minTotalMs: 0,
        maxTotalMs: 0
    });
    const recorderRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const playerRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const modeRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(mode);
    const otherLangRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(otherLang);
    const styleRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(style);
    const voiceModeRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(voiceMode);
    const profileRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(profile);
    const statusRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(status);
    const langPairRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(langPair);
    const playbackRateRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(playbackRate);
    const bigButtonRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(bigButton);
    /** Pair spec for AUTO conversations ('fa,<other>') — mirrors otherLang. */ const autoPairRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])('fa,en');
    /** Tail timer for the playback echo-guard (spec §9). */ const echoTailRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    /** Rolling audio cache for transcript replay (last 12 utterances). */ const audioCacheRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(new Map());
    /** Early-delivered translation (translation event) awaiting its audio. */ const [partial, setPartial] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    /** Live caption while the user is speaking (partial ASR). */ const [liveCaption, setLiveCaption] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    /** Utterances sent but not yet completed (queue-depth transparency). */ const [pendingCount, setPendingCount] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(0);
    /** Total captured speech time this session (ms) — drives the session recap. */ const [sessionSpeechMs, setSessionSpeechMs] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(0);
    /** Language pairs used this session, e.g. ['fa→en'] — drives the recap chips. */ const [sessionLangs, setSessionLangs] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    /** Server-persisted history; null = not loaded yet (loaded lazily). */ const [history, setHistory] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [historyLoading, setHistoryLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    /** One partial-ASR request in flight at a time (client-side guard). */ const partialBusyRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(false);
    const partialTimeoutRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    /** Caption utterance id — one per speech segment (set at VAD onset). */ const captionIdRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])('');
    /** Client-side history session id — one start→stop cycle (or typed-phrase
   *  streak) groups related phrases in Saved History. */ const historySessionIdRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    /** UI customization prefs (text size / compact / transcript visibility). */ const [uiPrefs, setUiPrefs] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({
        textSize: 'md',
        compact: false,
        showTranscript: true
    });
    /** Global behavior toggles (spec §6 settings center) — persisted + synced. */ const [autoSaveHistory, setAutoSaveHistoryState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    const [useContext, setUseContextState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    const [showCaptions, setShowCaptionsState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    /** All enrolled voice profiles (spec §5.2 — multiple profiles). */ const [profiles, setProfiles] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    // ── Voice Contacts + speaker recognition (master prompt v2) ────────────
    /** Persisted contacts (recognized people) — synced to the recognizer. */ const [contacts, setContacts] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    const [contactsLoading, setContactsLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    /** Session speaker map: clusterKey → display info. Names resolve through
   *  this map, so identifying "Unknown 1" renames the whole transcript. */ const [speakers, setSpeakers] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({});
    const speakersRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])({});
    /** "Identify Person" flow state (spec §6/§7/§11). */ const [identify, setIdentify] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    /** Live provider health (socket channel — real states, never faked). */ const [providerHealth, setProviderHealth] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    /** Providers used by the last completed utterance (per-result honesty). */ const [lastProviders, setLastProviders] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const contactsRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])([]);
    /** Behavior-toggle refs (kept beside the states they mirror). */ const autoSaveRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(autoSaveHistory);
    const useContextRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(useContext);
    const showCaptionsRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(showCaptions);
    const autoDetectRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(autoDetect);
    const betaLangsRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(betaLangs);
    const speakerRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(speaker);
    const detectionModeRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(detectionMode);
    const routingPolicyRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(routingPolicy);
    /** True once the initial localStorage+server preference load finished —
   *  prevents a defaults-save from clobbering stored preferences on boot. */ const prefsHydratedRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(false);
    const prefsSaveTimerRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    // ── Threads (persistent conversations) ───────────────────────────────────
    const [conversations, setConversations] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [conversationsLoading, setConversationsLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [activeThread, setActiveThread] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [threadLoading, setThreadLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [threadSession, setThreadSession] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const activeThreadIdRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const threadSessionRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    /** Snapshot of global settings taken when a thread applies overrides —
   *  restored on close so a thread can never mutate global defaults. */ const settingsSnapshotRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    /** Recently emitted payloads (last 3) — powers failed-segment retry. */ const payloadCacheRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(new Map());
    /** Last failed segment with its retry payload (null = nothing to retry). */ const [lastError, setLastError] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    autoPairRef.current = `fa,${otherLangRef.current}`;
    styleRef.current = style;
    voiceModeRef.current = voiceMode;
    profileRef.current = profile;
    threadProfileIdRef.current = threadProfileId;
    statusRef.current = status;
    langPairRef.current = langPair;
    playbackRateRef.current = playbackRate;
    bigButtonRef.current = bigButton;
    autoSaveRef.current = autoSaveHistory;
    useContextRef.current = useContext;
    showCaptionsRef.current = showCaptions;
    autoDetectRef.current = autoDetect;
    betaLangsRef.current = betaLangs;
    speakerRef.current = speaker;
    speakersRef.current = speakers;
    contactsRef.current = contacts;
    // ── Voice profiles (REST) ────────────────────────────────────────────────
    const loadProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[loadProfile]": async ()=>{
            try {
                const res = await fetch('/api/voice-profile', {
                    cache: 'no-store'
                });
                const data = await res.json();
                const list = Array.isArray(data?.profiles) ? data.profiles : [];
                setProfiles(list);
                setProfile(list.find({
                    "useTranslator.useCallback[loadProfile]": (p)=>p.isActive
                }["useTranslator.useCallback[loadProfile]"]) ?? null);
                if (data?.capabilities) setCapabilities(data.capabilities);
            } catch  {
            // Non-fatal
            } finally{
                setProfileLoading(false);
            }
        }
    }["useTranslator.useCallback[loadProfile]"], []);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            void loadProfile();
        }
    }["useTranslator.useEffect"], [
        loadProfile
    ]);
    // ── Settings persistence (localStorage + server preferences) ────────────
    // Load once after mount (deferred to a macrotask; avoids both hydration
    // mismatch with SSR and synchronous setState-in-effect). Server preferences
    // (anonymous cookie user) are fetched right after and win over localStorage
    // when present — they survive browser restarts and even other devices.
    /** Apply a validated settings object to state (shared by both loaders). */ const applySettings = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[applySettings]": (s)=>{
            if (s.mode === 'dub' || s.mode === 'interpreter') {
                modeRef.current = s.mode;
                setModeState(s.mode);
            }
            if (s.otherLang && OTHER_LANG_GUARDS.includes(s.otherLang)) {
                otherLangRef.current = s.otherLang;
                setOtherLangState(s.otherLang);
            }
            if (s.style && STYLES.includes(s.style)) setStyle(s.style);
            if (s.voiceMode === 'profile' || s.voiceMode === 'default') setVoiceMode(s.voiceMode);
            if (typeof s.playbackRate === 'number' && PLAYBACK_RATES.includes(s.playbackRate)) {
                playbackRateRef.current = s.playbackRate;
                setPlaybackRateState(s.playbackRate);
            }
            if (typeof s.bigButton === 'boolean') setBigButtonState(s.bigButton);
            if (s.textSize === 'sm' || s.textSize === 'md' || s.textSize === 'lg') {
                setUiPrefs({
                    "useTranslator.useCallback[applySettings]": (prev)=>({
                            ...prev,
                            textSize: s.textSize
                        })
                }["useTranslator.useCallback[applySettings]"]);
            }
            if (typeof s.compact === 'boolean') setUiPrefs({
                "useTranslator.useCallback[applySettings]": (prev)=>({
                        ...prev,
                        compact: s.compact
                    })
            }["useTranslator.useCallback[applySettings]"]);
            if (typeof s.showTranscript === 'boolean') setUiPrefs({
                "useTranslator.useCallback[applySettings]": (prev)=>({
                        ...prev,
                        showTranscript: s.showTranscript
                    })
            }["useTranslator.useCallback[applySettings]"]);
            if (typeof s.autoSaveHistory === 'boolean') setAutoSaveHistoryState(s.autoSaveHistory);
            if (typeof s.useContext === 'boolean') setUseContextState(s.useContext);
            if (typeof s.showCaptions === 'boolean') setShowCaptionsState(s.showCaptions);
            if (typeof s.autoDetect === 'boolean') setAutoDetectState(s.autoDetect);
            if (typeof s.betaLangs === 'boolean') setBetaLangsState(s.betaLangs);
            if (s.detectionMode === 'auto' || s.detectionMode === 'manual') {
                detectionModeRef.current = s.detectionMode;
                setDetectionModeState(s.detectionMode);
            }
            if (typeof s.routingPolicy === 'string' && ROUTING_POLICY_VALUES.includes(s.routingPolicy)) {
                routingPolicyRef.current = s.routingPolicy;
                setRoutingPolicyState(s.routingPolicy);
            }
            if ([
                0,
                7,
                30,
                90
            ].includes(Number(s.historyRetentionDays))) {
                setHistoryRetentionDaysState(Number(s.historyRetentionDays));
            }
        }
    }["useTranslator.useCallback[applySettings]"], []);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            const t = setTimeout({
                "useTranslator.useEffect.t": ()=>{
                    try {
                        const raw = localStorage.getItem(SETTINGS_KEY);
                        if (raw) {
                            const s = JSON.parse(raw);
                            applySettings(s);
                        }
                    } catch  {
                    // Corrupt/absent settings — keep defaults.
                    }
                }
            }["useTranslator.useEffect.t"], 0);
            return ({
                "useTranslator.useEffect": ()=>clearTimeout(t)
            })["useTranslator.useEffect"];
        }
    }["useTranslator.useEffect"], [
        applySettings
    ]);
    // Server preferences (spec §4.1): authoritative when available.
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            let cancelled = false;
            const t = setTimeout({
                "useTranslator.useEffect.t": async ()=>{
                    try {
                        const res = await fetch('/api/preferences', {
                            cache: 'no-store'
                        });
                        const data = await res.json().catch({
                            "useTranslator.useEffect.t": ()=>null
                        }["useTranslator.useEffect.t"]);
                        if (!cancelled && data?.preferences && typeof data.preferences === 'object') {
                            applySettings(data.preferences);
                        }
                    } catch  {
                    // Offline / API down — localStorage fallback already applied.
                    } finally{
                        if (!cancelled) prefsHydratedRef.current = true;
                    }
                }
            }["useTranslator.useEffect.t"], 300);
            return ({
                "useTranslator.useEffect": ()=>{
                    cancelled = true;
                    clearTimeout(t);
                }
            })["useTranslator.useEffect"];
        }
    }["useTranslator.useEffect"], [
        applySettings
    ]);
    // Save whenever any persisted setting changes: localStorage immediately,
    // server preferences debounced (and only after the initial load finished —
    // never overwrite stored prefs with pre-hydration defaults).
    // While a thread is open its overrides temporarily change the live settings;
    // persistence is suppressed so thread overrides can never leak into the
    // stored global defaults (spec §4.2) — closing the thread restores them.
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            const t = setTimeout({
                "useTranslator.useEffect.t": ()=>{
                    if (activeThreadIdRef.current) return; // inside a thread — do not persist
                    try {
                        const s = {
                            mode,
                            otherLang,
                            style,
                            voiceMode,
                            playbackRate,
                            bigButton,
                            textSize: uiPrefs.textSize,
                            compact: uiPrefs.compact,
                            showTranscript: uiPrefs.showTranscript,
                            autoSaveHistory,
                            useContext,
                            showCaptions,
                            autoDetect,
                            betaLangs,
                            historyRetentionDays,
                            detectionMode,
                            routingPolicy
                        };
                        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
                    } catch  {
                    // Storage unavailable — persistence is a convenience only.
                    }
                }
            }["useTranslator.useEffect.t"], 0);
            return ({
                "useTranslator.useEffect": ()=>clearTimeout(t)
            })["useTranslator.useEffect"];
        }
    }["useTranslator.useEffect"], [
        mode,
        otherLang,
        style,
        voiceMode,
        playbackRate,
        bigButton,
        uiPrefs,
        autoSaveHistory,
        useContext,
        showCaptions,
        autoDetect,
        betaLangs,
        historyRetentionDays,
        detectionMode,
        routingPolicy
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            if (!prefsHydratedRef.current) return;
            if (activeThreadIdRef.current) return; // inside a thread — do not persist
            if (prefsSaveTimerRef.current !== null) window.clearTimeout(prefsSaveTimerRef.current);
            prefsSaveTimerRef.current = window.setTimeout({
                "useTranslator.useEffect": ()=>{
                    prefsSaveTimerRef.current = null;
                    void fetch('/api/preferences', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            mode,
                            otherLang,
                            style,
                            voiceMode,
                            playbackRate,
                            bigButton,
                            textSize: uiPrefs.textSize,
                            compact: uiPrefs.compact,
                            showTranscript: uiPrefs.showTranscript,
                            autoSaveHistory,
                            useContext,
                            showCaptions,
                            autoDetect,
                            betaLangs,
                            historyRetentionDays,
                            detectionMode,
                            routingPolicy
                        })
                    }).catch({
                        "useTranslator.useEffect": ()=>{}
                    }["useTranslator.useEffect"]);
                }
            }["useTranslator.useEffect"], PREFS_SAVE_DEBOUNCE_MS);
            return ({
                "useTranslator.useEffect": ()=>{
                    if (prefsSaveTimerRef.current !== null) {
                        window.clearTimeout(prefsSaveTimerRef.current);
                        prefsSaveTimerRef.current = null;
                    }
                }
            })["useTranslator.useEffect"];
        }
    }["useTranslator.useEffect"], [
        mode,
        otherLang,
        style,
        voiceMode,
        playbackRate,
        bigButton,
        uiPrefs,
        autoSaveHistory,
        useContext,
        showCaptions,
        autoDetect,
        betaLangs,
        historyRetentionDays,
        detectionMode,
        routingPolicy
    ]);
    // ── UI customization setters (spec §4.4) ────────────────────────────────
    const setTextSize = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setTextSize]": (size)=>setUiPrefs({
                "useTranslator.useCallback[setTextSize]": (prev)=>({
                        ...prev,
                        textSize: size
                    })
            }["useTranslator.useCallback[setTextSize]"])
    }["useTranslator.useCallback[setTextSize]"], []);
    const setCompact = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setCompact]": (on)=>setUiPrefs({
                "useTranslator.useCallback[setCompact]": (prev)=>({
                        ...prev,
                        compact: on
                    })
            }["useTranslator.useCallback[setCompact]"])
    }["useTranslator.useCallback[setCompact]"], []);
    const setShowTranscript = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setShowTranscript]": (on)=>setUiPrefs({
                "useTranslator.useCallback[setShowTranscript]": (prev)=>({
                        ...prev,
                        showTranscript: on
                    })
            }["useTranslator.useCallback[setShowTranscript]"])
    }["useTranslator.useCallback[setShowTranscript]"], []);
    const setAutoSaveHistory = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setAutoSaveHistory]": (on)=>setAutoSaveHistoryState(on)
    }["useTranslator.useCallback[setAutoSaveHistory]"], []);
    const setUseContext = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setUseContext]": (on)=>setUseContextState(on)
    }["useTranslator.useCallback[setUseContext]"], []);
    const setShowCaptions = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setShowCaptions]": (on)=>setShowCaptionsState(on)
    }["useTranslator.useCallback[setShowCaptions]"], []);
    /** AUTO direction switch — resets pipeline context (language-pair specific). */ const setAutoDetect = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setAutoDetect]": (on)=>{
            autoDetectRef.current = on;
            setAutoDetectState(on);
            const s = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (s.connected) s.emit('session:reset');
        }
    }["useTranslator.useCallback[setAutoDetect]"], []);
    const setBetaLangs = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setBetaLangs]": (on)=>{
            betaLangsRef.current = on;
            setBetaLangsState(on);
        }
    }["useTranslator.useCallback[setBetaLangs]"], []);
    const setHistoryRetentionDays = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setHistoryRetentionDays]": (days)=>{
            setHistoryRetentionDaysState([
                0,
                7,
                30,
                90
            ].includes(days) ? days : 0);
        }
    }["useTranslator.useCallback[setHistoryRetentionDays]"], []);
    /** Manual speaker turn — applies to the NEXT utterance; no reset needed. */ const setSpeaker = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setSpeaker]": (role)=>{
            speakerRef.current = role;
            setSpeakerState(role);
        }
    }["useTranslator.useCallback[setSpeaker]"], []);
    const setBigButton = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setBigButton]": (on)=>setBigButtonState(on)
    }["useTranslator.useCallback[setBigButton]"], []);
    /** Reuse (or lazily create) the current history-session id. */ const ensureHistorySessionId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[ensureHistorySessionId]": ()=>{
            if (!historySessionIdRef.current) {
                historySessionIdRef.current = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            }
            return historySessionIdRef.current;
        }
    }["useTranslator.useCallback[ensureHistorySessionId]"], []);
    /** Clear caption state + in-flight partial request guards. */ const resetCaptionState = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[resetCaptionState]": ()=>{
            setLiveCaption(null);
            captionIdRef.current = '';
            partialBusyRef.current = false;
            if (partialTimeoutRef.current !== null) {
                window.clearTimeout(partialTimeoutRef.current);
                partialTimeoutRef.current = null;
            }
        }
    }["useTranslator.useCallback[resetCaptionState]"], []);
    /**
   * Output playback speed — applies to the live player (if any) immediately
   * and to every player created later.
   */ const setPlaybackRate = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setPlaybackRate]": (rate)=>{
            const safe = Math.min(2, Math.max(0.5, Number(rate) || 1));
            playbackRateRef.current = safe;
            setPlaybackRateState(safe);
            playerRef.current?.setRate(safe);
        }
    }["useTranslator.useCallback[setPlaybackRate]"], []);
    /**
   * The profile actually used for synthesis: a thread-level override wins over
   * the global active profile (per-thread voice selection).
   */ const effectiveProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[effectiveProfile]": ()=>{
            if (voiceModeRef.current !== 'profile') return null;
            const overrideId = threadProfileIdRef.current;
            if (overrideId) {
                const override = profiles.find({
                    "useTranslator.useCallback[effectiveProfile].override": (p)=>p.id === overrideId
                }["useTranslator.useCallback[effectiveProfile].override"]);
                if (override) return override;
            }
            return profileRef.current;
        }
    }["useTranslator.useCallback[effectiveProfile]"], [
        profiles
    ]);
    /** Reactive version for labels/UI: thread override → else global active. */ const effectiveVoiceProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useTranslator.useMemo[effectiveVoiceProfile]": ()=>{
            if (threadProfileId) {
                const override = profiles.find({
                    "useTranslator.useMemo[effectiveVoiceProfile].override": (p)=>p.id === threadProfileId
                }["useTranslator.useMemo[effectiveVoiceProfile].override"]);
                if (override) return override;
            }
            return profile;
        }
    }["useTranslator.useMemo[effectiveVoiceProfile]"], [
        threadProfileId,
        profiles,
        profile
    ]);
    /** Cloning advanced settings (model / stability / similarity / style) for one cloned profile. */ const updateCloneSettings = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[updateCloneSettings]": async (id, patch)=>{
            try {
                const res = await fetch('/api/voice-profile', {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id,
                        ...patch
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                const list = Array.isArray(data?.profiles) ? data.profiles : [];
                setProfiles(list);
                setProfile({
                    "useTranslator.useCallback[updateCloneSettings]": (prev)=>prev && prev.id === id ? data.profile : prev
                }["useTranslator.useCallback[updateCloneSettings]"]);
                return true;
            } catch (err) {
                toast({
                    title: 'Could not update voice settings',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[updateCloneSettings]"], [
        toast
    ]);
    const createProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[createProfile]": async (audioBase64, sampleRate, consented, name, cloneOpts)=>{
            setProfileLoading(true);
            try {
                const res = await fetch('/api/voice-profile', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        audioBase64,
                        sampleRate,
                        consented,
                        name,
                        ...cloneOpts
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    toast({
                        title: 'Voice profile failed',
                        description: data.error ?? 'Unknown error',
                        variant: 'destructive'
                    });
                    return null;
                }
                if (data.capabilities) setCapabilities(data.capabilities);
                const list = Array.isArray(data?.profiles) ? data.profiles : [];
                setProfiles(list);
                setProfile(data.profile);
                if (data.profile.mode === 'clone') {
                    toast({
                        title: 'Voice clone ready ✓',
                        description: `“${data.profile.name}” is a real cloned voice — translations are now spoken with YOUR enrolled voice.`
                    });
                } else {
                    toast({
                        title: 'Voice profile ready ✓',
                        description: `Pitch-conformed match: “${data.profile.mappedVoice}” shifted ×${data.profile.pitchRatio?.toFixed(2) ?? '1.00'} toward your register (estimated, not a clone)`
                    });
                }
                return data.profile;
            } catch (err) {
                toast({
                    title: 'Voice profile failed',
                    description: err instanceof Error ? err.message : 'Network error',
                    variant: 'destructive'
                });
                return null;
            } finally{
                setProfileLoading(false);
            }
        }
    }["useTranslator.useCallback[createProfile]"], [
        toast
    ]);
    /** Make another enrolled profile the active default (spec §5.2). */ const selectProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[selectProfile]": async (id)=>{
            try {
                const res = await fetch('/api/voice-profile', {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id,
                        isActive: true
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                const list = Array.isArray(data?.profiles) ? data.profiles : [];
                setProfiles(list);
                setProfile(list.find({
                    "useTranslator.useCallback[selectProfile]": (p)=>p.id === id
                }["useTranslator.useCallback[selectProfile]"]) ?? null);
                return true;
            } catch (err) {
                toast({
                    title: 'Could not switch voice profile',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[selectProfile]"], [
        toast
    ]);
    /** Rename an enrolled profile. */ const renameProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[renameProfile]": async (id, name)=>{
            const clean = name.trim().slice(0, 60);
            if (!clean) return false;
            try {
                const res = await fetch('/api/voice-profile', {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id,
                        name: clean
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                const list = Array.isArray(data?.profiles) ? data.profiles : [];
                setProfiles(list);
                setProfile({
                    "useTranslator.useCallback[renameProfile]": (prev)=>prev && prev.id === id ? {
                            ...prev,
                            name: clean
                        } : prev
                }["useTranslator.useCallback[renameProfile]"]);
                return true;
            } catch  {
                toast({
                    title: 'Could not rename profile',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[renameProfile]"], [
        toast
    ]);
    /** Delete one profile (or ALL when no id is given). */ const deleteProfile = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[deleteProfile]": async (id)=>{
            try {
                const res = await fetch(`/api/voice-profile${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
                    method: 'DELETE'
                });
                const data = await res.json().catch({
                    "useTranslator.useCallback[deleteProfile]": ()=>null
                }["useTranslator.useCallback[deleteProfile]"]);
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                const list = Array.isArray(data?.profiles) ? data.profiles : [];
                setProfiles(list);
                setProfile(list.find({
                    "useTranslator.useCallback[deleteProfile]": (p)=>p.isActive
                }["useTranslator.useCallback[deleteProfile]"]) ?? null);
                toast({
                    title: id ? 'Voice profile deleted' : 'All voice profiles removed'
                });
            } catch  {
                toast({
                    title: 'Could not remove profile',
                    variant: 'destructive'
                });
            }
        }
    }["useTranslator.useCallback[deleteProfile]"], [
        toast
    ]);
    // ── Voice Contacts (master prompt v2 — persistent speaker recognition) ──
    /** Push the contact list (with voiceprints) to the local recognizer. */ const syncContactsToEngine = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[syncContactsToEngine]": (list)=>{
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (!socket.connected) return;
            socket.emit('contacts:sync', {
                contacts: list.filter({
                    "useTranslator.useCallback[syncContactsToEngine]": (c)=>Array.isArray(c.vector) && c.vector.length > 0
                }["useTranslator.useCallback[syncContactsToEngine]"]).map({
                    "useTranslator.useCallback[syncContactsToEngine]": (c)=>({
                            contactId: c.id,
                            name: c.name,
                            vector: c.vector,
                            threshold: c.confidenceThreshold,
                            disabled: c.disabled
                        })
                }["useTranslator.useCallback[syncContactsToEngine]"])
            });
        }
    }["useTranslator.useCallback[syncContactsToEngine]"], []);
    const loadContacts = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[loadContacts]": async (silent = false)=>{
            if (!silent) setContactsLoading(true);
            try {
                const res = await fetch('/api/voice-contacts', {
                    cache: 'no-store'
                });
                const data = await res.json();
                const list = Array.isArray(data?.contacts) ? data.contacts : [];
                setContacts(list);
                syncContactsToEngine(list);
                return list;
            } catch  {
                return [];
            } finally{
                setContactsLoading(false);
            }
        }
    }["useTranslator.useCallback[loadContacts]"], [
        syncContactsToEngine
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            void loadContacts();
        }
    }["useTranslator.useEffect"], [
        loadContacts
    ]);
    /**
   * Create a contact from a voice sample (spec §8): raw PCM from the recorder
   * OR the WAV sample assembled by the engine from live speech. Consent is
   * mandatory. On success the recognizer learns the new voice immediately.
   */ const createContact = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[createContact]": async (input)=>{
            try {
                const res = await fetch('/api/voice-contacts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(input)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                const list = await loadContacts(true);
                const contact = data.contact;
                // Attach the fresh voiceprint to the live cluster so THIS session's
                // future utterances match too (spec §9 + §11 instant rename).
                if (input.fromCluster && Array.isArray(contact.vector)) {
                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])().emit('speakers:label', {
                        clusterKey: input.fromCluster,
                        contactId: contact.id,
                        name: contact.name,
                        vector: contact.vector
                    });
                    setSpeakers({
                        "useTranslator.useCallback[createContact]": (prev)=>({
                                ...prev,
                                [input.fromCluster]: {
                                    clusterKey: input.fromCluster,
                                    contactId: contact.id,
                                    name: contact.name,
                                    status: 'verified',
                                    confidence: undefined
                                }
                            })
                    }["useTranslator.useCallback[createContact]"]);
                }
                void list;
                return contact;
            } catch (err) {
                toast({
                    title: 'Could not save the contact',
                    description: err instanceof Error ? err.message : 'Unknown error',
                    variant: 'destructive'
                });
                return null;
            }
        }
    }["useTranslator.useCallback[createContact]"], [
        loadContacts,
        toast
    ]);
    /** Rename / enable-disable / adjust a contact's threshold (spec §10/§18). */ const updateContact = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[updateContact]": async (id, patch)=>{
            try {
                const res = await fetch(`/api/voice-contacts/${encodeURIComponent(id)}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(patch)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                const list = await loadContacts(true);
                // Renames propagate to the current transcript instantly.
                if (patch.name) {
                    setSpeakers({
                        "useTranslator.useCallback[updateContact]": (prev)=>{
                            const next = {
                                ...prev
                            };
                            for (const [key, info] of Object.entries(next)){
                                if (info.contactId === id) next[key] = {
                                    ...info,
                                    name: patch.name
                                };
                            }
                            return next;
                        }
                    }["useTranslator.useCallback[updateContact]"]);
                }
                void list;
                return true;
            } catch (err) {
                toast({
                    title: 'Could not update the contact',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[updateContact]"], [
        loadContacts,
        toast
    ]);
    /** Delete a contact (profile + reference audio) — explicit, confirmable. */ const deleteContact = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[deleteContact]": async (id)=>{
            try {
                const res = await fetch(`/api/voice-contacts/${encodeURIComponent(id)}`, {
                    method: 'DELETE'
                });
                if (!res.ok) throw new Error('Request failed');
                await loadContacts(true);
                setSpeakers({
                    "useTranslator.useCallback[deleteContact]": (prev)=>{
                        const next = {
                            ...prev
                        };
                        for (const [key, info] of Object.entries(next)){
                            if (info.contactId === id) next[key] = {
                                ...info,
                                contactId: undefined,
                                status: 'unknown'
                            };
                        }
                        return next;
                    }
                }["useTranslator.useCallback[deleteContact]"]);
                toast({
                    title: 'Voice contact deleted',
                    description: 'The voice profile and its reference audio were removed.'
                });
                return true;
            } catch  {
                toast({
                    title: 'Could not delete the contact',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[deleteContact]"], [
        loadContacts,
        toast
    ]);
    /** Re-enroll a contact with a fresh sample (spec §10 "Re-enroll"). */ const reenrollContact = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[reenrollContact]": async (id, audioBase64, sampleRate, consented, merge = true)=>{
            try {
                const res = await fetch(`/api/voice-contacts/${encodeURIComponent(id)}/reenroll`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        audioBase64,
                        sampleRate,
                        consented,
                        merge
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data?.error ?? 'Request failed');
                await loadContacts(true);
                return data;
            } catch (err) {
                toast({
                    title: 'Re-enroll failed',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive'
                });
                return null;
            }
        }
    }["useTranslator.useCallback[reenrollContact]"], [
        loadContacts,
        toast
    ]);
    // ── Identify flow (spec §6/§7/§11): unknown speaker → named contact ─────
    /** Ask the engine for the collected (~10 s) sample of an unknown speaker. */ const startIdentify = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[startIdentify]": (clusterKey)=>{
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            setIdentify({
                clusterKey,
                phase: 'loading'
            });
            if (!socket.connected) {
                setIdentify({
                    clusterKey,
                    phase: 'ready',
                    error: 'The real-time engine is offline — samples are assembled from the live session.'
                });
                return;
            }
            socket.emit('speakers:identify', {
                clusterKey
            });
        }
    }["useTranslator.useCallback[startIdentify]"], []);
    const cancelIdentify = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[cancelIdentify]": ()=>setIdentify(null)
    }["useTranslator.useCallback[cancelIdentify]"], []);
    /** Persist the current speaker registry to the open thread (stable ids). */ const persistSpeakerRegistry = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[persistSpeakerRegistry]": ()=>{
            const conversationId = activeThreadIdRef.current;
            if (!conversationId) return;
            const registry = Object.values(speakersRef.current).map({
                "useTranslator.useCallback[persistSpeakerRegistry].registry": (s)=>({
                        clusterKey: s.clusterKey,
                        contactId: s.contactId ?? null,
                        displayName: s.name ?? null
                    })
            }["useTranslator.useCallback[persistSpeakerRegistry].registry"]);
            void fetch(`/api/conversations/${conversationId}/speakers`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    speakers: registry
                })
            }).catch({
                "useTranslator.useCallback[persistSpeakerRegistry]": ()=>{}
            }["useTranslator.useCallback[persistSpeakerRegistry]"]);
        }
    }["useTranslator.useCallback[persistSpeakerRegistry]"], []);
    /** Save the identified person as a Voice Contact (spec §8). */ const confirmIdentify = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[confirmIdentify]": async (name, language)=>{
            const idState = identify;
            if (!idState?.sample) return false;
            setIdentify({
                ...idState,
                phase: 'saving'
            });
            const created = await createContact({
                name,
                audioBase64: idState.sample.wavBase64,
                sampleRate: idState.sample.sampleRate,
                consented: true,
                language,
                fromCluster: idState.clusterKey
            });
            if (created) {
                setIdentify(null);
                toast({
                    title: `${name} saved ✓`,
                    description: 'This voice is now recognized automatically in future conversations.'
                });
                persistSpeakerRegistry();
            }
            return Boolean(created);
        }
    }["useTranslator.useCallback[confirmIdentify]"], [
        createContact,
        identify,
        toast
    ]);
    /** Ambiguous match (spec §14): user confirms a candidate or stays Unknown. */ const confirmCandidate = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[confirmCandidate]": (clusterKey, contactId, contactName)=>{
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])().emit('speakers:label', {
                clusterKey,
                contactId,
                name: contactName
            });
            setSpeakers({
                "useTranslator.useCallback[confirmCandidate]": (prev)=>({
                        ...prev,
                        [clusterKey]: {
                            clusterKey,
                            contactId,
                            name: contactName,
                            status: 'verified'
                        }
                    })
            }["useTranslator.useCallback[confirmCandidate]"]);
            persistSpeakerRegistry();
        }
    }["useTranslator.useCallback[confirmCandidate]"], []);
    const keepUnknown = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[keepUnknown]": (clusterKey)=>{
            setSpeakers({
                "useTranslator.useCallback[keepUnknown]": (prev)=>{
                    const cur = prev[clusterKey];
                    if (!cur) return prev;
                    const { candidates: _drop, ...rest } = cur;
                    return {
                        ...prev,
                        [clusterKey]: {
                            ...rest,
                            status: 'unknown'
                        }
                    };
                }
            }["useTranslator.useCallback[keepUnknown]"]);
            persistSpeakerRegistry();
        }
    }["useTranslator.useCallback[keepUnknown]"], []);
    /** Correct a speaker in the CURRENT session (spec §18): pick a contact or
   *  set a temporary label. Permanent profile changes go through Contacts. */ const correctSpeaker = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[correctSpeaker]": (clusterKey, contactId, name)=>{
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])().emit('speakers:label', {
                clusterKey,
                contactId,
                name,
                vector: contactId ? contactsRef.current.find({
                    "useTranslator.useCallback[correctSpeaker]": (c)=>c.id === contactId
                }["useTranslator.useCallback[correctSpeaker]"])?.vector ?? undefined : undefined
            });
            setSpeakers({
                "useTranslator.useCallback[correctSpeaker]": (prev)=>({
                        ...prev,
                        [clusterKey]: {
                            clusterKey,
                            contactId: contactId ?? undefined,
                            name,
                            status: contactId ? 'verified' : 'unknown'
                        }
                    })
            }["useTranslator.useCallback[correctSpeaker]"]);
            persistSpeakerRegistry();
        }
    }["useTranslator.useCallback[correctSpeaker]"], []);
    // ── Provider health (§30) ────────────────────────────────────────────────
    const requestProviderHealth = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[requestProviderHealth]": ()=>{
            const s = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (s.connected) s.emit('providers:health');
        }
    }["useTranslator.useCallback[requestProviderHealth]"], []);
    /** Apply a routing policy immediately — real socket round-trip (v3 §25). */ const setRoutingPolicy = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setRoutingPolicy]": (policy)=>{
            routingPolicyRef.current = policy;
            setRoutingPolicyState(policy);
            const s = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (s.connected) s.emit('providers:policy', {
                policy
            });
        }
    }["useTranslator.useCallback[setRoutingPolicy]"], []);
    /** AUTO (voiceprint) vs MANUAL (A/B fallback) speaker detection (v3 §9). */ const setDetectionMode = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setDetectionMode]": (m)=>{
            detectionModeRef.current = m;
            setDetectionModeState(m);
        }
    }["useTranslator.useCallback[setDetectionMode]"], []);
    const reloadProviders = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[reloadProviders]": ()=>{
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (socket.connected) socket.emit('providers:reload');
        }
    }["useTranslator.useCallback[reloadProviders]"], []);
    // ── Socket lifecycle ────────────────────────────────────────────────────
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            const onConnect = {
                "useTranslator.useEffect.onConnect": ()=>{
                    setConnected(true);
                    // Announce identity + sync enrolled contacts so the recognizer matches
                    // voices from the first utterance (spec v2 §9/§17).
                    socket.emit('session:init', {
                        contacts: contactsRef.current.filter({
                            "useTranslator.useEffect.onConnect": (c)=>Array.isArray(c.vector) && c.vector.length > 0
                        }["useTranslator.useEffect.onConnect"]).map({
                            "useTranslator.useEffect.onConnect": (c)=>({
                                    contactId: c.id,
                                    name: c.name,
                                    vector: c.vector,
                                    threshold: c.confidenceThreshold,
                                    disabled: c.disabled
                                })
                        }["useTranslator.useEffect.onConnect"])
                    });
                    // Apply the persisted routing policy to the engine (v3 §25).
                    socket.emit('providers:policy', {
                        policy: routingPolicyRef.current
                    });
                }
            }["useTranslator.useEffect.onConnect"];
            const onDisconnect = {
                "useTranslator.useEffect.onDisconnect": ()=>{
                    setConnected(false);
                    if (statusRef.current !== 'idle') setStatus('reconnecting');
                }
            }["useTranslator.useEffect.onDisconnect"];
            const onConnectError = {
                "useTranslator.useEffect.onConnectError": ()=>setConnected(false)
            }["useTranslator.useEffect.onConnectError"];
            const onStage = {
                "useTranslator.useEffect.onStage": (event)=>{
                    if (event.status === 'start') {
                        setActiveStage(event.stage);
                    } else if (event.stage === 'tts') {
                        setActiveStage(null);
                    }
                }
            }["useTranslator.useEffect.onStage"];
            const onTranslation = {
                "useTranslator.useEffect.onTranslation": (event)=>{
                    if (event.speaker) {
                        setSpeakers({
                            "useTranslator.useEffect.onTranslation": (prev)=>({
                                    ...prev,
                                    [event.speaker.clusterKey]: event.speaker
                                })
                        }["useTranslator.useEffect.onTranslation"]);
                    }
                    setPartial({
                        utteranceId: event.utteranceId,
                        source: event.sourceText,
                        translated: event.translatedText,
                        sourceLang: event.sourceLang,
                        targetLang: event.targetLang,
                        voice: event.voice,
                        speakerRole: event.speakerRole,
                        speakerKey: event.speaker?.clusterKey,
                        speakerStatus: event.speaker?.status
                    });
                }
            }["useTranslator.useEffect.onTranslation"];
            /** Partial-ASR reply → live caption (ignored when empty or stale). */ const onAsrPartial = {
                "useTranslator.useEffect.onAsrPartial": (res)=>{
                    partialBusyRef.current = false;
                    if (partialTimeoutRef.current !== null) {
                        window.clearTimeout(partialTimeoutRef.current);
                        partialTimeoutRef.current = null;
                    }
                    if (!res.text || res.utteranceId !== captionIdRef.current) return;
                    setLiveCaption({
                        "useTranslator.useEffect.onAsrPartial": (cur)=>({
                                id: res.utteranceId,
                                text: res.text,
                                elapsedMs: cur?.elapsedMs ?? 0
                            })
                    }["useTranslator.useEffect.onAsrPartial"]);
                }
            }["useTranslator.useEffect.onAsrPartial"];
            const onResult = {
                "useTranslator.useEffect.onResult": (result)=>{
                    setActiveStage(null);
                    setPartial(null); // full result (with audio) replaces the early text
                    setLiveCaption(null);
                    setLastError(null); // a successful result clears any previous failure
                    setPendingCount({
                        "useTranslator.useEffect.onResult": (c)=>Math.max(0, c - 1)
                    }["useTranslator.useEffect.onResult"]);
                    if (!result.sourceText && !result.translatedText) return; // silence/noise segment
                    // Speaker recognition: register the attribution (names resolve later).
                    if (result.speaker) {
                        setSpeakers({
                            "useTranslator.useEffect.onResult": (prev)=>({
                                    ...prev,
                                    [result.speaker.clusterKey]: result.speaker
                                })
                        }["useTranslator.useEffect.onResult"]);
                    }
                    if (result.providers) setLastProviders(result.providers);
                    const entry = {
                        id: result.utteranceId,
                        source: result.sourceText,
                        translated: result.translatedText,
                        timings: result.timings,
                        voice: result.voice,
                        voiceMode: result.voiceMode,
                        sourceLang: result.sourceLang ?? langPairRef.current.sourceLang,
                        targetLang: result.targetLang ?? langPairRef.current.targetLang,
                        speakerRole: result.speakerRole ?? 'A',
                        speakerKey: result.speaker?.clusterKey,
                        speakerStatus: result.speaker?.status,
                        speakerConfidence: result.speaker?.confidence,
                        hasAudio: Boolean(result.audioBase64),
                        createdAt: Date.now()
                    };
                    setTranscript({
                        "useTranslator.useEffect.onResult": (prev)=>[
                                entry,
                                ...prev
                            ].slice(0, 50)
                    }["useTranslator.useEffect.onResult"]);
                    // Session recap: remember the language pair used (first time only)
                    const pairKey = `${entry.sourceLang}→${entry.targetLang}`;
                    setSessionLangs({
                        "useTranslator.useEffect.onResult": (prev)=>prev.includes(pairKey) ? prev : [
                                ...prev,
                                pairKey
                            ]
                    }["useTranslator.useEffect.onResult"]);
                    // Keep recent audio for replay from the transcript
                    if (result.audioBase64) {
                        const cache = audioCacheRef.current;
                        cache.set(result.utteranceId, result.audioBase64);
                        if (cache.size > 12) {
                            const oldest = cache.keys().next().value;
                            if (oldest !== undefined) cache.delete(oldest);
                        }
                    }
                    // Latency stats (rolling)
                    setStats({
                        "useTranslator.useEffect.onResult": (prev)=>{
                            const count = prev.count + 1;
                            const avg = {
                                "useTranslator.useEffect.onResult.avg": (a, v)=>Math.round((a * (count - 1) + v) / count)
                            }["useTranslator.useEffect.onResult.avg"];
                            return {
                                count,
                                lastTotalMs: result.timings.totalMs,
                                avgTotalMs: avg(prev.avgTotalMs, result.timings.totalMs),
                                avgAsrMs: avg(prev.avgAsrMs, result.timings.asrMs),
                                avgTranslateMs: avg(prev.avgTranslateMs, result.timings.translateMs),
                                avgTtsMs: avg(prev.avgTtsMs, result.timings.ttsMs),
                                minTotalMs: prev.count === 0 ? result.timings.totalMs : Math.min(prev.minTotalMs, result.timings.totalMs),
                                maxTotalMs: prev.count === 0 ? result.timings.totalMs : Math.max(prev.maxTotalMs, result.timings.totalMs)
                            };
                        }
                    }["useTranslator.useEffect.onResult"]);
                    if (result.audioBase64) {
                        playerRef.current?.enqueue(result.audioBase64);
                    }
                    // Persistence (fire-and-forget; failure is silent — convenience layers).
                    // Saved-history storage respects the auto-save setting (spec §6.1).
                    // Thread messages ALWAYS append while a conversation is open (spec §8) —
                    // with auto-save off they simply carry no audio link (honest: no replay).
                    const histSessionId = ensureHistorySessionId();
                    const threadIdAtResult = activeThreadIdRef.current;
                    const threadSessionAtResult = threadSessionRef.current;
                    /** Append the result to the open thread; `historyEntryId` links audio. */ const saveThreadMessage = {
                        "useTranslator.useEffect.onResult.saveThreadMessage": (historyEntryId)=>{
                            if (!threadIdAtResult) return;
                            void fetch('/api/messages', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    conversationId: threadIdAtResult,
                                    sessionId: threadSessionAtResult?.sessionId,
                                    speakerRole: entry.speakerRole === 'B' ? 'other' : 'user',
                                    source: entry.source,
                                    translated: entry.translated,
                                    sourceLang: entry.sourceLang,
                                    targetLang: entry.targetLang,
                                    style: styleRef.current,
                                    voice: entry.voiceMode === 'clone' ? 'your voice (clone)' : entry.voice,
                                    timings: entry.timings,
                                    historyEntryId,
                                    // Speaker recognition fields (v2 §28) — keep attribution stable.
                                    speakerKey: entry.speakerKey ?? null,
                                    speakerContactId: speakersRef.current[entry.speakerKey ?? '']?.contactId ?? null,
                                    speakerName: speakersRef.current[entry.speakerKey ?? '']?.name ?? (entry.speakerRole === 'B' ? 'Speaker B' : 'Speaker A'),
                                    identificationStatus: speakersRef.current[entry.speakerKey ?? '']?.status ?? null,
                                    speakerConfidence: entry.speakerConfidence ?? null
                                })
                            }).then({
                                "useTranslator.useEffect.onResult.saveThreadMessage": (res)=>res.ok ? res.json() : null
                            }["useTranslator.useEffect.onResult.saveThreadMessage"]).then({
                                "useTranslator.useEffect.onResult.saveThreadMessage": (msgData)=>{
                                    if (!msgData?.message?.id) return;
                                    const msg = {
                                        id: msgData.message.id,
                                        sessionId: threadSessionAtResult?.sessionId ?? null,
                                        sequenceNo: msgData.message.sequenceNo,
                                        speakerRole: entry.speakerRole === 'B' ? 'other' : 'user',
                                        sourceLang: entry.sourceLang,
                                        targetLang: entry.targetLang,
                                        source: entry.source,
                                        translated: entry.translated,
                                        style: styleRef.current,
                                        voice: entry.voice,
                                        timings: entry.timings,
                                        historyEntryId,
                                        processingStatus: 'complete',
                                        speakerKey: entry.speakerKey ?? null,
                                        speakerContactId: speakersRef.current[entry.speakerKey ?? '']?.contactId ?? null,
                                        speakerName: speakersRef.current[entry.speakerKey ?? '']?.name ?? null,
                                        identificationStatus: speakersRef.current[entry.speakerKey ?? '']?.status ?? null,
                                        speakerConfidence: entry.speakerConfidence ?? null,
                                        createdAt: msgData.message.createdAt
                                    };
                                    setActiveThread({
                                        "useTranslator.useEffect.onResult.saveThreadMessage": (prev)=>prev && prev.conversation.id === threadIdAtResult ? {
                                                ...prev,
                                                messages: [
                                                    ...prev.messages,
                                                    msg
                                                ]
                                            } : prev
                                    }["useTranslator.useEffect.onResult.saveThreadMessage"]);
                                    setConversations({
                                        "useTranslator.useEffect.onResult.saveThreadMessage": (prev)=>prev ? prev.map({
                                                "useTranslator.useEffect.onResult.saveThreadMessage": (c)=>c.id === threadIdAtResult ? {
                                                        ...c,
                                                        messageCount: c.messageCount + 1,
                                                        lastActivityAt: msgData.message.createdAt
                                                    } : c
                                            }["useTranslator.useEffect.onResult.saveThreadMessage"]) : prev
                                    }["useTranslator.useEffect.onResult.saveThreadMessage"]);
                                }
                            }["useTranslator.useEffect.onResult.saveThreadMessage"]).catch({
                                "useTranslator.useEffect.onResult.saveThreadMessage": ()=>{}
                            }["useTranslator.useEffect.onResult.saveThreadMessage"]);
                        }
                    }["useTranslator.useEffect.onResult.saveThreadMessage"];
                    if (autoSaveRef.current) {
                        void fetch('/api/history', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                source: entry.source,
                                translated: entry.translated,
                                sourceLang: entry.sourceLang,
                                targetLang: entry.targetLang,
                                style: styleRef.current,
                                voice: entry.voiceMode === 'clone' ? 'your voice (clone)' : entry.voice,
                                timings: entry.timings,
                                hasAudio: entry.hasAudio,
                                audioBase64: result.audioBase64 || undefined,
                                sessionId: histSessionId
                            })
                        }).then({
                            "useTranslator.useEffect.onResult": (res)=>res.ok ? res.json() : null
                        }["useTranslator.useEffect.onResult"]).then({
                            "useTranslator.useEffect.onResult": (data)=>{
                                if (!data?.id) return;
                                setHistory({
                                    "useTranslator.useEffect.onResult": (prev)=>{
                                        if (prev === null) return null // panel not opened yet — will fetch fresh later
                                        ;
                                        const saved = {
                                            id: data.id,
                                            source: entry.source,
                                            translated: entry.translated,
                                            sourceLang: entry.sourceLang,
                                            targetLang: entry.targetLang,
                                            style: styleRef.current,
                                            voice: entry.voice,
                                            timings: entry.timings,
                                            hasAudio: entry.hasAudio,
                                            starred: false,
                                            sessionId: histSessionId,
                                            createdAt: new Date().toISOString()
                                        };
                                        return [
                                            saved,
                                            ...prev
                                        ].slice(0, 100);
                                    }
                                }["useTranslator.useEffect.onResult"]);
                                // Thread persistence (spec §5.1): the message links to the
                                // audio-bearing history row so replay works after reload.
                                saveThreadMessage(data.id);
                            }
                        }["useTranslator.useEffect.onResult"]).catch({
                            "useTranslator.useEffect.onResult": ()=>{}
                        }["useTranslator.useEffect.onResult"]);
                    } else {
                        saveThreadMessage(null);
                    }
                }
            }["useTranslator.useEffect.onResult"];
            const onUtteranceError = {
                "useTranslator.useEffect.onUtteranceError": (error)=>{
                    setActiveStage(null);
                    setPartial(null);
                    setLiveCaption(null);
                    setPendingCount({
                        "useTranslator.useEffect.onUtteranceError": (c)=>Math.max(0, c - 1)
                    }["useTranslator.useEffect.onUtteranceError"]);
                    // Preserve the exact payload so the user can retry THIS segment (spec §7).
                    const payload = payloadCacheRef.current.get(error.utteranceId) ?? null;
                    setLastError(payload ? {
                        utteranceId: error.utteranceId,
                        stage: error.stage,
                        message: error.message,
                        payload
                    } : null);
                    const rateLimited = /429|rate|quota|too many/i.test(error.message);
                    toast({
                        title: rateLimited ? 'Provider rate limit' : 'Pipeline error',
                        description: rateLimited ? 'The provider is limiting requests right now. Completed phrases are safe — retry this segment in a moment.' : error.message,
                        variant: 'destructive'
                    });
                }
            }["useTranslator.useEffect.onUtteranceError"];
            socket.on('connect', onConnect);
            socket.on('disconnect', onDisconnect);
            socket.on('connect_error', onConnectError);
            socket.on('stage', onStage);
            socket.on('translation', onTranslation);
            socket.on('asr:partial:result', onAsrPartial);
            socket.on('result', onResult);
            socket.on('utterance:error', onUtteranceError);
            // ── v2: speaker recognition + identify flow ────────────────────────────
            const onSpeakersSample = {
                "useTranslator.useEffect.onSpeakersSample": (data)=>{
                    setIdentify({
                        "useTranslator.useEffect.onSpeakersSample": (cur)=>cur && cur.clusterKey === data.clusterKey ? {
                                ...cur,
                                phase: 'ready',
                                sample: {
                                    wavBase64: data.wavBase64,
                                    sampleRate: data.sampleRate,
                                    durationSec: data.durationSec,
                                    speechSec: data.speechSec
                                }
                            } : cur
                    }["useTranslator.useEffect.onSpeakersSample"]);
                }
            }["useTranslator.useEffect.onSpeakersSample"];
            const onSpeakersSampleError = {
                "useTranslator.useEffect.onSpeakersSampleError": (data)=>{
                    setIdentify({
                        "useTranslator.useEffect.onSpeakersSampleError": (cur)=>cur && cur.clusterKey === data.clusterKey ? {
                                ...cur,
                                phase: 'ready',
                                error: data.message
                            } : cur
                    }["useTranslator.useEffect.onSpeakersSampleError"]);
                }
            }["useTranslator.useEffect.onSpeakersSampleError"];
            const onSpeakersLabeled = {
                "useTranslator.useEffect.onSpeakersLabeled": (info)=>{
                    if (!('status' in info)) return;
                    setSpeakers({
                        "useTranslator.useEffect.onSpeakersLabeled": (prev)=>({
                                ...prev,
                                [info.clusterKey]: info
                            })
                    }["useTranslator.useEffect.onSpeakersLabeled"]);
                }
            }["useTranslator.useEffect.onSpeakersLabeled"];
            const onProvidersHealth = {
                "useTranslator.useEffect.onProvidersHealth": (data)=>{
                    setProviderHealth(Array.isArray(data?.providers) ? data.providers : []);
                }
            }["useTranslator.useEffect.onProvidersHealth"];
            socket.on('speakers:sample', onSpeakersSample);
            socket.on('speakers:sample:error', onSpeakersSampleError);
            socket.on('speakers:labeled', onSpeakersLabeled);
            socket.on('providers:health', onProvidersHealth);
            // §25 truth sync: the engine acknowledges the effective policy — if the
            // server rejected/adjusted it, the UI follows the SERVER's answer.
            const onPolicyOk = {
                "useTranslator.useEffect.onPolicyOk": (data)=>{
                    if (typeof data?.policy === 'string' && data.policy !== routingPolicyRef.current) {
                        routingPolicyRef.current = data.policy;
                        setRoutingPolicyState(data.policy);
                    }
                }
            }["useTranslator.useEffect.onPolicyOk"];
            socket.on('providers:policy-ok', onPolicyOk);
            // ── v3: real-time event model (§27) — the UI reacts to REAL backend events,
            // never to timers or mock data.
            const onNamed = {
                "useTranslator.useEffect.onNamed": (type)=>({
                        "useTranslator.useEffect.onNamed": (data)=>{
                            const detail = typeof data?.name === 'string' ? [
                                data.name,
                                typeof data?.confidence === 'number' ? `${Math.round(data.confidence * 100)}%` : ''
                            ].filter(Boolean).join(' · ') : typeof data?.to?.name === 'string' ? String(data.to.name) : undefined;
                            pushRealtimeEvent(type, detail);
                            if (type === 'speaker.enrolled' && typeof data?.contactId === 'string') {
                                // New persistent identity → refresh contacts + resync to the engine.
                                void loadContacts(true);
                            }
                        }
                    })["useTranslator.useEffect.onNamed"]
            }["useTranslator.useEffect.onNamed"];
            for (const t of [
                'speaker.started',
                'speaker.changed',
                'speaker.recognized',
                'speaker.unknown',
                'speaker.enrollment_started',
                'speaker.enrollment_ready',
                'speaker.enrolled',
                'translation.completed',
                'tts.started',
                'tts.completed'
            ]){
                socket.on(t, onNamed(t));
            }
            const onTranscriptFinal = {
                "useTranslator.useEffect.onTranscriptFinal": (data)=>{
                    pushRealtimeEvent('transcript.final', typeof data?.translatedText === 'string' ? data.translatedText.slice(0, 60) : undefined);
                }
            }["useTranslator.useEffect.onTranscriptFinal"];
            socket.on('transcript.final', onTranscriptFinal);
            const onProviderFailed = {
                "useTranslator.useEffect.onProviderFailed": (data)=>{
                    pushRealtimeEvent('provider.failed', `${data?.providerId ?? 'provider'}: ${(data?.error ?? 'failed').slice(0, 100)}`);
                }
            }["useTranslator.useEffect.onProviderFailed"];
            const onProviderFallback = {
                "useTranslator.useEffect.onProviderFallback": (data)=>{
                    pushRealtimeEvent('provider.fallback', `${data?.fromProviderId ?? '?'} → ${data?.toProviderId ?? '?'}`);
                }
            }["useTranslator.useEffect.onProviderFallback"];
            socket.on('provider.failed', onProviderFailed);
            socket.on('provider.fallback', onProviderFallback);
            if (socket.connected) {
                setConnected(true);
                socket.emit('providers:policy', {
                    policy: routingPolicyRef.current
                });
                socket.emit('session:init', {
                    contacts: contactsRef.current.filter({
                        "useTranslator.useEffect": (c)=>Array.isArray(c.vector) && c.vector.length > 0
                    }["useTranslator.useEffect"]).map({
                        "useTranslator.useEffect": (c)=>({
                                contactId: c.id,
                                name: c.name,
                                vector: c.vector,
                                threshold: c.confidenceThreshold,
                                disabled: c.disabled
                            })
                    }["useTranslator.useEffect"])
                });
            }
            return ({
                "useTranslator.useEffect": ()=>{
                    socket.off('connect', onConnect);
                    socket.off('disconnect', onDisconnect);
                    socket.off('connect_error', onConnectError);
                    socket.off('stage', onStage);
                    socket.off('translation', onTranslation);
                    socket.off('asr:partial:result', onAsrPartial);
                    socket.off('result', onResult);
                    socket.off('utterance:error', onUtteranceError);
                    socket.off('speakers:sample', onSpeakersSample);
                    socket.off('speakers:sample:error', onSpeakersSampleError);
                    socket.off('speakers:labeled', onSpeakersLabeled);
                    socket.off('providers:health', onProvidersHealth);
                    socket.off('providers:policy-ok', onPolicyOk);
                    for (const t of [
                        'speaker.started',
                        'speaker.changed',
                        'speaker.recognized',
                        'speaker.unknown',
                        'speaker.enrollment_started',
                        'speaker.enrollment_ready',
                        'speaker.enrolled',
                        'translation.completed',
                        'tts.started',
                        'tts.completed'
                    ]){
                        socket.off(t, onNamed(t));
                    }
                    socket.off('transcript.final', onTranscriptFinal);
                    socket.off('provider.failed', onProviderFailed);
                    socket.off('provider.fallback', onProviderFallback);
                }
            })["useTranslator.useEffect"];
        }
    }["useTranslator.useEffect"], [
        toast,
        ensureHistorySessionId,
        pushRealtimeEvent,
        loadContacts
    ]);
    // ── Playback state → status ─────────────────────────────────────────────
    const handlePlaybackStart = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[handlePlaybackStart]": ()=>{
            if (statusRef.current !== 'idle') setStatus('speaking');
        }
    }["useTranslator.useCallback[handlePlaybackStart]"], []);
    const handlePlaybackEnd = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[handlePlaybackEnd]": ()=>{
            if (statusRef.current === 'speaking') setStatus('listening');
        }
    }["useTranslator.useCallback[handlePlaybackEnd]"], []);
    /**
   * Playback UI state — independent of the session status so typed phrases
   * (no live session → status stays 'idle') still light up the playing
   * indicators in the LivePanel.
   */ const [playbackActive, setPlaybackActive] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    /** Shared player factory — identical wiring for live sessions and typed phrases.
   *  Also drives the playback echo-guard (spec §9): while synthesized audio is
   *  playing, the mic's VAD is frozen so the output is never re-recognized as
   *  user speech; on end, a short tail window avoids catching the decay. */ const createPlayer = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[createPlayer]": async ()=>{
            const player = new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$translation$2d$player$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["TranslationAudioPlayer"]({
                onPlaybackStart: {
                    "useTranslator.useCallback[createPlayer]": ()=>{
                        handlePlaybackStart();
                        setPlaybackActive(true);
                        if (echoTailRef.current !== null) {
                            window.clearTimeout(echoTailRef.current);
                            echoTailRef.current = null;
                        }
                        recorderRef.current?.setPlaybackDucked(true);
                    }
                }["useTranslator.useCallback[createPlayer]"],
                onPlaybackEnd: {
                    "useTranslator.useCallback[createPlayer]": ()=>{
                        handlePlaybackEnd();
                        setPlaybackActive(false);
                        if (echoTailRef.current !== null) window.clearTimeout(echoTailRef.current);
                        echoTailRef.current = window.setTimeout({
                            "useTranslator.useCallback[createPlayer]": ()=>{
                                echoTailRef.current = null;
                                recorderRef.current?.setPlaybackDucked(false);
                            }
                        }["useTranslator.useCallback[createPlayer]"], 350);
                    }
                }["useTranslator.useCallback[createPlayer]"]
            });
            await player.init();
            player.setRate(playbackRateRef.current);
            return player;
        }
    }["useTranslator.useCallback[createPlayer]"], [
        handlePlaybackStart,
        handlePlaybackEnd
    ]);
    // ── Thread session lifecycle (declared before session controls) ─────────
    /** Open (or reuse) a live session record for the open thread. */ const beginThreadSession = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[beginThreadSession]": async (conversationId)=>{
            const existing = threadSessionRef.current;
            if (existing && existing.conversationId === conversationId && existing.status === 'live') return existing;
            try {
                const res = await fetch(`/api/conversations/${conversationId}/sessions`, {
                    method: 'POST'
                });
                const data = await res.json().catch({
                    "useTranslator.useCallback[beginThreadSession]": ()=>null
                }["useTranslator.useCallback[beginThreadSession]"]);
                if (!res.ok || !data?.session) return null;
                const ref = {
                    conversationId,
                    sessionId: data.session.id,
                    status: 'live'
                };
                threadSessionRef.current = ref;
                setThreadSession(ref);
                return ref;
            } catch  {
                return null // thread session is a persistence nicety — never block the mic
                ;
            }
        }
    }["useTranslator.useCallback[beginThreadSession]"], []);
    const endThreadSession = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[endThreadSession]": ()=>{
            const sess = threadSessionRef.current;
            if (!sess) return;
            void fetch(`/api/conversations/${sess.conversationId}/sessions`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sessionId: sess.sessionId,
                    status: 'ended'
                })
            }).catch({
                "useTranslator.useCallback[endThreadSession]": ()=>{}
            }["useTranslator.useCallback[endThreadSession]"]);
            threadSessionRef.current = null;
            setThreadSession({
                "useTranslator.useCallback[endThreadSession]": (prev)=>prev ? {
                        ...prev,
                        status: 'ended'
                    } : null
            }["useTranslator.useCallback[endThreadSession]"]);
        }
    }["useTranslator.useCallback[endThreadSession]"], []);
    // ── Session controls ────────────────────────────────────────────────────
    const stop = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[stop]": async ()=>{
            const recorder = recorderRef.current;
            recorderRef.current = null;
            playerRef.current?.clear();
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (socket.connected) socket.emit('session:reset');
            if (recorder) await recorder.stop();
            setActiveStage(null);
            setPartial(null);
            resetCaptionState();
            setPendingCount(0);
            setLevel(0);
            setStatus('idle');
            // Ending the live session closes its history group — the next session (or
            // typed-phrase streak) starts a fresh one. A thread session ends with it.
            historySessionIdRef.current = null;
            endThreadSession();
            persistSpeakerRegistry();
        }
    }["useTranslator.useCallback[stop]"], [
        endThreadSession,
        persistSpeakerRegistry,
        resetCaptionState
    ]);
    const start = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[start]": async ()=>{
            if (recorderRef.current) return;
            setStatus('starting');
            try {
                const player = await createPlayer();
                playerRef.current = player;
                const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
                if (!socket.connected) {
                    // Wait briefly for the connection before opening the mic
                    await new Promise({
                        "useTranslator.useCallback[start]": (resolve)=>{
                            if (socket.connected) return resolve();
                            const timer = setTimeout({
                                "useTranslator.useCallback[start].timer": ()=>resolve()
                            }["useTranslator.useCallback[start].timer"], 4000);
                            socket.once('connect', {
                                "useTranslator.useCallback[start]": ()=>{
                                    clearTimeout(timer);
                                    resolve();
                                }
                            }["useTranslator.useCallback[start]"]);
                        }
                    }["useTranslator.useCallback[start]"]);
                }
                const recorder = new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audio$2f$mic$2d$recorder$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["MicRecorder"]({
                    onUtterance: {
                        "useTranslator.useCallback[start]": (audioBase64, durationSec)=>{
                            const prof = effectiveProfile();
                            // Speaker B (second person in a two-way conversation) speaks the
                            // opposite language and audibly DIFFERENT: pipeline default voice,
                            // no profile — so the two sides of the dialogue are distinguishable.
                            const isB = detectionModeRef.current === 'manual' && speakerRef.current === 'B';
                            const bProf = isB ? null : prof;
                            const useProfile = Boolean(bProf);
                            const pair = langPairRef.current;
                            setSessionSpeechMs({
                                "useTranslator.useCallback[start]": (v)=>v + durationSec * 1000
                            }["useTranslator.useCallback[start]"]);
                            setPendingCount({
                                "useTranslator.useCallback[start]": (c)=>c + 1
                            }["useTranslator.useCallback[start]"]);
                            const utteranceId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                            const payload = {
                                utteranceId,
                                audioBase64,
                                sampleRate: 16000,
                                sourceLang: pair.sourceLang,
                                targetLang: pair.targetLang,
                                autoPair: autoDetectRef.current ? autoPairRef.current : undefined,
                                style: styleRef.current,
                                voice: useProfile ? bProf.mappedVoice : isB ? 'jam' : DEFAULT_VOICE,
                                speed: useProfile ? bProf.speedAdjust : 1.0,
                                pitchRatio: useProfile ? bProf.pitchRatio : 1.0,
                                profileMode: useProfile ? bProf.mode : undefined,
                                providerProfileId: useProfile ? bProf.providerProfileId ?? undefined : undefined,
                                providerModel: useProfile ? bProf.providerModel ?? undefined : undefined,
                                stability: useProfile ? bProf.stability : undefined,
                                providerSimilarity: useProfile ? bProf.providerSimilarity ?? undefined : undefined,
                                providerStyle: useProfile ? bProf.providerStyle ?? undefined : undefined,
                                speakerRole: detectionModeRef.current === 'manual' ? speakerRef.current : undefined,
                                detectionMode: detectionModeRef.current,
                                ttsEcho: false
                            };
                            // Context off (settings): each phrase translates standalone — clear the
                            // pipeline's rolling conversation history before this utterance runs.
                            if (!useContextRef.current) {
                                const s = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
                                if (s.connected) s.emit('session:reset');
                            }
                            // Keep the exact payload for failed-segment retry (spec §7).
                            const payloads = payloadCacheRef.current;
                            payloads.set(utteranceId, {
                                kind: 'audio',
                                data: payload
                            });
                            if (payloads.size > 3) {
                                const oldest = payloads.keys().next().value;
                                if (oldest !== undefined) payloads.delete(oldest);
                            }
                            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])().emit('utterance', payload);
                        }
                    }["useTranslator.useCallback[start]"],
                    onLevel: setLevel,
                    onSpeakingChange: {
                        "useTranslator.useCallback[start]": (speaking)=>{
                            if (!speaking) return;
                            // New speech segment → new caption id (partials attach to it).
                            captionIdRef.current = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                            if (statusRef.current !== 'idle') setStatus('user-speaking');
                        }
                    }["useTranslator.useCallback[start]"],
                    // Live captions: mid-speech ASR snapshots (one in flight at a time).
                    onPartial: {
                        "useTranslator.useCallback[start]": (pcmBase64)=>{
                            if (!showCaptionsRef.current) return; // captions off (settings)
                            if (partialBusyRef.current) return;
                            const id = captionIdRef.current;
                            if (!id) return;
                            partialBusyRef.current = true;
                            const pair = langPairRef.current;
                            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])().emit('asr:partial', {
                                utteranceId: id,
                                audioBase64: pcmBase64,
                                sampleRate: 16000,
                                sourceLang: pair.sourceLang
                            });
                            // Safety valve: unblock if no reply arrives (disconnect, drop…).
                            partialTimeoutRef.current = window.setTimeout({
                                "useTranslator.useCallback[start]": ()=>{
                                    partialBusyRef.current = false;
                                    partialTimeoutRef.current = null;
                                }
                            }["useTranslator.useCallback[start]"], 3000);
                        }
                    }["useTranslator.useCallback[start]"],
                    onSpeechTick: {
                        "useTranslator.useCallback[start]": (elapsedMs)=>{
                            setLiveCaption({
                                "useTranslator.useCallback[start]": (cur)=>cur ? {
                                        ...cur,
                                        elapsedMs
                                    } : null
                            }["useTranslator.useCallback[start]"]);
                        }
                    }["useTranslator.useCallback[start]"],
                    onError: {
                        "useTranslator.useCallback[start]": (err)=>{
                            toast({
                                title: 'Microphone error',
                                description: err.message,
                                variant: 'destructive'
                            });
                            void stop();
                        }
                    }["useTranslator.useCallback[start]"]
                });
                await recorder.start();
                recorderRef.current = recorder;
                // Live speech starts a new history session group (typed phrases before
                // this belonged to their own streak).
                historySessionIdRef.current = null;
                ensureHistorySessionId();
                // While a thread is open, recording runs inside a persisted thread
                // session (spec §5.5) — new messages append to the same conversation.
                const tid = activeThreadIdRef.current;
                if (tid) void beginThreadSession(tid);
                setStatus('listening');
            } catch (err) {
                console.error('[use-translator] start failed:', err);
                setStatus('idle');
                const message = err instanceof Error && err.name === 'NotAllowedError' ? 'Microphone permission denied. Allow mic access and try again.' : err instanceof Error ? err.message : 'Failed to start the session';
                toast({
                    title: 'Cannot start',
                    description: message,
                    variant: 'destructive'
                });
            }
        }
    }["useTranslator.useCallback[start]"], [
        beginThreadSession,
        createPlayer,
        effectiveProfile,
        handlePlaybackEnd,
        handlePlaybackStart,
        stop,
        toast
    ]);
    const clearTranscript = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[clearTranscript]": ()=>{
            setTranscript([]);
            audioCacheRef.current.clear();
            setPartial(null);
            resetCaptionState();
            setPendingCount(0);
            setSessionSpeechMs(0);
            setSessionLangs([]);
            setSpeakers({});
            setLastProviders(null);
            setStats({
                count: 0,
                lastTotalMs: 0,
                avgTotalMs: 0,
                avgAsrMs: 0,
                avgTranslateMs: 0,
                avgTtsMs: 0,
                minTotalMs: 0,
                maxTotalMs: 0
            });
        }
    }["useTranslator.useCallback[clearTranscript]"], [
        resetCaptionState
    ]);
    modeRef.current = mode;
    otherLangRef.current = otherLang;
    /** Reset pipeline context — it is language-pair specific. */ const resetServerContext = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[resetServerContext]": ()=>{
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            if (socket.connected) socket.emit('session:reset');
        }
    }["useTranslator.useCallback[resetServerContext]"], []);
    /** Switch Dub/Interpreter; resets pipeline context (it is language-specific). */ const setMode = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setMode]": (next)=>{
            if (next === modeRef.current) return;
            modeRef.current = next;
            setModeState(next);
            resetServerContext();
        }
    }["useTranslator.useCallback[setMode]"], [
        resetServerContext
    ]);
    /** Change the non-Persian side language; resets pipeline context. */ const setOtherLang = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[setOtherLang]": (next)=>{
            if (next === otherLangRef.current) return;
            otherLangRef.current = next;
            setOtherLangState(next);
            resetServerContext();
        }
    }["useTranslator.useCallback[setOtherLang]"], [
        resetServerContext
    ]);
    /**
   * Type-to-translate: send a typed phrase through the same pipeline (no ASR).
   * Lazily initializes the audio player so playback works even when the mic
   * session is not running (Send click counts as a user gesture).
   */ const translateText = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[translateText]": async (text)=>{
            const trimmed = text.trim();
            if (!trimmed || trimmed.length > 1000) return false;
            if (!playerRef.current) {
                try {
                    playerRef.current = await createPlayer();
                } catch  {
                // No audio output available — text result still arrives.
                }
            }
            const pair = langPairRef.current;
            const prof = effectiveProfile();
            const useProfile = Boolean(prof);
            // Typed phrases group into a session streak (new group after a live session ends).
            ensureHistorySessionId();
            const utteranceId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const payload = {
                utteranceId,
                text: trimmed,
                sourceLang: pair.sourceLang,
                targetLang: pair.targetLang,
                autoPair: autoDetectRef.current ? autoPairRef.current : undefined,
                style: styleRef.current,
                voice: useProfile ? prof.mappedVoice : DEFAULT_VOICE,
                speed: useProfile ? prof.speedAdjust : 1.0,
                pitchRatio: useProfile ? prof.pitchRatio : 1.0,
                profileMode: useProfile ? prof.mode : undefined,
                providerProfileId: useProfile ? prof.providerProfileId ?? undefined : undefined,
                providerModel: useProfile ? prof.providerModel ?? undefined : undefined,
                stability: useProfile ? prof.stability : undefined,
                providerSimilarity: useProfile ? prof.providerSimilarity ?? undefined : undefined,
                providerStyle: useProfile ? prof.providerStyle ?? undefined : undefined,
                speakerRole: speakerRef.current
            };
            // Context off (settings): typed phrases translate standalone too.
            if (!useContextRef.current) {
                const s = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
                if (s.connected) s.emit('session:reset');
            }
            // Keep the exact payload for failed-segment retry (spec §7).
            const payloads = payloadCacheRef.current;
            payloads.set(utteranceId, {
                kind: 'text',
                data: payload
            });
            if (payloads.size > 3) {
                const oldest = payloads.keys().next().value;
                if (oldest !== undefined) payloads.delete(oldest);
            }
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])().emit('translate:text', payload);
            return true;
        }
    }["useTranslator.useCallback[translateText]"], [
        createPlayer,
        effectiveProfile,
        ensureHistorySessionId
    ]);
    /**
   * Push-to-talk: hold-to-capture control over the live recorder's VAD.
   * `true` opens an utterance immediately (bypassing silence detection);
   * `false` flushes whatever was captured, even mid-speech.
   */ const pushToTalk = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[pushToTalk]": (active)=>{
            const recorder = recorderRef.current;
            if (!recorder) return;
            if (active) recorder.startPushToTalk();
            else recorder.stopPushToTalk();
        }
    }["useTranslator.useCallback[pushToTalk]"], []);
    /**
   * Download a previously spoken utterance as a .wav file (from the rolling
   * 12-utterance client cache). Older phrases can be downloaded from Saved
   * History instead — the toast says so.
   */ const downloadAudio = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[downloadAudio]": (utteranceId, label)=>{
            const audio = audioCacheRef.current.get(utteranceId);
            if (!audio) {
                toast({
                    title: 'Audio not available',
                    description: 'Only the last 12 spoken phrases download here — older ones live in Saved History.'
                });
                return false;
            }
            try {
                const bin = atob(audio);
                const bytes = new Uint8Array(bin.length);
                for(let i = 0; i < bin.length; i++)bytes[i] = bin.charCodeAt(i);
                const blob = new Blob([
                    bytes
                ], {
                    type: 'audio/wav'
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${slugify(label) || 'translation'}-${utteranceId}.wav`;
                a.click();
                URL.revokeObjectURL(url);
                return true;
            } catch  {
                toast({
                    title: 'Download failed',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[downloadAudio]"], [
        toast
    ]);
    /** Replay a previously spoken utterance from the transcript (if still cached). */ const replay = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[replay]": (utteranceId)=>{
            const audio = audioCacheRef.current.get(utteranceId);
            if (audio && playerRef.current) {
                playerRef.current.enqueue(audio);
                return true;
            }
            toast({
                title: 'Audio not available',
                description: 'Only the last 12 spoken phrases replay here — older ones live in Saved History.'
            });
            return false;
        }
    }["useTranslator.useCallback[replay]"], [
        toast
    ]);
    // ── Persisted history (REST) ──────────────────────────────────────────
    /** ISO cursor of the oldest loaded entry — null when everything is loaded. */ const [historyCursor, setHistoryCursor] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const loadHistory = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[loadHistory]": async ()=>{
            setHistoryLoading(true);
            try {
                const res = await fetch('/api/history?limit=60', {
                    cache: 'no-store'
                });
                const data = await res.json();
                setHistory(Array.isArray(data.entries) ? data.entries : []);
                setHistoryCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
            } catch  {
                setHistory([]);
                setHistoryCursor(null);
            } finally{
                setHistoryLoading(false);
            }
        }
    }["useTranslator.useCallback[loadHistory]"], []);
    /** Delete ONE saved history entry (text + cached audio; thread messages
   *  stay but lose their audio link — disclosed behavior). */ const deleteHistoryEntry = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[deleteHistoryEntry]": async (id)=>{
            try {
                const res = await fetch(`/api/history/${encodeURIComponent(id)}`, {
                    method: 'DELETE'
                });
                if (!res.ok) throw new Error('Request failed');
                setHistory({
                    "useTranslator.useCallback[deleteHistoryEntry]": (prev)=>prev ? prev.filter({
                            "useTranslator.useCallback[deleteHistoryEntry]": (e)=>e.id !== id
                        }["useTranslator.useCallback[deleteHistoryEntry]"]) : prev
                }["useTranslator.useCallback[deleteHistoryEntry]"]);
                return true;
            } catch  {
                toast({
                    title: 'Could not delete the entry',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[deleteHistoryEntry]"], [
        toast
    ]);
    /**
   * Load the next page of history using the server cursor and append it.
   * No-op while a load is already running or the end was reached.
   */ const loadMoreHistory = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[loadMoreHistory]": async ()=>{
            if (!historyCursor || historyLoading) return;
            setHistoryLoading(true);
            try {
                const res = await fetch(`/api/history?limit=60&before=${encodeURIComponent(historyCursor)}`, {
                    cache: 'no-store'
                });
                const data = await res.json();
                const older = Array.isArray(data.entries) ? data.entries : [];
                if (older.length > 0) {
                    setHistory({
                        "useTranslator.useCallback[loadMoreHistory]": (prev)=>{
                            if (prev === null) return older;
                            const seen = new Set(prev.map({
                                "useTranslator.useCallback[loadMoreHistory]": (e)=>e.id
                            }["useTranslator.useCallback[loadMoreHistory]"]));
                            return [
                                ...prev,
                                ...older.filter({
                                    "useTranslator.useCallback[loadMoreHistory]": (e)=>!seen.has(e.id)
                                }["useTranslator.useCallback[loadMoreHistory]"])
                            ];
                        }
                    }["useTranslator.useCallback[loadMoreHistory]"]);
                }
                setHistoryCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
            } catch  {
            // Keep current list + cursor — user can retry.
            } finally{
                setHistoryLoading(false);
            }
        }
    }["useTranslator.useCallback[loadMoreHistory]"], [
        historyCursor,
        historyLoading
    ]);
    const clearHistory = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[clearHistory]": async ()=>{
            try {
                await fetch('/api/history', {
                    method: 'DELETE'
                });
                setHistory([]);
                toast({
                    title: 'History cleared'
                });
            } catch  {
                toast({
                    title: 'Could not clear history',
                    variant: 'destructive'
                });
            }
        }
    }["useTranslator.useCallback[clearHistory]"], [
        toast
    ]);
    /**
   * Star / unstar a saved phrase (phrasebook). Optimistic flip with server
   * reconciliation — on failure the previous value is restored.
   */ const toggleStar = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[toggleStar]": async (entryId)=>{
            const current = history?.find({
                "useTranslator.useCallback[toggleStar]": (e)=>e.id === entryId
            }["useTranslator.useCallback[toggleStar]"]);
            const next = !(current?.starred ?? false);
            // Optimistic update
            setHistory({
                "useTranslator.useCallback[toggleStar]": (prev)=>prev?.map({
                        "useTranslator.useCallback[toggleStar]": (e)=>e.id === entryId ? {
                                ...e,
                                starred: next
                            } : e
                    }["useTranslator.useCallback[toggleStar]"]) ?? prev
            }["useTranslator.useCallback[toggleStar]"]);
            try {
                const res = await fetch(`/api/history/${entryId}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        starred: next
                    })
                });
                if (!res.ok) throw new Error(String(res.status));
                const data = await res.json().catch({
                    "useTranslator.useCallback[toggleStar]": ()=>null
                }["useTranslator.useCallback[toggleStar]"]);
                // Reconcile with the server value
                if (data && typeof data.starred === 'boolean') {
                    setHistory({
                        "useTranslator.useCallback[toggleStar]": (prev)=>prev?.map({
                                "useTranslator.useCallback[toggleStar]": (e)=>e.id === entryId ? {
                                        ...e,
                                        starred: data.starred
                                    } : e
                            }["useTranslator.useCallback[toggleStar]"]) ?? prev
                    }["useTranslator.useCallback[toggleStar]"]);
                }
            } catch  {
                setHistory({
                    "useTranslator.useCallback[toggleStar]": (prev)=>prev?.map({
                            "useTranslator.useCallback[toggleStar]": (e)=>e.id === entryId ? {
                                    ...e,
                                    starred: !next
                                } : e
                        }["useTranslator.useCallback[toggleStar]"]) ?? prev
                }["useTranslator.useCallback[toggleStar]"]);
                toast({
                    title: 'Could not update star',
                    variant: 'destructive'
                });
            }
        }
    }["useTranslator.useCallback[toggleStar]"], [
        history,
        toast
    ]);
    // ── Threads (persistent conversations, spec §5) ─────────────────────────
    const loadConversations = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[loadConversations]": async (q)=>{
            setConversationsLoading(true);
            try {
                const url = `/api/conversations?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`;
                const res = await fetch(url, {
                    cache: 'no-store'
                });
                const data = await res.json().catch({
                    "useTranslator.useCallback[loadConversations]": ()=>null
                }["useTranslator.useCallback[loadConversations]"]);
                setConversations(Array.isArray(data?.conversations) ? data.conversations : []);
            } catch  {
                setConversations([]);
            } finally{
                setConversationsLoading(false);
            }
        }
    }["useTranslator.useCallback[loadConversations]"], []);
    /**
   * Open a thread: load its messages + sessions and apply its settings
   * overrides on top of the current globals (snapshot for restore on close —
   * a thread must never permanently mutate global defaults, spec §4.2).
   */ const openThread = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[openThread]": async (id)=>{
            setThreadLoading(true);
            try {
                const res = await fetch(`/api/conversations/${id}`, {
                    cache: 'no-store'
                });
                if (!res.ok) throw new Error('Thread not found');
                const data = await res.json();
                // Snapshot current settings once per open (not per refresh).
                if (activeThreadIdRef.current !== id) {
                    settingsSnapshotRef.current = {
                        mode: modeRef.current,
                        otherLang: otherLangRef.current,
                        style: styleRef.current,
                        voiceMode: voiceModeRef.current,
                        playbackRate: playbackRateRef.current,
                        bigButton: bigButtonRef.current
                    };
                }
                activeThreadIdRef.current = id;
                setActiveThread(data);
                // ── Speaker registry continuity (spec v2 §12/§17): seed the live
                // tracker with this conversation's stored clusters so ids stay stable
                // across sessions, and prefill the local name map.
                if (Array.isArray(data.speakers) && data.speakers.length > 0) {
                    const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
                    socket.emit('speakers:seed', {
                        clusters: data.speakers.map({
                            "useTranslator.useCallback[openThread]": (s)=>({
                                    clusterKey: s.clusterKey,
                                    contactId: s.contactId,
                                    name: s.displayName,
                                    vector: s.vector
                                })
                        }["useTranslator.useCallback[openThread]"])
                    });
                    setSpeakers({
                        "useTranslator.useCallback[openThread]": (prev)=>{
                            const next = {
                                ...prev
                            };
                            for (const s of data.speakers){
                                if (!next[s.clusterKey]) {
                                    next[s.clusterKey] = {
                                        clusterKey: s.clusterKey,
                                        contactId: s.contactId ?? undefined,
                                        name: s.displayName ?? undefined,
                                        status: s.contactId ? 'verified' : 'unknown'
                                    };
                                }
                            }
                            return next;
                        }
                    }["useTranslator.useCallback[openThread]"]);
                }
                const o = data.conversation.overrides;
                if (o) {
                    if (o.mode) setMode(o.mode);
                    if (o.otherLang) setOtherLang(o.otherLang);
                    if (o.style) setStyle(o.style);
                    if (o.voiceMode) setVoiceMode(o.voiceMode);
                    if (typeof o.playbackRate === 'number') setPlaybackRate(o.playbackRate);
                    if (typeof o.bigButton === 'boolean') setBigButton(o.bigButton);
                    // Per-thread voice profile: an unknown/stale id falls back to the
                    // global active profile (never blocks translation).
                    threadProfileIdRef.current = typeof o.profileId === 'string' ? o.profileId : null;
                    setThreadProfileId(threadProfileIdRef.current);
                } else {
                    threadProfileIdRef.current = null;
                    setThreadProfileId(null);
                }
                return true;
            } catch (err) {
                toast({
                    title: 'Could not open conversation',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive'
                });
                return false;
            } finally{
                setThreadLoading(false);
            }
        }
    }["useTranslator.useCallback[openThread]"], [
        setBigButton,
        setMode,
        setOtherLang,
        setPlaybackRate,
        setStyle,
        setVoiceMode,
        toast
    ]);
    /** Close the thread, end any live session in it, restore global settings. */ const closeThread = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[closeThread]": ()=>{
            const sess = threadSessionRef.current;
            if (sess) {
                void fetch(`/api/conversations/${sess.conversationId}/sessions`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        sessionId: sess.sessionId,
                        status: 'ended'
                    })
                }).catch({
                    "useTranslator.useCallback[closeThread]": ()=>{}
                }["useTranslator.useCallback[closeThread]"]);
                threadSessionRef.current = null;
                setThreadSession(null);
            }
            const snap = settingsSnapshotRef.current;
            if (snap) {
                setMode(snap.mode);
                setOtherLang(snap.otherLang);
                setStyle(snap.style);
                setVoiceMode(snap.voiceMode);
                setPlaybackRate(snap.playbackRate);
                setBigButton(snap.bigButton);
                settingsSnapshotRef.current = null;
            }
            threadProfileIdRef.current = null;
            setThreadProfileId(null);
            activeThreadIdRef.current = null;
            setActiveThread(null);
            persistSpeakerRegistry();
            void loadConversations();
        }
    }["useTranslator.useCallback[closeThread]"], [
        loadConversations,
        persistSpeakerRegistry,
        setBigButton,
        setMode,
        setOtherLang,
        setPlaybackRate,
        setStyle,
        setVoiceMode
    ]);
    const createConversation = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[createConversation]": async (title)=>{
            try {
                const res = await fetch('/api/conversations', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        title: title?.trim() || undefined
                    })
                });
                const data = await res.json().catch({
                    "useTranslator.useCallback[createConversation]": ()=>null
                }["useTranslator.useCallback[createConversation]"]);
                if (!res.ok || !data?.conversation) throw new Error(data?.error ?? 'Request failed');
                const conv = data.conversation;
                setConversations({
                    "useTranslator.useCallback[createConversation]": (prev)=>prev ? [
                            conv,
                            ...prev
                        ] : prev
                }["useTranslator.useCallback[createConversation]"]);
                await openThread(conv.id);
                return conv.id;
            } catch (err) {
                toast({
                    title: 'Could not create conversation',
                    description: err instanceof Error ? err.message : undefined,
                    variant: 'destructive'
                });
                return null;
            }
        }
    }["useTranslator.useCallback[createConversation]"], [
        openThread,
        toast
    ]);
    const renameConversation = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[renameConversation]": async (id, title)=>{
            const clean = title.trim().slice(0, 120);
            if (!clean) return false;
            // Optimistic rename
            setActiveThread({
                "useTranslator.useCallback[renameConversation]": (prev)=>prev && prev.conversation.id === id ? {
                        ...prev,
                        conversation: {
                            ...prev.conversation,
                            title: clean
                        }
                    } : prev
            }["useTranslator.useCallback[renameConversation]"]);
            setConversations({
                "useTranslator.useCallback[renameConversation]": (prev)=>prev?.map({
                        "useTranslator.useCallback[renameConversation]": (c)=>c.id === id ? {
                                ...c,
                                title: clean
                            } : c
                    }["useTranslator.useCallback[renameConversation]"]) ?? prev
            }["useTranslator.useCallback[renameConversation]"]);
            try {
                const res = await fetch(`/api/conversations/${id}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        title: clean
                    })
                });
                if (!res.ok) throw new Error(String(res.status));
                return true;
            } catch  {
                toast({
                    title: 'Could not rename conversation',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[renameConversation]"], [
        toast
    ]);
    const deleteConversation = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[deleteConversation]": async (id)=>{
            try {
                const res = await fetch(`/api/conversations/${id}`, {
                    method: 'DELETE'
                });
                if (!res.ok) throw new Error(String(res.status));
                setConversations({
                    "useTranslator.useCallback[deleteConversation]": (prev)=>prev ? prev.filter({
                            "useTranslator.useCallback[deleteConversation]": (c)=>c.id !== id
                        }["useTranslator.useCallback[deleteConversation]"]) : prev
                }["useTranslator.useCallback[deleteConversation]"]);
                if (activeThreadIdRef.current === id) {
                    // Reuse closeThread's session teardown but keep the restored settings.
                    const sess = threadSessionRef.current;
                    if (sess && sess.conversationId === id) {
                        threadSessionRef.current = null;
                        setThreadSession(null);
                    }
                    activeThreadIdRef.current = null;
                    setActiveThread(null);
                    settingsSnapshotRef.current = null;
                }
                toast({
                    title: 'Conversation deleted'
                });
                return true;
            } catch  {
                toast({
                    title: 'Could not delete conversation',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[deleteConversation]"], [
        toast
    ]);
    /**
   * Persist thread settings overrides. Keys absent from `overrides` are
   * removed (undefined) or reset wholesale with `null` (inherit global).
   */ const saveThreadOverrides = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[saveThreadOverrides]": async (overrides)=>{
            const id = activeThreadIdRef.current;
            if (!id) return false;
            setActiveThread({
                "useTranslator.useCallback[saveThreadOverrides]": (prev)=>prev && prev.conversation.id === id ? {
                        ...prev,
                        conversation: {
                            ...prev.conversation,
                            overrides
                        }
                    } : prev
            }["useTranslator.useCallback[saveThreadOverrides]"]);
            try {
                const res = await fetch(`/api/conversations/${id}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        overrides
                    })
                });
                if (!res.ok) throw new Error(String(res.status));
                return true;
            } catch  {
                toast({
                    title: 'Could not save thread settings',
                    variant: 'destructive'
                });
                return false;
            }
        }
    }["useTranslator.useCallback[saveThreadOverrides]"], [
        toast
    ]);
    /**
   * Retry the last failed segment with the exact same payload (spec §7:
   * "Allow the user to retry the failed segment"). Completed phrases are
   * untouched — only the failed one is re-sent.
   */ const retryFailed = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[retryFailed]": ()=>{
            const err = lastError;
            if (!err?.payload) return false;
            const socket = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$realtime$2f$socket$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getTranslatorSocket"])();
            socket.emit(err.payload.kind === 'text' ? 'translate:text' : 'utterance', err.payload.data);
            if (err.payload.kind === 'audio') setPendingCount({
                "useTranslator.useCallback[retryFailed]": (c)=>c + 1
            }["useTranslator.useCallback[retryFailed]"]);
            setLastError(null);
            return true;
        }
    }["useTranslator.useCallback[retryFailed]"], [
        lastError
    ]);
    const clearError = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[clearError]": ()=>setLastError(null)
    }["useTranslator.useCallback[clearError]"], []);
    // ── Sharing (Web Share API with clipboard fallback) ───────────────────
    /**
   * Share the latest translation — prefers native share with the WAV file,
   * falls back to text-only share, then to clipboard copy on desktop browsers
   * without the Web Share API.
   */ const shareTranslation = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[shareTranslation]": async (utteranceId, label, text)=>{
            if (!text) return false;
            const file = wavFileFromBase64(audioCacheRef.current.get(utteranceId), `${slugify(label) || 'translation'}.wav`);
            return shareOrCopy(text, file, toast);
        }
    }["useTranslator.useCallback[shareTranslation]"], [
        toast
    ]);
    /** Share a saved-history phrase (audio fetched from the server cache). */ const shareSaved = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useTranslator.useCallback[shareSaved]": async (entryId, label, text, hasAudio)=>{
            if (!text) return false;
            let file = null;
            if (hasAudio) {
                try {
                    const res = await fetch(`/api/history/${entryId}/audio`);
                    if (res.ok) {
                        const blob = await res.blob();
                        file = new File([
                            blob
                        ], `${slugify(label) || 'translation'}.wav`, {
                            type: 'audio/wav'
                        });
                    }
                } catch  {
                    file = null; // audio is optional — share text only
                }
            }
            return shareOrCopy(text, file, toast);
        }
    }["useTranslator.useCallback[shareSaved]"], [
        toast
    ]);
    // Cleanup on unmount
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useTranslator.useEffect": ()=>{
            return ({
                "useTranslator.useEffect": ()=>{
                    const recorder = recorderRef.current;
                    if (recorder) void recorder.stop();
                    recorderRef.current = null;
                    if (partialTimeoutRef.current !== null) window.clearTimeout(partialTimeoutRef.current);
                    if (echoTailRef.current !== null) window.clearTimeout(echoTailRef.current);
                }
            })["useTranslator.useEffect"];
        }
    }["useTranslator.useEffect"], []);
    return {
        // state
        status,
        connected,
        activeStage,
        level,
        transcript,
        profile,
        profiles,
        profileLoading,
        // voice identity capabilities (honest clone availability + setup steps)
        capabilities,
        threadProfileId,
        effectiveVoiceProfile,
        style,
        voiceMode,
        mode,
        otherLang,
        playbackRate,
        playbackActive,
        bigButton,
        langPair,
        partial,
        liveCaption,
        pendingCount,
        sessionSpeechMs,
        sessionLangs,
        stats,
        lastError,
        autoSaveHistory,
        useContext,
        showCaptions,
        // UI customization prefs (spec §4.4)
        uiPrefs,
        // actions
        start,
        stop,
        setStyle,
        setVoiceMode,
        setMode,
        setOtherLang,
        setPlaybackRate,
        setBigButton,
        setTextSize,
        setCompact,
        setShowTranscript,
        setAutoSaveHistory,
        setUseContext,
        setShowCaptions,
        translateText,
        pushToTalk,
        replay,
        downloadAudio,
        shareTranslation,
        shareSaved,
        createProfile,
        selectProfile,
        renameProfile,
        deleteProfile,
        updateCloneSettings,
        clearTranscript,
        retryFailed,
        clearError,
        // history
        history,
        historyLoading,
        historyCursor,
        loadHistory,
        loadMoreHistory,
        clearHistory,
        toggleStar,
        deleteHistoryEntry,
        // interpreter / auto direction (real bidirectional + manual speaker turns)
        autoDetect,
        setAutoDetect,
        speaker,
        setSpeaker,
        availableOtherLangs,
        betaLangs,
        setBetaLangs,
        historyRetentionDays,
        setHistoryRetentionDays,
        // threads (persistent conversations, spec §5)
        conversations,
        conversationsLoading,
        activeThread,
        threadLoading,
        threadSession,
        loadConversations,
        openThread,
        closeThread,
        createConversation,
        renameConversation,
        deleteConversation,
        saveThreadOverrides,
        // ── Voice Contacts + speaker recognition (master prompt v2) ────────────
        contacts,
        contactsLoading,
        loadContacts,
        createContact,
        updateContact,
        deleteContact,
        reenrollContact,
        speakers,
        identify,
        startIdentify,
        cancelIdentify,
        confirmIdentify,
        confirmCandidate,
        keepUnknown,
        correctSpeaker,
        // ── Provider routing / health (v2 §30/§31) ─────────────────────────────
        providerHealth,
        requestProviderHealth,
        reloadProviders,
        lastProviders,
        // ── v3: AUTO speaker detection + routing policy + realtime events ──────
        detectionMode,
        setDetectionMode,
        routingPolicy,
        setRoutingPolicy,
        realtimeEvents
    };
}
_s(useTranslator, "y1P8NFJSXEyF+hulvLBlqeIWgUU=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$toast$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useToast"]
    ];
});
/** Filename-safe slug from arbitrary text (translation label), max 40 chars. */ function slugify(text) {
    if (!text) return '';
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}
/** WAV File from base64 (null when audio is missing/undecodable). */ function wavFileFromBase64(base64, filename) {
    if (!base64) return null;
    try {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++)bytes[i] = bin.charCodeAt(i);
        return new File([
            bytes
        ], filename, {
            type: 'audio/wav'
        });
    } catch  {
        return null;
    }
}
/** Native share (files → text) with clipboard fallback. Returns the outcome. */ async function shareOrCopy(text, file, toast) {
    try {
        const nav = navigator;
        if (file && nav.canShare?.({
            files: [
                file
            ]
        })) {
            await nav.share({
                files: [
                    file
                ],
                text,
                title: 'Live Voice Translator'
            });
            return true;
        }
        if (typeof nav.share === 'function') {
            await nav.share({
                title: 'Live Voice Translator',
                text
            });
            return true;
        }
        await navigator.clipboard.writeText(text);
        toast({
            title: 'Copied to clipboard',
            description: 'Native sharing is not available in this browser — the translation was copied instead.'
        });
        return true;
    } catch (err) {
        // User dismissed the share sheet — not an error.
        if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return false;
        toast({
            title: 'Share failed',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive'
        });
        return false;
    }
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/hooks/use-wake-lock.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "useWakeLock",
    ()=>useWakeLock
]);
// ─────────────────────────────────────────────────────────────────────────────
// useWakeLock — keeps the phone screen awake while a live translation session
// is running (the user is speaking, not touching the screen). Uses the
// Screen Wake Lock API when available; silently no-ops elsewhere.
// ─────────────────────────────────────────────────────────────────────────────
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var _s = __turbopack_context__.k.signature();
'use client';
;
function useWakeLock(active) {
    _s();
    const [held, setHeld] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const sentinelRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const release = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useWakeLock.useCallback[release]": async ()=>{
            const sentinel = sentinelRef.current;
            sentinelRef.current = null;
            setHeld(false);
            if (sentinel && !sentinel.released) {
                try {
                    await sentinel.release();
                } catch  {
                // already released
                }
            }
        }
    }["useWakeLock.useCallback[release]"], []);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useWakeLock.useEffect": ()=>{
            const nav = navigator;
            if (!nav.wakeLock || !active) {
                // Defer release to a macrotask so no setState runs synchronously in the effect body
                const timer = window.setTimeout({
                    "useWakeLock.useEffect.timer": ()=>void release()
                }["useWakeLock.useEffect.timer"], 0);
                return ({
                    "useWakeLock.useEffect": ()=>window.clearTimeout(timer)
                })["useWakeLock.useEffect"];
            }
            let cancelled = false;
            const acquire = {
                "useWakeLock.useEffect.acquire": async ()=>{
                    try {
                        const sentinel = await nav.wakeLock.request('screen');
                        if (cancelled) {
                            void sentinel.release();
                            return;
                        }
                        sentinelRef.current = sentinel;
                        setHeld(true);
                        // Re-acquire automatically when visibility returns (mobile OS behavior)
                        sentinel.addEventListener('release', {
                            "useWakeLock.useEffect.acquire": ()=>{
                                if (sentinelRef.current === sentinel) {
                                    sentinelRef.current = null;
                                    setHeld(false);
                                }
                            }
                        }["useWakeLock.useEffect.acquire"]);
                    } catch  {
                    // Permission denied / unsupported — not critical
                    }
                }
            }["useWakeLock.useEffect.acquire"];
            const onVisible = {
                "useWakeLock.useEffect.onVisible": ()=>{
                    if (document.visibilityState === 'visible' && !sentinelRef.current) void acquire();
                }
            }["useWakeLock.useEffect.onVisible"];
            void acquire();
            document.addEventListener('visibilitychange', onVisible);
            return ({
                "useWakeLock.useEffect": ()=>{
                    cancelled = true;
                    document.removeEventListener('visibilitychange', onVisible);
                    void release();
                }
            })["useWakeLock.useEffect"];
        }
    }["useWakeLock.useEffect"], [
        active,
        release
    ]);
    return held;
}
_s(useWakeLock, "Qy3iLPFu3vlw7EZ/RxJcNhk7HNU=");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_hooks_bef689a3._.js.map