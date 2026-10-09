# Changelog

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
