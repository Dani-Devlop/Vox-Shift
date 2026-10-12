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

Version **v3.7** · MIT licensed · Next.js 16 + TypeScript · cloud engines with
honest local runtimes as failover.

---

## Table of contents

1. [Feature tour](#feature-tour)
2. **[Zero-to-hundred setup guide](#zero-to-hundred-setup-guide)** ← start here
   (full manual install: models, engines, satellite, cloud keys, verification,
   troubleshooting)
3. [Engine architecture & failover chain](#engine-architecture--failover-chain)
4. [Tech stack](#tech-stack)
5. [Run locally](#run-locally)
6. [Environment variables](#environment-variables)
7. [Deploy to a server / container](#deploy-to-a-server--container)
8. [Database](#database)
9. [Voice identity & voice contacts](#voice-identity--voice-contacts)
10. [Provider routing (bring your own keys)](#provider-routing-bring-your-own-keys)
11. [Realtime API (socket.io events)](#realtime-api-socketio-events)
12. [Tests](#tests)
13. [Known limitations](#known-limitations)
14. [Version](#version)

> 🇮🇷 **راهنمای کامل فارسی (صفر تا صد):** [docs/SETUP-FA.md](./docs/SETUP-FA.md)
> — the same guide, fully in Persian.

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
  Detection happens AT THE ASR LAYER (v3.6.0): a dual-engine pass (vosk-fa ∥
  multilingual faster-whisper auto-detect) decides the language from the audio
  itself — English utterances are no longer mis-detected as Persian.
- **Code-switching (mixed fa+en)** — Persian sentences with embedded English
  words/phrases are transcribed by BOTH engines and merged word-by-word on
  their timestamps: Persian words come from vosk (near-perfect fa), embedded
  English words come from whisper (vosk drops them entirely).
- **Accent-robust English** — faster-whisper decodes with beam search + VAD
  and no cross-context conditioning for steadier recognition across accents.
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

### Voice identity (local-first cloning chain)
- Cloned profiles are served by a **local-first priority chain** (v3.5.0, engines verified by measurement in v3.7.0):
  **Fish Speech → F5-TTS → Chatterbox → ElevenLabs IVC (cloud) → pitch-conformed
  match (local DSP)**. Each level's gates are probed for real (python package or
  source checkout, model weights on disk, usable-RAM floor, API key) and the
  About page shows the ACTIVE engine live.
- **Fish Speech (local, v3.7.0)**: the official fish-speech **v1.5.0** local
  surface (`tools.inference_engine.TTSInferenceEngine` — dual-AR llama +
  firefly-gan VQ decoder), zero-shot from a reference WAV + transcript.
  Measured on 2 CPU cores: peak RSS **2306 MB**, 3.4 s of audio in ~57 s cold.
- **F5-TTS (local)**: `f5_tts.api.F5TTS` (v1 base). Measured on 2 CPU cores:
  peak RSS **2875 MB**, 3.4 s of audio in ~150 s cold. One-shot worker calls
  (load + infer + exit) keep the resident footprint near zero between phrases.
- **Honest RAM math (v3.7.0)**: the detector reads the **cgroup memory limit**
  AND `/proc/meminfo`. On shared platforms (Railway et al.) meminfo describes
  the HOST (hundreds of GB shared by all projects) while the container is
  cgroup-capped to its own slice — usable = min(meminfo free, cgroup limit),
  so the gates never promise RAM the platform will OOM-kill. The About page
  renders the whole picture (usable MB · source · cgroup cap · host numbers).
  `VOXSHIFT_RAM_BUDGET_MB` overrides the estimate for operators who know
  better. Floors are measured, not guessed: Fish 2600 MB · F5 2900 MB ·
  Chatterbox 2600 MB.
- **One-shot installer** for any host that can afford the engines:
  `bash scripts/setup-local-clone.sh` (CPU torch 2.8 pair + f5-tts + the
  fish-speech v1.5.0 checkout + weights + reference-transcript conventions).
  Run it after raising the platform memory — the SAME chain picks the local
  engines up automatically, no code change.
- With `ELEVENLABS_API_KEY` set (and no local engine installed), VoxShift
  performs **real cross-language voice cloning** (ElevenLabs Instant Voice
  Cloning): translations are synthesized from YOUR enrolled voice — timbre,
  pitch register and speaking style carried from a Persian reference into
  English speech. Enrollment also keeps the reference WAV on-box so a locally
  installed engine can serve the same profile later.
- With nothing better than the terminal level, enrollment and synthesis fall
  back to an honestly-labeled **pitch-conformed match** (closest studio voice,
  pitch-shifted toward your register, tempo matched — always labeled
  `pitch-conformed`, never presented as a clone).
- Multiple persistent profiles: enroll, rename, set default, delete (deletes
  the provider clone too), per-thread voice selection.
- **Test my voice** and **A/B compare** audition your enrolled voice against
  the interpreter default — on the Voice page and on every real translation.
  Previews run the SAME synthesis chains as the realtime pipeline (v3.6.0),
  so they work with ONLY local engines installed — no cloud key required.

### Voice contacts & automatic speaker recognition (v2, reworked v3.6.0)
- Local DSP voiceprint (pitch register + spectral timbre) recognizes **who**
  is speaking: enrolled contacts are verified BEFORE conversation context —
  a short reply from a contact is never mislabeled as the previous speaker
  (v3.6.0 fix).
- Unknown voices get STABLE temporary labels (`Unknown Speaker 1`,
  `Unknown Speaker 2`…) and are never guessed; weak evidence refuses to
  borrow a name. Hysteresis must beat every other cluster by a margin, so
  similar same-gender voices stay separate.
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

## Zero-to-hundred setup guide

A complete, manual, copy-paste walkthrough: from a bare machine to VoxShift
running with local ASR, local TTS, real voice cloning (or a satellite), and
cloud keys. Every path and env var below matches what the code actually
probes — no guessing.

> Persian version: [docs/SETUP-FA.md](./docs/SETUP-FA.md) · one-shot engine
> installer: [scripts/setup-local-clone.sh](./scripts/setup-local-clone.sh)

### 0 · What you need

- **OS**: Linux or macOS (Windows: use WSL2).
- **Bun** ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`) — or Node 20+ with
  equivalent package-manager substitutions.
- **Python 3.10–3.12** + `pip` + `venv` (for the local ASR/TTS/clone runtimes).
- **RAM / disk budget** (measured floors — the app refuses to load an engine it
  cannot afford, honestly):

| Component | RAM floor (load) | Disk | Role |
| --- | --- | --- | --- |
| vosk small fa (`vosk-model-small-fa-0.42`) | ~150 MB | ~50 MB | Persian ASR — primary |
| vosk small en (`vosk-model-small-en-us-0.15`) | ~150 MB | ~40 MB | English ASR fallback |
| faster-whisper tiny | 350 MB free guard | **bundled** (75 MB, in-repo) | English ASR + language auto-detect + code-switch merge |
| piper voices (amir / amy / ryan) | ~80 MB per resident voice | 60–110 MB each | local TTS |
| **Fish Speech v1.5.0** | **2600 MB** | ~1.5 GB | zero-shot voice clone |
| **F5-TTS** | **2900 MB** | ~1.4 GB | zero-shot voice clone |
| **Chatterbox** | **2600 MB** | 2–4 GB | zero-shot voice clone |
| ElevenLabs IVC (cloud) | 0 | 0 | real clone, no RAM |
| Timbre-conformed DSP | 0 | 0 | always-available tone matching |

- A `MODELS_ROOT` directory for models (default **`/home/z/models`**, override
  with `VOXSHIFT_MODELS_DIR`). Everything under it is found automatically.

### 1 · Get the app running (5 minutes)

```bash
git clone https://github.com/Dani-Devlop/Vox-Shift.git
cd Vox-Shift
cp .env.example .env          # only DATABASE_URL is required
bun install
bun run db:push               # create/sync the SQLite schema

# terminal 1 — the Next.js app:
bun run dev                   # http://localhost:3000

# terminal 2 — the realtime translator service:
cd mini-services/translator-service
bun install                   # socket.io + prisma + z-ai sdk
bunx prisma generate          # regenerate the Prisma client for this service
bun run dev                   # socket.io on :3003
```

Open `http://localhost:3000`. Typed phrases already work at this point (the
keyless `free:gtx-translate` tier needs zero configuration). The mic pipeline
activates as soon as you add the local models below.

### 2 · Python runtime for the local engines

The translator looks for python on `PATH`, then `/opt/voxshift/venv/bin/python3`,
then `/home/z/.venv/bin/python` (first that exists wins). Recommended — a
single dedicated venv:

```bash
python3 -m venv /home/z/.venv
/home/z/.venv/bin/pip install --upgrade pip
/home/z/.venv/bin/pip install vosk piper-tts faster-whisper numpy soundfile
```

- `vosk` → local ASR tier. `piper-tts` → local TTS tier.
- `faster-whisper` → resident English/auto-detect worker (the 75 MB CT2 model
  ships in the repo at `mini-services/translator-service/whisper-tiny-ct2/` —
  no download, no HF reachability needed).

### 3 · Local ASR models (vosk — Persian + English)

Directory layout matters: the two model folders sit **directly under**
`MODELS_ROOT` (no nesting):

```bash
MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
mkdir -p "$MODELS_DIR" && cd "$MODELS_DIR"

curl -LO https://alphacephei.com/vosk/models/vosk-model-small-fa-0.42.zip
curl -LO https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip -q vosk-model-small-fa-0.42.zip
unzip -q vosk-model-small-en-us-0.15.zip

# result (verify):
ls "$MODELS_DIR"
# vosk-model-small-fa-0.42/  vosk-model-small-en-us-0.15/  (…)
```

That's the whole Persian-ASR install — `local:vosk-asr` becomes AVAILABLE on
the next translator restart and serves `fa` with near-perfect accuracy.

### 4 · Local TTS voices (piper — Persian + English + male match)

```bash
MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
mkdir -p "$MODELS_DIR/piper" && cd "$MODELS_DIR/piper"

# NOTE: the /resolve/v1.0.0/ tag is required — resolve/main 404s.
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0

curl -LO $BASE/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx
curl -LO $BASE/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json
curl -LO $BASE/en/en_US/amy/medium/en_US-amy-medium.onnx
curl -LO $BASE/en/en_US/amy/medium/en_US-amy-medium.onnx.json

# optional — male-timbre matching voice (used by the timbre-conform path
# when the enrolled reference reads as low-F0):
curl -LO $BASE/en/en_US/ryan/high/en_US-ryan-high.onnx
curl -LO $BASE/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

Each `.onnx` **must** have its `.onnx.json` sibling — piper refuses the voice
without it. Workers are prewarmed per output language and idle-unload after
4 minutes.

### 5 · Real voice cloning (local engines)

The priority chain is **Fish Speech → F5-TTS → Chatterbox → satellite →
ElevenLabs → timbre-conformed → pitch-conformed**; the first level whose gates
(package ✓ · weights ✓ · RAM ✓) pass serves the clone. Two install routes:

**Route A — one-shot installer** (fish + f5, needs ~3 GB free RAM):

```bash
cd Vox-Shift
bash scripts/setup-local-clone.sh              # both engines + weights
#   bash scripts/setup-local-clone.sh --with-fish   # fish only
#   bash scripts/setup-local-clone.sh --with-f5     # f5 only
```

The script pins the CPU torch pair (`torch==2.8.0` + `torchaudio==2.8.0` —
deliberately NOT the fish-speech `pip install -e .` which would downgrade
torch for every other engine), installs the minimal fish inference deps, and
snapshot-downloads the `fishaudio/fish-speech-1.5` weights.

**Route B — fully manual** (what the script does, step by step):

```bash
MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
PY=/home/z/.venv/bin/pip     # your venv pip

# ── F5-TTS ─────────────────────────────────────────────────────────────
$PY install f5-tts            # weights auto-download from HF (SWivid/F5-TTS)
                              # on first synthesis — or pre-place them and
                              # point VOXSHIFT_F5_WEIGHTS at the folder

# ── Fish Speech v1.5.0 ────────────────────────────────────────────────
git clone --depth 1 --branch v1.5.0 \
  https://github.com/fishaudio/fish-speech.git "$MODELS_DIR/fish-speech-src"
$PY install hydra-core einops librosa loguru loralib pyrootutils \
  "einx[torch]==0.2.2" "vector-quantize-pytorch==1.14.24" tiktoken cachetools \
  silero-vad pytorch-lightning lightning natsort
$PY install huggingface_hub
export MODELS_DIR
python3 - <<EOF
from huggingface_hub import snapshot_download
snapshot_download("fishaudio/fish-speech-1.5",
    local_dir="${MODELS_DIR}/fish-speech/checkpoints/fish-speech-1.5",
    allow_patterns=["model.pth", "config.json", "special_tokens.json",
                    "tokenizer.tiktoken",
                    "firefly-gan-vq-fsq-8x1024-21hz-generator.pth"])
EOF

# ── Chatterbox (separate venv! it pins its own torch) ──────────────────
python3 -m venv /home/z/.venv-chatterbox
/home/z/.venv-chatterbox/bin/pip install chatterbox-tts
```

> **Which python?** The clone detector and the clone worker spawn the plain
> `python3` on the translator's PATH. So install fish/f5 into the interpreter
> that `python3` resolves to, **or activate the venv before starting the
> translator** (`source /home/z/.venv/bin/activate`). Chatterbox keeps its own
> venv — activate that one instead when you want chatterbox to be the detected
> engine (only one torch tree can own `python3` at a time; the chain re-probes
> every 30 s). vosk / piper / faster-whisper are more forgiving: their runners
> also probe `/opt/voxshift/venv` and `/home/z/.venv` directly.

**Resulting layout** (all auto-discovered, env overrides optional):

```
$MODELS_DIR/
├── vosk-model-small-fa-0.42/
├── vosk-model-small-en-us-0.15/
├── piper/
│   ├── fa_IR-amir-medium.onnx (+ .onnx.json)
│   ├── en_US-amy-medium.onnx  (+ .onnx.json)
│   └── en_US-ryan-high.onnx   (+ .onnx.json)
├── fish-speech-src/                        # v1.5.0 checkout (tools/inference_engine)
├── fish-speech/checkpoints/fish-speech-1.5/   # weights
├── f5-tts/                                 # weights (or HF cache — both probed)
└── chatterbox/                             # weights (or HF cache — both probed)
```

**Reference transcripts** (recommended — zero-shot engines condition on them;
f5 without one pulls a whisper model mid-flight): after enrolling a profile,
place `<profileId>.txt` next to `<profileId>.wav` in `db/audio/clone-ref/`, or
set `VOXSHIFT_CLONE_REF_TEXT`.

**Restart the translator** after installing anything — engine detection is
cached for 30 s, and the About page then shows each level's real gate state
with an **ACTIVE** badge on the serving engine.

### 6 · Satellite cloning — real engines for a small container

If the app runs on a memory-capped host (Railway ~1 GB slice et al.) but you
have a RAM-rich machine (your PC, a dedicated server), run the REAL cloning
engines there and let the app call in over HTTP — no platform upgrade needed:

```bash
# ── on the RAM-rich machine ────────────────────────────────────────────
git clone https://github.com/Dani-Devlop/Vox-Shift.git && cd Vox-Shift
bash scripts/setup-local-clone.sh        # engines + weights (+ chatterbox venv)
bun mini-services/clone-satellite/server.ts     # listens on :3011
# env: VOXSATELLITE_PORT / VOXSATELLITE_ENGINES=fish-speech,f5-tts,chatterbox
#      VOXSATELLITE_ALLOW_ORIGINS=https://your-app-host  (optional CORS)

# expose it: SSH tunnel / Tailscale / ngrok / port-forward, then verify:
curl http://<your-host>:3011/healthz      # → {"ok":true,"engines":[…]}

# ── on the app host ───────────────────────────────────────────────────
# .env:
VOXSHIFT_SATELLITE_CLONE_URL=http://<your-host>:3011
```

The chain inserts the satellite at priority 4 (before ElevenLabs); results
are served as REAL clones (`degraded:false`) and every request spawns a
one-shot worker on the satellite — no resident model RAM there either.

### 7 · Cloud keys (optional)

| Key | Effect |
| --- | --- |
| `ELEVENLABS_API_KEY` | **Real cross-language voice cloning** via ElevenLabs IVC — chain level 5. Also enables cloud previews when no local engine is installed. |
| Built-in `z-ai` legs (ASR · LLM · TTS) | Enabled by the SDK's own config (`/etc/.z-ai-config` or the server environment). Without it the legs report **UNCONFIGURED** honestly and the local + keyless tiers keep the pipeline fully functional. |
| Custom OpenAI-compatible providers | Settings → Custom providers — encrypted at rest, tried first, auto-failover. |

### 8 · Connecting everything (env-var map)

Add to `.env` what applies to your setup, then restart BOTH processes:

```bash
DATABASE_URL=file:./db/voxshift.db          # required
VOXSHIFT_MODELS_DIR=/home/z/models          # only if not the default
VOXSHIFT_RAM_BUDGET_MB=4000                 # only to override the cgroup probe
VOXSHIFT_FISH_WEIGHTS=/path/to/weights      # only if outside the default layout
VOXSHIFT_F5_WEIGHTS=/path/to/weights        # "
VOXSHIFT_CHATTERBOX_WEIGHTS=/path/to/weights  # "
VOXSHIFT_CLONE_REF_TEXT="من علی هستم"       # fallback reference transcript
VOXSHIFT_SATELLITE_CLONE_URL=http://host:3011  # satellite cloning
VOXSHIFT_WHISPER_MODEL=base                 # optional: better accents/embedded-en
ELEVENLABS_API_KEY=…                        # optional: cloud cloning
```

What connects to what, in one line each:

- **vosk models** → auto-found under `$MODELS_DIR` by exact folder name →
  `local:vosk-asr` (fa primary · en fallback).
- **whisper** → bundled `whisper-tiny-ct2` + `faster-whisper` pip package →
  resident worker (English + auto-detect, dual-run with vosk, merged).
- **piper voices** → auto-found under `$MODELS_DIR/piper/` by exact filename →
  `local:piper-tts` (fa_IR-amir / en_US-amy / en_US-ryan for male match).
- **fish/f5/chatterbox** → pip package + weights layout above →
  `local:voice-cloning` chain levels 1–3.
- **satellite** → `VOXSHIFT_SATELLITE_CLONE_URL` → chain level 4.
- **ElevenLabs** → `ELEVENLABS_API_KEY` → chain level 5.
- **timbre/pitch-conformed DSP** → built in, zero config → levels 6–7
  (always available; honestly labeled).

### 9 · Verify the whole chain

```bash
# real engine probes (synthesize through the actual workers):
bun tests/probe-clone-chain.ts      # gate matrix: package ✓ weights ✓ RAM ✓
bun tests/probe-clone-synth.ts      # REAL fish/f5 synthesis end-to-end
bun tests/probe-timbre-conform.ts   # timbre morph objectively measured

# full pipeline integration suite (ASR + translate + TTS + router + history):
bun tests/integration/run.ts
```

In the app: **About → Diagnostics → Run self-test** walks every pipeline stage
live, and the About page's *Engine chains* / *Voice cloning priority chain*
sections show each level's gate state with the **ACTIVE** engine badged.
Enroll a voice (Voice Identity → record ~15 s), then **Test my voice** — it
runs the exact same synthesis chain the realtime pipeline uses.

### 10 · Troubleshooting

| Symptom | Cause → Fix |
| --- | --- |
| Clone engine `unavailable — RAM` | The cgroup-aware probe says usable < floor (Fish 2600 / F5 2900 / Chatterbox 2600 MB). Raise the plan/memory, use the **satellite**, or accept the timbre-conformed level. `VOXSHIFT_RAM_BUDGET_MB` overrides when you know better. |
| Clone engine `unavailable — weights` | Weights not in any probed path → check the layout in step 5, or set `VOXSHIFT_FISH_WEIGHTS` / `VOXSHIFT_F5_WEIGHTS` / `VOXSHIFT_CHATTERBOX_WEIGHTS`. |
| vosk / piper "runtime not detected" | The python env the translator uses lacks the package. ASR/TTS runners probe `PATH` → `/opt/voxshift/venv` → `/home/z/.venv` (step 2); **clone engines use plain `python3` only** — activate their venv before starting the translator (see the *Which python?* note in step 5). |
| piper voice download 404s | Use the **`/resolve/v1.0.0/`** URLs (step 4) — `resolve/main` is dead. |
| First English phrase is slow / whisper boot timeout | `VOXSHIFT_WHISPER_MODEL=base` downloads from HF on first boot (90 s timeout) — keep `tiny` (bundled) for offline hosts. |
| Clone sounds like a preset, not me | Pre-v3.8 profiles have no reference WAV on disk → **re-enroll once** so the timbre path can match your tone. Clone-mode profiles need ≥ 8 s of clean reference audio. Also give the engine a reference transcript (`<profileId>.txt` in `db/audio/clone-ref/` or `VOXSHIFT_CLONE_REF_TEXT`). |
| `z-ai config not found` in self-test | Honest UNCONFIGURED label, not a failure — the pipeline serves via local + keyless tiers. Add a cloud key if you want those legs. |
| ElevenLabs 429 | Provider quota — the router cools the provider down exponentially and fails over; retries are automatic. |
| Persian text garbled from English audio | Should not happen since v3.6 (ASR-layer detection); if you force `fa` in Settings you bypass auto-detect — leave it on **Auto**. |

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

- **Voice identity leg** routes through the local-first cloning chain (v3.5.0):
  Fish Speech → F5-TTS → Chatterbox (zero-shot local engines, gated by real
  package + weights + RAM detection) → ElevenLabs IVC → pitch-conformed preset.
  Every attempt inside the chain is recorded and the ACTUAL engine id is
  reported; the terminal pitch-conformed level is labeled (`degraded`) so a
  preset match is **never** presented as a clone. Only an enrollment-
  incomplete profile refuses outright (no reference → nothing to clone).
- **ASR language policy is a registry**: fa → vosk-small ∥ whisper(auto) +
  code-switch merge, en → faster-whisper tiny (resident) → vosk-en; new
  languages are added by registering a model path + primary engine (+ optional
  `codeSwitchWith` partner), not by new core branches. Whisper decoding runs
  beam=2 + VAD for accent robustness; a measured misdetection guard keeps
  whisper timelines from hijacking pure-Persian audio.
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

> **v3.7/v3.8 update:** the clone verdict above was revisited — Fish Speech
> v1.5.0 (official surface) and F5-TTS were benchmarked on real CPU hardware
> and **shipped** as chain levels 1–2 with honest RAM gates (measured floors:
> Fish 2600 MB, F5 2900 MB, Chatterbox 2600 MB). The table row reflects the
> original 1 GB-container verdict; the [setup guide](#zero-to-hundred-setup-guide)
> shows how to run them on capable hosts.

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
| `ELEVENLABS_API_KEY` | optional | Enables REAL cross-language voice cloning (ElevenLabs IVC). Without it the app runs the local chain: real engines → satellite → timbre-conformed DSP |
| `TRANSLATOR_SERVICE_URL` | optional | Realtime service probe target for the self-test (default `http://127.0.0.1:3003`) |
| `VOXSHIFT_MODELS_DIR` | optional | Root of local runtime models (vosk / piper / clone-engine weights) when not on the default path |
| `VOXSHIFT_RAM_BUDGET_MB` | optional | Operator-declared usable RAM for the clone-engine gates (wins over the cgroup probe) |
| `VOXSHIFT_SATELLITE_CLONE_URL` | optional | URL of your **clone satellite** (`mini-services/clone-satellite`, port 3011) — serves REAL Fish Speech / F5-TTS / Chatterbox from any RAM-rich machine you control |
| `VOXSHIFT_WHISPER_MODEL` | optional | Resident faster-whisper model: `tiny` (bundled, default) or `base` (better embedded-English + accents, ~2× RTF, int8) |
| `VOXSHIFT_FISH_WEIGHTS` / `VOXSHIFT_F5_WEIGHTS` / `VOXSHIFT_CHATTERBOX_WEIGHTS` | optional | Explicit weight directories for the local clone engines |
| `VOXSHIFT_CLONE_REF_TEXT` | optional | Transcript of the enrollment reference (zero-shot engines condition on it; a `.txt` sibling of the WAV wins) |

## Voice cloning setup (v3.8.0)

> **Full install walkthrough:** see the
> [Zero-to-hundred setup guide](#zero-to-hundred-setup-guide) above (steps 5–6)
> — this section is the chain overview.

Clone-mode and voice-match profiles are served by the first AVAILABLE level of
the priority chain (About · Diagnostics renders it live):

1. **Fish Speech (local)** — zero-shot, ~2.3 GB RAM peak, needs `pip install`
   of the inference deps + weights (`scripts/setup-local-clone.sh --with-fish`)
2. **F5-TTS (local)** — zero-shot, ~2.9 GB RAM peak (`--with-f5`)
3. **Chatterbox (local)** — zero-shot (`pip install chatterbox-tts`, pins its
   own torch version — install it in a separate venv)
4. **Satellite clone (your host)** — `VOXSHIFT_SATELLITE_CLONE_URL` →
   `mini-services/clone-satellite` running the REAL engines on any machine
   with RAM to spare (this is how a ~1 GB Railway container gets full-quality
   cloning from a 500 GB-class host without changing the platform plan)
5. **ElevenLabs IVC (cloud)** — `ELEVENLABS_API_KEY`
6. **Timbre-conformed (local DSP, v3.8.0)** — runs ANYWHERE with no RAM
   floor: piper base voice shifted to your measured F0 + spectral-envelope
   morph (STASS) toward your enrolled reference — the default voice-match
   path now reproduces your tone (re-enroll once after upgrading so the
   reference WAV is persisted)
7. **Pitch-conformed (local DSP)** — preset + pitch ratio, always available,
   labeled NOT-a-clone

```bash
# one-shot installer for the local engines (any host with the RAM):
bash scripts/setup-local-clone.sh            # fish-speech + f5-tts + weights
# then restart the translator — the chain picks the engines up (30 s cache)

# satellite on your own machine (real engines for a small container):
bash scripts/setup-local-clone.sh
cd mini-services/clone-satellite && bun server.ts     # :3011
# on the app host:  VOXSHIFT_SATELLITE_CLONE_URL=http://<your-host>:3011
```

Verification probes:

```bash
bun tests/probe-clone-chain.ts     # detector gates (stubs + RAM hook)
bun tests/probe-clone-synth.ts     # REAL fish/f5 synthesis through the worker
bun tests/probe-timbre-conform.ts  # timbre morph moves LTASS toward the reference
```

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
  **piper-tts** into a Python venv with `fa_IR-amir` + `en_US-amy` voice models
  (+ `en_US-ryan` for male timbre matching), so the local runtime tiers really
  execute in production.
- **Container memory and the clone engines**: on shared platforms the cgroup
  caps the service at its own slice (the reference deployment shows ~954 MB).
  The RAM gates read the cgroup limit honestly — the GB-class clone engines
  refuse to spawn there. Three ways to get real cloning: run
  `scripts/setup-local-clone.sh` on a bigger plan/volume, point
  `VOXSHIFT_SATELLITE_CLONE_URL` at your own machine, or add
  `ELEVENLABS_API_KEY`. The timbre-conformed DSP level (6) works everywhere
  with zero extra RAM.
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

- **Local cloning engines are RAM-hungry by nature**: Fish Speech and F5-TTS
  need ~2.6–2.9 GB of free memory to LOAD (measured CPU peaks). On a container
  capped to ~1 GB (Railway default slice) the honest RAM gate refuses them —
  the About page shows exactly why (usable vs cgroup cap). Raise the service
  memory (or run on a bigger box) + `scripts/setup-local-clone.sh`, and the
  chain activates them automatically. Without any local/cloud clone engine the
  app uses the honestly-labeled pitch-conformed match.
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

**v3.8** — see [CHANGELOG.md](./CHANGELOG.md) for the full history
(v1 single-pair translator → v2 contacts/multi-provider → v3 honest local
runtimes, chain telemetry, phrasebook at the point of conversation, warm
worker pool, honest chain tooltips, history filters, benchmark-backed model
choices, local-first voice-cloning priority chain, MEASURED local clone
engines (fish-speech v1.5.0 official surface + F5-TTS) with cgroup-aware
honest RAM gating, v3.8 timbre-conformed reference mimicry + satellite
cloning + mobile viewport fixes).

## License

[MIT](./LICENSE) © 2026 Dani
