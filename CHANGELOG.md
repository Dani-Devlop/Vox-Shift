# Changelog — VoxShift

## 1.1.0 — Real Voice Cloning (ElevenLabs IVC)

Implements the "Fix and Upgrade Voice Identity" task: recording your voice now
drives a REAL cross-language cloning provider, not just an estimated match.

### Real voice cloning (the headline fix)
- **Provider**: ElevenLabs Instant Voice Cloning, integrated server-side only
  (`ELEVENLABS_API_KEY`). Cross-language by design: a Persian reference sample
  yields English speech with the speaker's timbre, pitch register and style.
- **Root cause of the old complaint fixed**: the pipeline routed synthesis by
  profile `mode` through a new `VoiceIdentityEngine` router — `clone` goes to
  the cloning engine and NEVER silently falls back to a preset voice; failures
  surface as pipeline errors with exact provider messages while the text
  result still reaches the UI.
- **Enrollment**: record (15 s) → REVIEW (real-PCM waveform + replay +
  re-record) → submit → honest stage tracker incl. real "Provider enrollment /
  confirmation" stages. Min 8 s for clones; provider errors returned verbatim
  (verified end-to-end: an invalid key produces the genuine ElevenLabs 401
  message and NO profile is created).
- **Persistent profiles**: stored in SQLite with provider voice id, model and
  stability; deleting a profile deletes the provider clone (best-effort, with
  the deletion result reported). `?verify=1` genuinely checks cloned voices
  still exist at the provider.
- **Advanced settings**: per-profile cloning model (Balanced turbo v2.5 /
  Quality multilingual v2) and stability slider — both persisted and applied
  to every synthesis + preview.

### Honest UX everywhere
- Voice Identity page shows the credential status banner with the exact setup
  steps when cloning is not configured; profiles are badged `REAL VOICE
  CLONE` vs `PITCH-CONFORMED MATCH`; similarity is an explicitly ESTIMATED
  band (Good/Fair/Limited) from measurable sample properties — never a fake
  percentage.
- "Test my voice" and Voice A/B now audition the real enrolled voice via
  `profileId` (clone leg = provider voice), on the Voice page and on every
  real translation.
- Consent text adapts: cloning discloses the sample upload + deletion
  behavior; voice-match keeps the in-memory-only promise.

### Per-thread voice profiles
- Threads can pick their own profile (Thread settings → Voice profile) without
  touching the global default; the pipeline label and payloads follow the
  thread override and the global profile is restored on close (verified E2E).

### Diagnostics
- `voiceClone` provider row in About · Diagnostics (CONFIGURED/MISSING, no
  secrets) + self-test stage that pings the provider when configured.


## 1.0.0 — Functional Demo Release

The upgrade from the 0.x MVP to the cohesive v1.0.0 demo, implemented against the
"Vox Shift — Master Engineering Prompt" specification.

### Voice Identity (spec §5) — now genuinely functional
- **Pitch conformance**: the enrollment sample's measured F0 drives a real
  pitch shift of the synthesized output (TTS speed compensation + WAV
  resampling in the voice engine). Recording a sample now audibly changes the
  generated audio — beyond the previous static closest-voice mapping.
- **Multiple voice profiles**: enroll up to 8 profiles, rename, set default,
  delete individually. Profile selection feeds the live pipeline.
- **Sample-quality feedback**: clipping ratio and signal-to-noise estimate
  reported at enrollment with honest warnings.
- **Honest disclosure**: everywhere the identity feature appears it is labeled
  "pitch-conformed match" — an estimated match, never claimed to be a clone.
- A/B compare (both on the preview line and on real translated content) now
  plays the pitch-conformed audio on leg A.

### Application navigation (spec §4)
- Five functional destinations — Translate · Sessions · Voice Identity ·
  Settings · About/Diagnostics — via a left rail on desktop and a bottom
  navigation bar on mobile; the active view syncs to the URL hash.
- Recognizable settings gear in the main interface header.

### Settings center (spec §6–7)
- Dedicated Settings view: Translation (direction, other language, 5 styles,
  conversation-context toggle, live-captions toggle), Voice (output voice +
  profile selector, playback speed), Interface (text size, compact layout,
  transcript visibility, big-button mode), Data & privacy (auto-save toggle,
  retention policy disclosure, clear-all with confirmation), Reset to
  defaults with confirmation.
- All settings persist (localStorage + server preferences) and survive
  reloads; global defaults apply to new threads while thread overrides remain
  isolated (0.2.0 behavior preserved).

### Sessions & history (spec §8)
- Sessions view: thread cards with language pair, message/session counts,
  override badge and activity date; server-side search across titles and
  transcripts; create / open / rename / delete; opening a thread jumps to the
  live workspace with its overrides applied.
- Conversation persistence and resumable sessions (from 0.2.0) preserved.

### Live behavior & reliability (spec §9–10)
- **Playback echo-guard**: while synthesized audio plays, the microphone VAD
  is frozen (with a short release tail) so the translated voice is never
  re-recognized as new user speech.
- Context retention off = every phrase translates standalone.

### Diagnostics & release (spec §14–16)
- About · Diagnostics view: version, provider configuration status (booleans
  only — no secrets), database + realtime transport status, and a live
  pipeline self-test reporting measured per-stage latency (LLM, TTS).
- `/api/diagnostics` GET (status) and POST (self-test).
- `.env.example`, this changelog, version metadata v1.0.0.

## 0.2.1
- Robustness fixes for provider rate-limiting (429) with retry + recovery.

## 0.2.0 — Engineering Upgrade Specification v0.2.0
- Honest Voice Match identity (consent + disclosure), persistent global
  preferences + per-thread overrides, persistent resumable threads
  (Conversation / Session / Message), 5 translation styles incl. formal
  Persian register, failed-segment retry, anonymous cookie identity, history
  phrasebook (star / search / filter / export / re-run), session-grouped
  history, voice A/B compare, live captions, big-button talk mode, keyboard
  shortcuts (Space PTT, R replay, ? help).

## 0.1.0 — MVP
- Real-time Persian → English voice translation with mapped voice identity,
  3 styles, VAD segmentation, latency telemetry, dark console UI.
