# VoxShift v2.2.0 — Voice Translation with Voice Identity & Voice Contacts

**Live demo (GitHub Pages, static UI):** <https://dani-devlop.github.io/Vox-Shift/>

> The Pages deployment is a **static demo** — the real-time engine (ASR · LLM
> translation · voice synthesis) needs the local backend (Next.js API routes +
> the `translator-service` socket.io mini-service), so on Pages the UI honestly
> reports the engine as offline. Clone and run locally for full functionality.

VoxShift is a real-time, bidirectional speech translation app. Speak Persian (or
Finglish) and hear it translated into natural English — spoken back with **your
voice identity** — or reverse the direction and translate English into Persian.
The primary pair is Persian ↔ English; Deutsch, Français, Español, العربية,
Türkçe and Italiano are supported on the non-Persian side.

## Features

- **Live translation** — microphone → streaming ASR → context-aware LLM
  translation → speech synthesis → playback, with live captions, latency
  telemetry and a pipeline visualizer.
- **Voice identity (real cloning when configured)** — record a sample; with
  `ELEVENLABS_API_KEY` set, VoxShift performs **real cross-language voice
  cloning** (ElevenLabs IVC): translations are synthesized from YOUR enrolled
  voice — timbre, pitch register and speaking style carried from a Persian
  reference into English speech. Without the key, enrollment falls back to an
  honestly-labeled **pitch-conformed match** (closest studio voice, pitch
  shifted toward your register, tempo matched — an estimate, never presented
  as a clone). Multiple persistent profiles: enroll, rename, set default,
  delete (deletes the provider clone too), per-thread voice selection.
- **Five translation styles** — Natural (default), Clean, Literal, Formal,
  Casual — with optional conversation context.
- **Voice Contacts & automatic speaker recognition (v2)** — a local DSP
  voiceprint (pitch register + spectral timbre) recognizes who is speaking:
  enrolled contacts are named automatically, unknown voices get STABLE
  temporary labels (Unknown 1, Unknown 2…) and are never guessed. Identify an
  unknown speaker once — the engine assembles their ~10 s of captured speech,
  you verify the sample and save the name — and every future session greets
  them by name. Manage contacts in a dedicated view (re-enroll, pause
  recognition, playback, measured stats). Unknown is better than wrong.
- **Multi-provider routing with automatic failover (v2)** — register your own
  OpenAI-compatible endpoints (ASR / translation / TTS) in Settings; they are
  tried first (priority order) with real failover to the built-in engines, and
  every result records the actual provider used. Keys are AES-256-GCM
  encrypted at rest and never leave the server. Live provider health states
  (READY / RATE_LIMITED / INVALID_KEY / OFFLINE / COOLDOWN) with exponential
  cooldowns.
- **Sessions** — persistent, resumable conversations (threads → sessions →
  messages) with server-side search, plus a saved-phrase archive with search,
  star/filter, export and replay.
- **Settings center** — persisted global defaults (localStorage + server);
  per-thread overrides with snapshot/restore isolation.
- **Diagnostics** — provider status (no secrets) and a live pipeline self-test
  with measured per-stage latency.

## Tech stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma +
SQLite · socket.io mini-service (`mini-services/translator-service`) · Caddy
gateway. ASR / LLM / TTS via `z-ai-web-dev-sdk` (server-side only).

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
`z-ai-web-dev-sdk` from the server environment — **API keys never reach the
browser**. Missing credentials are reported honestly in About · Diagnostics →
*Run self-test*.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | SQLite file for profiles, threads, history (e.g. `file:/home/z/my-project/db/custom.db`) |
| `APP_SECRET` | optional | Extra entropy for encrypting user-provided provider API keys (a machine secret is auto-generated in `db/.provider-secret` regardless) |
| `ELEVENLABS_API_KEY` | optional | Enables REAL cross-language voice cloning (ElevenLabs IVC). Without it the app runs in honest pitch-conformed voice-match mode and every surface explains how to enable cloning |
| `TRANSLATOR_SERVICE_URL` | optional | Realtime service probe target for the self-test (default `http://127.0.0.1:3003`) |

### Deploy & run

```bash
bun install
bun run db:push                                  # create/update SQLite schema
bun run dev                                      # Next.js UI + API on :3000
cd mini-services/translator-service && bun run dev   # realtime engine on :3003
# Caddy gateway (:81) fronts both — the UI is served through :81
bun tests/integration/run.ts                     # real integration test suite
```

GitHub Pages serves a static UI demo (auto-deployed on push to `main`); the
real-time engine requires the local backend as documented above.

## Database

Prisma models: `User` (anonymous cookie identity), `VoiceProfile` (acoustic
features + pitch ratio + quality diagnostics), `HistoryEntry` (saved phrases +
audio cache), `Conversation` / `ConversationSession` / `Message` (persistent
threads). After editing `prisma/schema.prisma` run `bun run db:push`, then
restart the dev server so the regenerated client is loaded.

## Voice enrollment

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
   (clone leg) against the interpreter default — on the Voice Identity page and
   on every real translation via the Voice A/B chip.
6. Profiles persist across reloads and conversations; any thread can pick its
   own profile (Thread settings → Voice profile) without touching your global
   default.

## Enabling real voice cloning

Add `ELEVENLABS_API_KEY` to `/home/z/my-project/.env` (see `.env.example`) and
restart both the Next.js server and the translator mini-service. Until then the
app stays fully functional in pitch-conformed mode — never silently pretending
a preset voice is yours. Voice Identity and About · Diagnostics show exactly
what is missing.

## Architecture notes

Every pipeline layer is modular and swappable: `ASREngine`,
`LLMTranslationEngine`, and the voice layer — `VoiceIdentityEngine` routes by
profile `mode`: `'clone'` → `engines/voice-clone.ts` (ElevenLabs IVC,
cross-language), `'voice-match'` → `engines/voice.ts` (pitch-conformed preset).
Cloned synthesis NEVER silently falls back to a preset voice: failures surface
as pipeline errors while the text result still reaches the UI.

## Known limitations

- Real cloning requires `ELEVENLABS_API_KEY`; without it the app uses the
  honestly-labeled pitch-conformed match. Cloned-voice latency depends on the
  provider (balanced model ≈ sub-second, quality model slower).
- No speaker diarization — speaker attribution = whoever is near the mic.
- Only the last 12 live utterances replay from memory; Saved Phrases keep
  audio server-side per the retention policy (Settings → Data & privacy).
- Provider rate limits (429) are retried 3×; completed phrases are always safe
  and failed segments can be retried manually.

## Version

v1.0.0 — see [CHANGELOG.md](./CHANGELOG.md).
