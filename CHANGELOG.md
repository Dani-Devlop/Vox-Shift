# Changelog

## v3.7.0 — Fish Speech + F5-TTS run for real; honest cgroup-aware RAM probe
- **Both lead local clone engines verified by measurement (the "least 2 models should work" round)**: `clone-tts-worker.py` now drives the **official fish-speech v1.5.0 local surface** (`tools.inference_engine.TTSInferenceEngine` = llama_queue + firefly-gan VQ decoder, zero-shot from a reference WAV + transcript) instead of the speculative `FishSpeechTTS` probe that no release ever exposed. Measured on a 2-core CPU host: **fish-speech peak RSS 2306 MB, 3.4 s audio in ~57 s cold** · **f5-tts peak RSS 2875 MB, 3.4 s audio in ~150 s cold**. Both produce real WAV through the JSON-stdout worker contract.
- **Honest cgroup-aware RAM probe (the "1 GB of a 500 GB shared host" question, answered in the UI)**: `ramProbe()` in `src/lib/voice/clone-chain.ts` now reads the **cgroup memory limit** (v2 `memory.max` / v1 `limit_in_bytes`) alongside `/proc/meminfo`. On shared platforms meminfo describes the HOST (hundreds of GB shared by all projects) while the cgroup caps this container at its own slice — when the two disagree, usable RAM is capped at the cgroup limit so the gates never promise memory the platform will OOM-kill, and the detection notes it in plain words ("host reports X MB free, but this container is cgroup-capped to Y MB — the platform slice is what binds"). When meminfo is already cgroup-scoped (lxcfs-style) it is trusted as-is. New **`VOXSHIFT_RAM_BUDGET_MB` operator override** wins outright for hosts where the operator knows better; `VOXSHIFT_TEST_RAM_MB` stays the test hook. The About page renders the whole picture: usable MB + source (override / container-scoped / cgroup-capped slice of a bigger host) + cgroup cap + host meminfo numbers.
- **Floors calibrated from measurement, not GPU docs**: F5-TTS floor 4200 → **2900 MB** (measured CPU peak 2875 MB across two real runs); Fish stays 2600 MB (measured 2306 MB). A 4 GB-cgroup dev box now genuinely passes Fish and (barely) F5 — proven by real synthesis, not by configuration.
- **Reference transcripts plumbed end-to-end**: fish + f5 both condition on the reference text (and f5's empty-text path pulls a whisper model mid-flight). Enrollment references now support a `.txt` sibling (`db/audio/clone-ref/{id}.txt`) or `VOXSHIFT_CLONE_REF_TEXT`; `localCloneSynthesize` passes it to the worker (new optional argv). Worker timeout default 120 s → **300 s** (the measured f5 cold path is ~150 s — the old default killed cold calls mid-vocoder).
- **`scripts/setup-local-clone.sh`**: one-shot installer for any host that can afford the engines — CPU torch 2.8 pair (2.9+ hard-requires torchcodec + ffmpeg system libs), f5-tts pip, fish-speech v1.5.0 checkout + minimal inference dep set (deliberately NOT `pip install -e .`, whose `torch<=2.4.1` pin would downgrade the shared runtime) + weights via HF. Run it after raising the platform memory and the SAME priority chain picks the locals up with zero code change.
- **Torch stack pin rationale**: torchaudio 2.8 keeps the soundfile backend; torchaudio 2.9+ requires torchcodec (which needs ffmpeg shared libraries most minimal containers lack) — the stack is pinned to `torch==2.8.0 + torchaudio==2.8.0` (CPU wheels) in the installer docs.
- **About page v3.7.0**: new "Usable RAM for new model loads" panel under the cloning chain (usable MB, source, cgroup cap, host meminfo free/total, plain-language note), floors shown as "usable", version-driven label bumped.

## v3.6.0 — ASR code-switching & language detection fix, speaker recognition v2, working "Test my voice"
- **ASR-layer language detection (fixes "English detected as Persian")**: in AUTO mode the old code transcribed EVERY utterance with the Persian vosk model (`autoPair[0]`), so English audio was garbled into fake Persian. `localASR()` now accepts `auto` and runs a **dual-engine pass** — vosk-fa and the resident multilingual faster-whisper (auto-detect, word timestamps) in parallel — and the whisper side decides: English utterances return the whisper transcript directly.
- **Code-switching merge (Persian sentences with embedded English words)**: both engines now emit word-level timestamps (vosk `SetWords(True)`, faster-whisper `word_timestamps`). New time-aligned merge (`mergeWords`) keeps Persian words from vosk (measurably better) and takes embedded Latin-script words from whisper (vosk drops them entirely); `scriptForLang` + the policy's `codeSwitchWith` field keep it registry-driven — adding a language = registering its partner, no core branches.
- **English accent robustness**: whisper decoding upgraded from `beam_size=1` to `beam_size=2` + `vad_filter=True` + `condition_on_previous_text=False` — steadier across accents at an RTF cost that stays under 0.15 for utterance-length clips.
- **Speaker recognition v2 (fixes "all voices are identified as the user's voice")**: contact matching now runs BEFORE hysteresis/context, so an enrolled contact (or their short "بله") is never swallowed into the previous speaker's cluster; hysteresis must additionally beat every other cluster by a margin (same-gender voices stop merging); weak short utterances keep the previous cluster but honestly refuse to borrow its name — the UI shows a neutral **"Unknown Speaker N"** (renamed from "Unknown N") with the one-tap Identify Person action.
- **"Test my voice" works without any z-ai config**: the translator service gained a loopback REST endpoint (`127.0.0.1:3004`, `POST /preview-voice` + `/healthz`) that runs the FULL synthesis chains (clone chain / routed piper TTS / pitch-conform) for `/api/voice-preview`. The old code called the built-in z-ai SDK directly and threw `configuration file not found or invalid …` on deployments without `/etc/.z-ai-config` — previews now work with ONLY local engines, with verbatim chain errors and honest fallbacks when the service is down.
- **Honest self-test semantics**: self-test stages that fail because the built-in z-ai engine is unconfigured (no `.z-ai-config`) are now labeled `unconfigured / BUILTIN_NOT_CONFIGURED` with an actionable message instead of `fail` — they never were pipeline failures.
- **About page v3.6.0**: ASR chain shows the dual-run + code-switch merge + accent robustness; new Speaker recognition chain row (contacts-before-context, Unknown Speaker clusters); version-driven label updated.

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
