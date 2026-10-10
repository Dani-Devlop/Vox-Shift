# Changelog

## v3.5.0 — Local-first voice cloning priority chain + ASR policy registry
- **Voice cloning priority chain (local-first)**: clone profiles are now served by the first AVAILABLE engine in a real priority chain — **Fish Speech → F5-TTS → Chatterbox → ElevenLabs IVC (cloud) → pitch-conformed match (local DSP)**. New shared detector (`src/lib/voice/clone-chain.ts`) probes each local engine with REAL gates: python package import, model weights on disk (env overrides `VOXSHIFT_FISH_WEIGHTS` / `VOXSHIFT_F5_WEIGHTS` / `VOXSHIFT_CHATTERBOX_WEIGHTS` or well-known locations), and a per-engine RAM floor (Fish 2.6 GB, F5 4.2 GB, Chatterbox 2.6 GB) — the same honest-refusal philosophy as the whisper worker's 350 MB guard. 30 s detection cache + invalidation.
- **Synthesis-time failover with an honest trail**: every engine attempt inside the chain is recorded (`cloneAttempts`); a local engine that fails mid-synthesis falls through to the next level; the result carries the ACTUAL engine id (`fish-speech` / `f5-tts` / `chatterbox` / `elevenlabs-ivc` / `pitch-conformed`) and `degraded: true` when the terminal DSP level served a clone profile — the UI/telemetry label it as NOT a clone, never silently. Enrollment-incomplete profiles still refuse honestly (no reference → nothing to clone).
- **Local zero-shot engines wired**: `engines/clone-tts-worker.py` (one-shot JSON-stdout adapter for f5_tts.api / chatterbox.tts / fish_speech surfaces) + `engines/clone-workers.ts` (spawn, reference-WAV resolution `db/audio/clone-ref/{providerProfileId}.wav` — cloud enrollment now ALSO persists the first take so previously enrolled profiles can be served by local engines if they appear).
- **Provider health truth**: the Setup chain view replaces the hardcoded "local:voice-cloning NOT_CONFIGURED" row with per-engine rows from the live detector (package/weights/RAM/key gates) + an "Active clone engine" summary row.
- **ASR language policy registry**: `local-asr.ts` is now registry-driven — `ASR_LANGUAGE_POLICIES` + `registerASRLanguage()` (add a language = register a model path + primary engine; no core branch changes). fa→vosk-small / en→faster-whisper-tiny→vosk behavior unchanged; RAM guard, lazy spawn and 4-min idle unload preserved; policy declares its benchmark justification (surfaced in docs).
- **About page v3.5.0**: new "Engine chains" section (ASR registry policy / translation gtx chain / TTS piper chain), new LIVE "Voice cloning priority chain" section (per-level gates + ACTIVE badge), self-test clone stage probes the ACTIVE chain engine, stale v2.2.0-era wording removed, version now read from the server.
- **Honest self-test semantics**: the clone stage reports the ACTIVE engine — real ElevenLabs account probe when cloud is active, chain detail when a local engine resolves, and an explicit "terminal pitch-conformed level serving (labeled not-a-clone)" state when nothing better is configured.

## v3.4.0 — Model benchmark round: faster-whisper EN local ASR + benchmark-documented chain
- **ASR upgrade (en)**: integrated `faster-whisper tiny` (CTranslate2 int8) as the English local ASR engine — RTF 0.08 with punctuation/casing vs vosk-en RTF 0.22 without. Resident warm worker (`engines/whisper-worker.py`, piper-worker protocol), 75 MB model bundled (`whisper-tiny-ct2/`) so no runtime download is needed, lazy spawn on first English failover-ASR demand, refuses to spawn under 350 MB free RAM, unloads after 4 idle minutes. Persian stays on vosk small (whisper tiny/base garble fa, RTF ≥ 1.0 — measured).
- **Benchmark table in README**: full 2026-10 evaluation of trending HF candidates per leg (ASR / translation / TTS / voice cloning) with measured numbers and honest verdicts — Kokoro-82M rejected for the realtime loop (8× slower than piper), opus-mt finetune rejected (degenerate repetition), NLLB-600M rejected on the 954 MB container budget, Chatterbox/Fish/F5-TTS rejected on RAM/RTF, keyless gtx confirmed near-perfect on the fa→en test set.
- Runtime detection (`local:whisper-asr`) now accepts faster-whisper (python import probe) in addition to the original whisper.cpp path.
- Repo page: full README rewrite (feature tour, failover chain, realtime API table, deploy guide), `.env.example` added, About/description + topics updated.

## v2.2.0 — Voice Contacts, Unknown-Speaker Enrollment & Multi-Provider Routing
Implemented per the uploaded **FINAL MASTER IMPLEMENTATION PROMPT v2** (`updateV2.2.txt`).

### Voice Contacts — persistent speaker recognition (local-first)
- **New VoiceContact storage** (SQLite): name, 57-dim voiceprint, reference audio
  (`db/audio/contacts/`, gitignored), quality metrics, per-contact threshold,
  match statistics, pause-recognition flag, explicit consent timestamp.
- **Local DSP voiceprint engine** (`src/lib/speaker/voiceprint.ts`): radix-2 FFT →
  24 mean-centered log-mel band means + 24 mel std-devs + 8-band log-F0 kernel
  signature + dynamics; L2-normalized, cosine matching. Zero dependencies, zero
  cloud, milliseconds per utterance. Validated on real speech: same voice across
  different sentences 0.94–0.99 similarity, different voices 0.76–0.89.
- **Real-time speaker tracking** (per live session): hysteresis stability,
  short-utterance context rule (بله/نه never creates a phantom speaker),
  stable temporary ids (`spk_001…`) that never randomly rename, per-contact
  confidence thresholds, ambiguous-match detection (never silently choose).
- **Unknown-speaker enrollment (spec §5–§9)**: the engine keeps bounded clean
  speech per unknown cluster; "Identify" assembles the ~10 s sample, the dialog
  plays it back for verification, the user names the person, the contact is
  saved and the transcript retroactively renames every entry.
- **Future automatic recognition**: contacts sync to the recognizer on connect
  (`contacts:sync`) and conversations seed prior clusters (`speakers:seed`),
  so identified people are named in future sessions and ids stay stable across
  app restarts (`ConversationSpeaker` registry).

### Voice Contacts UI (new 6th destination)
- Add / rename / delete (explicit confirm) / pause recognition / re-enroll
  (merge or replace voiceprints) / play reference recording / measured
  recognition stats (real numbers only) / quality disclosure.

### Multi-provider router (spec §22–§24, §30–§31)
- User-registered **OpenAI-compatible** endpoints for ASR / translation / TTS,
  tried in priority order **before** the built-ins with **automatic failover**;
  every result records the ACTUAL provider used per stage.
- API keys are **AES-256-GCM encrypted at rest**, never returned to the client
  (masked hint only), never logged. Real per-provider connection tests with
  honest error codes (AUTH / RATE_LIMIT / NETWORK / PROVIDER_5XX…).
- Provider health states (READY / RATE_LIMITED / INVALID_KEY / OFFLINE /
  COOLDOWN…) exposed over the socket and rendered in Settings; failing
  providers enter an exponential cooldown and get one final retry before the
  built-in fallback.

### Self-test & diagnostics
- New REAL self-test stage: speaker engine separation (self vs cross-voice
  similarity measured live); provider status rows now include local speaker
  recognition; per-message provider attribution surfaces in results.

### Honest capability reporting
- The UI/About disclose that recognition is a lightweight DSP voiceprint (not a
  neural x-vector): different people separate reliably; near-identical voices
  or heavy noise stay honestly Unknown — **Unknown is better than wrong**.

### v1.2.0 (previous)
- Real bidirectional interpreter engine (AUTO detect + translate in one call),
  manual Speaker A/B for two-person conversations, per-thread voice profiles,
  multi-take enrollment, real self-test with stable error codes, threads
  lifecycle, retention policy, GitHub Pages static demo.

## v1.1.0 — Real Voice Cloning (ElevenLabs IVC)
- Genuine cross-language Instant Voice Cloning when `ELEVENLABS_API_KEY` is
  configured; honest pitch-conformed match mode otherwise (never labeled a
  clone). Cloned profiles drive every translation's audio.

## v1.0.0 — Functional Voice Identity + 5-view app shell
- Pitch-conformed voice identity, navigation shell, settings center with
  data/privacy, sessions browser, diagnostics + self-test, echo guard.
