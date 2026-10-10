# VoxShift — Live Speech Translation, In Your Own Voice

**Live demo (GitHub Pages, static UI):** <https://dani-devlop.github.io/Vox-Shift/>
**Production reference deployment:** <https://voxshift134.up.railway.app/>

> The Pages deployment is a **static demo** — the real-time engine (ASR · LLM
> translation · voice synthesis) needs the backend (Next.js API routes + the
> `translator-service` socket.io mini-service), so on Pages the UI honestly
> reports the engine as offline. Clone and run locally (or deploy to any
> container host) for full functionality.

VoxShift is a real-time, bidirectional speech translator. Speak Persian (or
Finglish) and hear it translated into natural English — spoken back **with your
own voice** — or reverse the direction (English → Persian). The primary pair is
Persian ↔ English; Deutsch, Français, Español, العربية, Türkçe and Italiano are
supported on the non-Persian side.

Version **v3.3** · MIT licensed · Next.js 16 + TypeScript · cloud engines with
honest local runtimes as failover.

---

## Table of contents

1. [Feature tour](#feature-tour)
2. [Engine architecture & failover chain](#engine-architecture--failover-chain)
3. [Tech stack](#tech-stack)
4. [Run locally](#run-locally)
5. [Environment variables](#environment-variables)
6. [Deploy to a server / container](#deploy-to-a-server--container)
7. [Database](#database)
8. [Voice identity & voice contacts](#voice-identity--voice-contacts)
9. [Provider routing (bring your own keys)](#provider-routing-bring-your-own-keys)
10. [Realtime API (socket.io events)](#realtime-api-socketio-events)
11. [Tests](#tests)
12. [Known limitations](#known-limitations)
13. [Version](#version)

---

## Feature tour

### Live translation (Talk view)
- **Tap-and-speak pipeline** — microphone → streaming ASR → context-aware LLM
  translation → speech synthesis → playback, with live captions, per-phrase
  latency telemetry and a five-stage pipeline visualizer (MIC · ASR ·
  TRANSLATE · VOICE · OUTPUT).
- **Typed-phrase mode** — translate text directly; every phrase keeps its
  Latin transliteration for learners.
- **Two-way auto-detect** — speak either language; it is detected and
  translated to the other side (Persian ↔ English), overriding Dub/Interpreter.
- **Five translation styles** — Natural (default), Clean, Literal, Formal,
  Casual — with optional conversation context carried per phrase.
- **Presentation mode** — enlarge the current translation for a second screen.
- **Keyboard shortcuts** — press `?` in the app for the full map.

### Session transcript & phrasebook
- List and Dialogue transcript views; copy/save any phrase; **star phrases
  straight from the live transcript or thread view** into the phrasebook.
- Clear-session with confirmation; per-phrase provider + timing chips
  (`FA→EN · 0.7 s`) showing **which engine actually served** each stage.

### History
- Persistent, resumable conversations (threads → sessions → messages) with
  server-side search, starred filter, **audio-only filter** and a **last-7-days
  quick filter**; copy/CSV/JSON export honoring every active filter.
- Threads auto-title from their first message (spoken or typed).
- Saved-phrase archive (phrasebook) with search, star, filter, export, replay.

### Voice identity (real cloning when configured)
- Record a sample; with `ELEVENLABS_API_KEY` set, VoxShift performs **real
  cross-language voice cloning** (ElevenLabs Instant Voice Cloning):
  translations are synthesized from YOUR enrolled voice — timbre, pitch
  register and speaking style carried from a Persian reference into English
  speech.
- Without the key, enrollment falls back to an honestly-labeled
  **pitch-conformed match** (closest studio voice, pitch-shifted toward your
  register, tempo matched — an estimate, never presented as a clone).
- Multiple persistent profiles: enroll, rename, set default, delete (deletes
  the provider clone too), per-thread voice selection.
- **Test my voice** and **A/B compare** audition your enrolled voice against
  the interpreter default — on the Voice page and on every real translation.

### Voice contacts & automatic speaker recognition (v2)
- Local DSP voiceprint (pitch register + spectral timbre) recognizes **who**
  is speaking: enrolled contacts are named automatically, unknown voices get
  STABLE temporary labels (`Unknown 1`, `Unknown 2`…) and are never guessed.
- Identify an unknown speaker once — the engine assembles their ~10 s of
  captured speech, you verify the sample and save the name — and every future
  session greets them by name (speaker ids stay stable across restarts).
- Dedicated Contacts view: add / rename / delete / pause recognition /
  re-enroll / play reference / measured stats. Unknown is better than wrong.

### Multi-provider routing with automatic failover (v2/v3)
- Register your own OpenAI-compatible endpoints (ASR / translation / TTS) in
  Settings → they are tried first (priority order) with real failover through
  built-in engines down to local runtimes, and every result records the actual
  provider used.
- Keys are **AES-256-GCM encrypted at rest** and never leave the server.
- **Honest health telemetry**: live per-provider states (READY · RATE_LIMITED ·
  INVALID_KEY · OFFLINE · COOLDOWN) with exponential cooldowns, state dots in
  the routing-chain preview, and **"tested Xm ago · last success N ms"**
  tooltips. Running the setup self-test feeds the verdict straight into the
  engine's health map — a failing provider turns rose *before* it eats a
  phrase.
- Keyless last-resort tier (`free:gtx-translate`) keeps translation alive with
  zero configuration; local runtimes keep ASR/TTS alive offline.

### Settings center
- Persisted global defaults (localStorage + server) with per-thread overrides
  and snapshot/restore isolation; every credential save auto-runs a real
  connection test and shows the verdict inline.

### Diagnostics & honesty principles
- Provider status (no secrets) and a live pipeline self-test with measured
  per-stage latency.
- Every claim in the UI is backed by a real observed result: fallbacks are
  labeled, unknown is preferred over guessed, estimates say "estimated".

---

## Engine architecture & failover chain

Every pipeline layer is modular and swappable (`ASREngine`,
`LLMTranslationEngine`, `VoiceIdentityEngine`). The router walks each leg in
order and reports who actually served:

| Tier | ASR (speech→text) | Translation (LLM) | TTS (speech) |
| --- | --- | --- | --- |
| 1 — registered | your OpenAI-compatible endpoints (priority order) | your OpenAI-compatible endpoints | your OpenAI-compatible endpoints |
| 2 — built-in | `builtin:zai-asr` (cloud) | `builtin:zai-llm` (GLM, cloud) | `builtin:zai-tts` (cloud) |
| 3 — local runtime | `local:vosk-asr` (vosk fa/en small models), `local:whisper-asr` if detected | `local:ollama-llm` (if Ollama is running) | `local:piper-tts` (fa_IR-amir / en_US-amy, prewarmed worker pool), `local:espeak-tts` |
| 4 — keyless | — | `free:gtx-translate` (Google gtx endpoint, no key) | — |

- **Voice identity leg** routes separately: `clone` → ElevenLabs IVC;
  `voice-match` → pitch-conformed preset. Cloned synthesis **never** silently
  falls back to a preset voice — failures surface as pipeline errors while the
  text result still reaches the UI.
- **Piper workers are prewarmed** (a resident worker pool with a `voice:prewarm`
  event and auto-prewarm on output-language change) so the first local-TTS
  phrase doesn't pay a cold reload; the Latency card shows the live warm strip.
- Failures broadcast `provider.failed` / `provider.fallback` realtime events;
  cooldowns are exponential per provider and every attempt is recorded.

### Engine benchmarks (2026-10 model evaluation)

Trending candidates (Hugging Face ASR / translation / TTS leaderboards + voice
cloning families) were benchmarked on CPU against four criteria: latency,
accuracy, server-friendliness (RAM), output clarity. Results drive the chain
above — winners shipped, losers documented:

| Leg | Candidate | Measured | Verdict |
| --- | --- | --- | --- |
| ASR · en | **faster-whisper tiny** (CTranslate2 int8) | RTF **0.08**, perfect text with punctuation & casing | ✅ **shipped** — resident warm worker, bundled 75 MB model, lazy spawn + idle unload + free-RAM guard |
| ASR · en | vosk small en-us 0.15 | RTF 0.22, good text, no punctuation | kept as fallback |
| ASR · fa | **vosk small fa 0.42** | RTF 0.16, near-perfect Persian | ✅ stays primary for fa |
| ASR · fa | whisper tiny / base (int8) | RTF ≥ 1.0, garbled Persian at these sizes | rejected |
| TTS · en | Kokoro-82M (ONNX int8) | RTF 0.51 — noticeably more natural | rejected for the realtime loop (8× slower than piper, ~300 MB RAM); piper keeps the live contract |
| TTS · en/fa | **piper** en_US-amy / fa_IR-amir | RTF **0.064** / 0.06, clear articulation | ✅ stays — prewarmed worker pool |
| MT · fa→en | opus-mt community finetune (CT2 int8, ~100 MB) | degenerate repetition loops, 450–2400 ms | rejected |
| MT · fa→en | NLLB-200-distilled-600M | ~650 MB int8 — exceeds the 954 MB container budget | rejected on server-friendliness |
| MT · fa→en | **keyless gtx endpoint** | 425–850 ms, perfect on all 5 test sentences | ✅ stays as the keyless tier |
| Clone | Fish Speech · F5-TTS | prior CPU benchmark RTF ≈ 24; license constraints | rejected |
| Clone | Chatterbox (MIT) | PyTorch + multi-GB weights > container budget | rejected — cloud ElevenLabs IVC remains the cloning engine |

Integration notes for the winner: `engines/whisper-worker.py` (faster-whisper
tiny int8, English) speaks the same line-JSON stdio protocol as the piper
workers; `localASR` routes **fa → vosk, en → faster-whisper → vosk**; the model
is bundled (`whisper-tiny-ct2/`) so no runtime download or HF reachability is
required; the worker spawns only on English local-ASR demand (failover tier),
refuses to spawn under 350 MB free RAM, and unloads after 4 idle minutes.

## Tech stack

Next.js 16 (App Router) · TypeScript 5 · Tailwind CSS 4 · shadcn/ui (New York)
· Lucide icons · Prisma + SQLite · socket.io mini-service
(`mini-services/translator-service`) · Caddy gateway · `z-ai-web-dev-sdk`
(server-side only) · local runtimes: vosk, piper-tts, espeak-ng (detected at
runtime, honestly reported).

## Run locally

```bash
cp .env.example .env          # adjust DATABASE_URL if needed
bun install
bun run db:push               # create/sync the SQLite schema
bun run dev                   # Next.js on :3000 (background: logs to dev.log)

# realtime translator service (separate terminal):
cd mini-services/translator-service && bun run dev   # :3003

# gateway (optional, production-like entry):
caddy run --config Caddyfile  # :81 → :3000 + websocket proxy to :3003
```

Open the app through the gateway (`http://localhost:81`) or directly at
`http://localhost:3000`. All realtime traffic uses relative paths with the
`XTransformPort=3003` query via the gateway.

## Environment variables

See [.env.example](./.env.example). Provider credentials are resolved by the
`z-ai-web-dev-sdk` from the server environment (or `/etc/.z-ai-config`) —
**API keys never reach the browser**. Missing credentials are reported honestly
in About · Diagnostics → *Run self-test*.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | SQLite file for profiles, threads, history (e.g. `file:./db/voxshift.db`) |
| `APP_SECRET` | optional | Extra entropy for encrypting user-provided provider API keys (a machine secret is auto-generated in `db/.provider-secret` regardless) |
| `ELEVENLABS_API_KEY` | optional | Enables REAL cross-language voice cloning (ElevenLabs IVC). Without it the app runs in honest pitch-conformed voice-match mode |
| `TRANSLATOR_SERVICE_URL` | optional | Realtime service probe target for the self-test (default `http://127.0.0.1:3003`) |
| `VOXSHIFT_MODELS_DIR` | optional | Root of local runtime models (vosk / piper model dirs) when not on the default path |

## Deploy to a server / container

VoxShift runs as two processes behind one gateway:

```bash
bun install && bun run db:push
bun run build                                   # production build
DATABASE_URL=file:/data/voxshift.db PORT=3000 bun .next/standalone/server.js
cd mini-services/translator-service && DATABASE_URL=file:/data/voxshift.db bun server.ts   # :3003
caddy run --config Caddyfile.prod               # single public entry, XTransformPort routing
```

- The reference deployment (Railway) additionally installs **vosk** and
  **piper-tts** into a Python venv with `fa_IR-amir` + `en_US-amy` voice models,
  so the local runtime tiers really execute in production.
- Keep the SQLite file (and `db/.provider-secret`) on a persistent volume —
  recreating the secret invalidates previously stored provider keys
  (they report `DECRYPT_FAILED` honestly rather than silently failing).
- Behind the gateway all realtime traffic stays same-origin
  (`/?XTransformPort=3003`), so no CORS or absolute-URL configuration is needed.

## Database

Prisma models: `User` (anonymous cookie identity), `VoiceProfile` (acoustic
features + pitch ratio + quality diagnostics), `VoiceContact` (speaker
voiceprints + reference audio), `HistoryEntry` (saved phrases + audio cache),
`Conversation` / `ConversationSession` / `Message` (persistent threads, with
starred flags bridged to the phrasebook). After editing
`prisma/schema.prisma` run `bun run db:push`, then restart the server so the
regenerated client is loaded.

## Voice identity & voice contacts

1. Go to **Voice Identity**.
2. Enter an optional profile name and accept the consent notice:
   - **Cloning configured** — the sample is sent server-side to ElevenLabs
     Instant Voice Cloning and stored there (with the derived voice) until you
     delete the profile.
   - **No credential** — samples are analyzed in memory only, never stored.
3. Read the Persian sentence aloud (~15 s; cloning needs ≥ 8 s), press
   **Stop & Review**, replay the sample, then **Create voice clone / profile**.
4. The profile shows its mode honestly — `REAL VOICE CLONE` (model + stability)
   or `PITCH-CONFORMED MATCH` (mean F0, pitch-shift ratio, engine voice, tempo)
   — plus sample-quality feedback (clipping / noise) and an honest, explicitly
   estimated similarity band (the provider returns no similarity score).
5. **Test my voice** and **Compare A/B** audition your actual enrolled voice
   against the interpreter default — on the Voice page and on every real
   translation via the Voice A/B chip.
6. **Contacts** (v2): enroll people you talk to; the local DSP voiceprint
   recognizes them in future sessions and names them in the transcript.
   Re-enroll (merge or replace), pause recognition per contact, or delete with
   explicit confirm. Consent for storing a reference recording is captured at
   enrollment.

## Provider routing (bring your own keys)

Settings → **Custom providers** → Add provider: pick a category (ASR /
translation / TTS), give an OpenAI-compatible base URL, model and optional
API key + headers. Saving auto-runs a **real connection test** and shows the
verdict; the routing-chain preview shows a live state dot per provider with a
tooltip (state · tested Xm ago · consecutive failures · last error). FAILOVER
policy: registered → built-in → local → keyless; per-provider exponential
cooldowns; every phrase records who served it.

## Realtime API (socket.io events)

The translator mini-service (path `/`, gateway-relative) speaks these events —
useful for building your own clients:

| Direction | Event | Purpose |
| --- | --- | --- |
| client→server | `session:init` / `session:reset` | attach a thread, reset live state |
| client→server | `utterance` (text) / streaming audio | typed phrase or mic stream |
| client→server | `voice:prewarm` | prewarm a piper worker for a language |
| client→server | `providers:report-test` | feed a UI test verdict into the health map |
| server→client | `stage` | per-stage pipeline progress |
| server→client | `translation` / `result` | translated text / full per-phrase result (+audio) |
| server→client | `asr:partial:result` | streaming partial transcript |
| server→client | `utterance:error` | honest per-utterance failure with stage + provider |
| server→client | `speakers:labeled` / `speakers:sample` | live speaker attribution |
| server→client | `providers:health` | health-map snapshot (states, cooldowns, lastMs) |

## Tests

```bash
bun tests/integration/run.ts     # real end-to-end integration suite (engines + API + socket)
bun run lint                     # ESLint
bunx tsc --noEmit                # types
```

The integration suite exercises the real pipeline (no mocks): ASR, translation
(five styles + context), voice engines, the provider router failover, history
APIs and persistence.

## Known limitations

- Real cloning requires `ELEVENLABS_API_KEY`; without it the app uses the
  honestly-labeled pitch-conformed match.
- Built-in cloud legs require a reachable `z-ai` endpoint — when unavailable
  (e.g. restricted networks) the chain serves via the keyless/local tiers and
  reports it honestly in the events feed and chips.
- Local TTS quality varies by language: piper `en_US-amy` / `fa_IR-amir` are
  clear but robotic compared to cloud voices; espeak is the last resort.
- No speaker diarization across rooms — attribution = voices the mic can hear.
- Only the last 12 live utterances replay from memory; Saved Phrases keep
  audio server-side per the retention policy (Settings → Data & privacy).
- Provider rate limits (429) are retried with a backoff ladder; completed
  phrases are always safe and failed segments can be retried manually.

## Version

**v3.3** — see [CHANGELOG.md](./CHANGELOG.md) for the full history
(v1 single-pair translator → v2 contacts/multi-provider → v3 honest local
runtimes, chain telemetry, phrasebook at the point of conversation, warm
worker pool, honest chain tooltips, history filters).

## License

[MIT](./LICENSE) © 2026 Dani
