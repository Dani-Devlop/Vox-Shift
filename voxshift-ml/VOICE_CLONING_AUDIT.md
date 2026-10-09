# VOICE_CLONING_AUDIT.md — VoxShift v3.1.x → v3.3.1 repair baseline

Date: 2026-10-09 · Auditor: VoxShift senior agent (same project, no rewrite)
Scope: the real execution path from speaker enrollment to generated audio, in the
existing codebase (bun translator-service + Next.js APIs). Evidence status labels
per task §13.

## 1. Current pipeline (traced in code, VERIFIED BY PRIMARY SOURCE = this repo)

```
Mic → VAD utterance (browser PCM 16k) → socket.io :3003 → pipeline.ts
  → speaker tracking (voiceprint 57-dim, src/lib/speaker/voiceprint.ts)
  → ASR (routed: local vosk / user server / builtin z-ai)
  → translation (routed: local ollama / user / builtin GLM)
  → TTS/voice: pipeline.ts:324 → VoiceIdentityEngine.synthesize (engines/voice.ts)
      ├─ profileMode 'clone'      → ElevenLabsCloneEngine (CLOUD, ELEVENLABS_API_KEY)
      └─ profileMode 'voice-match'→ routedCall('tts'):
            local   → local-tts.ts   (espeak-ng / piper — NO speaker identity)
            server  → user OpenAI-compatible endpoint (NO identity)
            builtin → ZaiVoiceEngine: preset voice + pitch conform
  → WAV base64 → socket → browser playback
```

Enrollment (`POST /api/voice-profile`, route.ts:148):
`analyzePcm()` → meanF0 / f0Std / spectralCentroid / voicedRatio →
`mappedVoice` = ONE of 7 z-ai preset voices (tongtong, chuichui, xiaochen,
jam, kazi, douji, luodo) + `pitchRatio` = user F0 ÷ preset center F0 and
`speedAdjust`. Store: Prisma `VoiceProfile` (no reference audio is retained;
`local-*` artifacts rule kept reference WAVs out of git, and no enrollment
audio is persisted for generation at all).

## 2. Root causes of the voice mismatch (all verified in code)

| # | Cause | Evidence |
|---|-------|----------|
| R1 | **The generated voice is a preset studio voice, not the speaker.** `voice-match` maps the user to `tongtong/kazi/…` and only pitch-shifts the result. Timbre, formants, age, accent and prosody are the preset actor's — the ±33 % pitch clamp (voice.ts:37) cannot make kazi sound like the user. | engines/voice.ts:48-93, route.ts:208 |
| R2 | **Cross-language presets are wrong-accented.** z-ai voices are zh-oriented; Persian output through them is heavily accented (documented since v1.x; still true in v3.1). | worklog §Interpreter β known risk |
| R3 | **The real cloning path is cloud-only.** `clone` mode = ElevenLabs IVC; requires `ELEVENLABS_API_KEY` (absent in this deployment) and sends the user's biometric voice to a third party. Without it the engine refuses honestly → users effectively live on R1. | engines/voice-clone.ts, voice.ts:127-147 |
| R4 | **The local TTS branch has zero identity.** espeak-ng/piper synthesize a generic voice; the user's reference never enters this path. | local-tts.ts |
| R5 | **The 57-dim voiceprint is used only for identification**, never generation. `computeVoiceprint` output is not consumed by any TTS branch. | pipeline.ts:18, voiceprint.ts |
| R6 | **Reference audio for generation does not exist in storage.** Enrollment analyzes and discards; `VoiceProfile` has no `refAudioPath`, so no architecture (A/B/C) can even start from the current DB. | prisma/schema.prisma:38-58 |

## 3. Baseline (captured before any change)

- Code revision: `aab33e9` (local; GitHub remote `81b57d0` — push pending user token).
- Runtime facts: sandbox 2 vCPU Xeon (AVX-512F), 3.9 GiB RAM (3.4 avail), 7.6 GB free disk,
  Python 3.12.14; espeak-ng present; vosk fa/en models restored; piper absent; Ollama absent.
- Baseline audio behaviors:
  - z-ai `kazi` + pitch conform → natural studio voice, WRONG identity (R1) — LOCAL MEASUREMENT pending in benchmark set B0.
  - espeak-ng fa → robotic, WRONG identity, poor naturalness — measured in B0.
- No speaker-similarity metric existed anywhere in the repo (verification harness built this round).

## 4. Bugs / defects found during the audit (fixed or noted)

1. `.gitignore` `local-*` rule excluded runtime SOURCE files (v3.0 loss, repaired in
   GH-PUSH-5) — and would have silently excluded any future `local-*.ts` fix. Negations added.
2. A scheduled review agent committed 65 MB of vosk model binaries into git (`d97f9fe`,
   local-only, never pushed). Reverted → weights moved to `/home/z/models`, `vosk-model-*`
   + `models/` now ignored (`aab33e9`).
3. SSH private key for the Railway box was destroyed by the platform workspace rollback
   (`/home/z/.ssh` gone). Access blocked until the user registers the regenerated public key
   (delivered in the final report). No server-side claims are made in its absence.

## 5. What the repair must achieve (acceptance targets)

- Generated speech carries the enrolled speaker's TIMBRE (not a preset actor's).
- fa + en output, cross-lingual identity preserved (fa reference → en speech and reverse).
- Works CPU-only within the actual deployment class (2 vCPU-class container; Railway free
  box pending access = likely weaker).
- Honest mode labeling + measured (not claimed) similarity; no silent preset fallback.
- Existing interfaces preserved (VoiceEngine.synthesize, socket contract, profile API).
