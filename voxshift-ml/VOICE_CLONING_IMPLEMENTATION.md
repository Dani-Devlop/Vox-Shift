# VOICE_CLONING_IMPLEMENTATION.md — VoxShift v3.3.1

## Selected architecture

**Architecture C** — base TTS (piper, native fa/en) → OpenVoice v2 tone-color conversion
toward the enrolled speaker. Selected on measured evidence (VOICE_BENCHMARK_RESULTS.md):
the only identity-bearing chain that is near-real-time (≈0.94 RTF full chain) on the
actual CPU-only hardware, with MIT code+weights and on-box privacy.

```
user speaks → ASR → translation → VoiceIdentityEngine.synthesize
  profileMode 'clone' + providerModel 'local-openvoice'
    ├─ base TTS   routedCall('tts') local branch: piper fa/en (espeak fallback)
    ├─ conversion POST voice-clone-service :3010 /convert {speakerId=profileId}
    └─ → WAV 'local-openvoice'  (failures are HONEST — no preset fallback)
```

## Modified / added files (all in the existing project)

| File | Change |
|---|---|
| `mini-services/voice-clone-service/index.py` | NEW — OpenVoice v2 converter HTTP service (enroll/convert/drop/health), models load once, threads=2 |
| `mini-services/voice-clone-service/selftest.py` | NEW — 10-case automated test (all PASS) |
| `mini-services/voice-clone-service/package.json` | NEW — `bun run dev` / `selftest` |
| `src/lib/voice/local-clone.ts` | NEW — bun-side client (enroll/convert/drop/health, timeouts, honest errors) |
| `mini-services/translator-service/engines/voice.ts` | wired `providerModel === 'local-openvoice'` branch into the clone path (base TTS → convert), ElevenLabs branch unchanged |
| `src/app/api/voice-profile/clone/route.ts` | NEW — POST enroll (profile + on-box ref WAV + SE, rollback on failure), DELETE (right-to-erasure), GET health |
| `prisma/schema.prisma` | `VoiceProfile.refAudioPath String?` (+ db:push) |
| `mini-services/translator-service/e2e-clone-probe.ts` | NEW — live E2E probe (PASS) |
| `src/components/translator/settings-center.tsx`, `src/app/api/voice-profile/route.ts` | honesty copy updates (local clone mention) |
| `voxshift-ml/bench/*` | NEW — reproducible benchmark harness + raw results |

Unchanged on purpose: socket contract, `VoiceEngine` interface, existing ElevenLabs
cloud path, voice-match path, ASR/translation routing.

## Install (this machine — already executed)

```bash
python3 -m venv /home/z/ttsbench
/home/z/ttsbench/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
/home/z/ttsbench/bin/pip install numpy soundfile librosa unidecode matplotlib pypinyin \
  cn2an num2words eng_to_ipa inflect wavmark jieba langid pydub piper-tts onnxruntime speechbrain
git clone --depth 1 https://github.com/myshell-ai/OpenVoice /home/z/OpenVoice
# NOTE: do NOT pip install -e (numpy==1.22 pin breaks on py3.12) — sys.path insert used.
# Weights (HF): myshell-ai/OpenVoiceV2 → /home/z/models/openvoice/{converter,base_speakers/ses}
# Voices: rhasspy/piper-voices v1.0.0 fa_IR-amir-medium + en_US-amy-medium → /home/z/models/piper
```

## Model download procedure / integrity

Weights come from the official HF repos (URLs in VOICE_BENCHMARK_RESULTS.md). OpenVoice v2
has no published checksum — integrity verified by loading (`missing/unexpected keys: [] []`)
+ output format checks in selftest. Sizes: converter 126 MB, piper voices 61 MB each,
ECAPA ~80 MB, F5 base ~1.35 GB (offline option only).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `VOXSHIFT_CLONE_URL` | `http://127.0.0.1:3010` | clone-service address |
| `VOXSHIFT_CLONE_DISABLED` | unset | set to disable the local-clone branch |
| `VOXSHIFT_CLONE_TIMEOUT_MS` | 120000 | per-request timeout |
| `VOXSHIFT_CLONE_PORT` / `VOXSHIFT_OV_DIR` / `VOXSHIFT_CLONE_SE_DIR` / `VOXSHIFT_TORCH_THREADS` | 3010 / `/home/z/models/openvoice/converter` / `/home/z/models/voice-clone` / 2 | service-side |

## Run / deploy

```bash
# 1) clone service (load ≈1–2 s, then listens on 127.0.0.1:3010)
cd mini-services/voice-clone-service && /home/z/ttsbench/bin/python index.py
# 2) existing services (unchanged commands)
cd mini-services/translator-service && bun --hot server.ts     # :3003
bun run dev                                                     # :3000
# 3) self-test
/home/z/ttsbench/bin/python mini-services/voice-clone-service/selftest.py
bun mini-services/translator-service/e2e-clone-probe.ts
```

Enrollment (UI-independent, consent-gated):
```bash
curl -X POST http://localhost:3000/api/voice-profile/clone -H 'Content-Type: application/json' \
  -d '{"audioBase64":"<PCM16 base64>","sampleRate":16000,"consented":true,"name":"My voice"}'
```

## Rollback procedure

1. Set `VOXSHIFT_CLONE_DISABLED=1` (or stop voice-clone-service) → the local-clone branch
   surfaces a honest error and the app falls back to the PRE-EXISTING behavior set
   (voice-match / ElevenLabs) — no code revert needed.
2. Full revert: `git revert` the v3.3.1 commit; `prisma` `refAudioPath` column is nullable
   and additive — older code ignores it. Delete `/home/z/models/voice-clone/*.se` and
   `db/audio/clone-ref/` to erase biometric artifacts.

## Persistence warning (Railway, task §12)

The Railway container is expected to have EPHEMERAL storage (unverified — SSH access is
currently blocked). After any redeploy, the following must be re-created: voice-clone
venv, OpenVoice checkpoints (126 MB), piper voices (2×61 MB), enrolled `.se` embeddings
and `db/audio/clone-ref/*.wav` (user data — keep an encrypted external backup or re-enroll).
The bun/python SOURCE code is in git and survives.
