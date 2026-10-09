# VOICE_BENCHMARK_RESULTS.md — VoxShift v3.3.1

## Hardware / environment (all measurements LOCAL MEASUREMENT)

- Sandbox container: 2 vCPU Intel Xeon (AVX-512F), 3.9 GiB RAM (≈3.4 GiB available), 7.6 GB free disk at start
- Python 3.12.14, torch 2.14.1+cpu (threads=2), onnxruntime CPU, espeak-ng 1.52-dev
- Models: OpenVoice v2 converter checkpoint (126 MB, HF myshell-ai/OpenVoiceV2, resolved 2026-10-09),
  SpeechBrain ECAPA-TDNN (spkrec-ecapa-voxceleb), piper fa_IR-amir-medium + en_US-amy-medium (61 MB each),
  F5-TTS v1 base (HF SWivid, downloaded 2026-10-09)
- Harness: `voxshift-ml/bench/run_bench.py` (+ `score2.py`, `gen_zai_refs.ts`) — reproducible stages:
  refs → synth → score → latency. Raw JSONs: `synth_results.json`, `sim_results.json`,
  `sim2_results.json`, `sim_f5_results.json`, `latency_results.json` (same directory).

## Reference data caveat (important)

No real human reference recordings exist in this environment (user samples were lost in a
platform workspace rollback; no biometric uploads are performed). The benchmark therefore
uses SYNTHETIC pseudo-speakers (espeak-ng fa at two pitches, espeak en-us) AND studio neural
voices (z-ai jam/kazi) as anchors. Consequences, stated plainly:
- ECAPA similarities measured on synthetic speech are COMPRESSED and channel-sensitive —
  e.g. espeak-vs-espeak same-synthesizer pairs score 0.88 while genuine same-neural-voice
  different-sentence pairs score 0.45.
- Therefore **no "95 % similarity" claim is made or supportable here.** What the numbers
  support is the RELATIVE statement: the selected chain moves output substantially toward
  the enrolled speaker, and every claim below is tied to its measurement.

## Speaker-similarity metric harness

- Embedding: ECAPA-TDNN 192-d (SpeechBrain, VoxCeleb-trained), 16 kHz mono input,
  librosa resampling; cosine similarity.
- Discrimination controls (same harness): same-speaker 0.8847 vs different-speaker 0.5841
  (synthetic anchors); neural-voice anchors: same-voice-different-sentence 0.4491 vs
  different-voice 0.4165 (small margin — one reason absolute claims are avoided).
- Cross-language: measured directly (fa reference ↔ en synthesis, below).

## Per-arm results (8 identical sentences: fa conversational/formal/long/short/code-switch,
en conversational/technical/question)

| Arm | Identity evidence | Notes |
|---|---|---|
| B0 espeak raw | channel-confounded (0.72–0.98 vs its own channel) | robotic; baseline fallback |
| B1 piper raw | 0.03–0.16 (identity-free) | natural, native fa voice |
| B2 piper→OpenVoice (SELECTED) | +0.51 cosine toward studio reference (0.025→0.538); scores above the same-voice-different-sentence control (0.538 vs 0.449); beats "different studio voice" distance (0.417) on all fa sentences | cross-lingual: fa base + fa reference and en base + fa reference both improved |
| B4 F5-TTS CPU (offline option) | 0.741 vs fa reference; control 0.474 → margin 0.27 (largest discrimination) | fa-ref → en-text cross-lingual generation works |
| Existing z-ai preset | NOT the user's voice by construction (preset actor) | root cause R1 |

## Latency (20 warm trials, single stream, fa_conv sentence → 5.468 s audio)

OpenVoice conversion stage only (service adds base64/HTTP overhead in production path):
- P50 3.06 s · P95 3.12 s · RTF_P50 0.56 · RTF_P95 0.571 (trials list in latency_results.json)

Piper base synthesis (same sentence class): ≈2.0–2.4 s (RTF ≈ 0.39) → measured end-to-end
live-loop utterance (typed fa→en through the REAL app: translate 1.2 s + TTS chain 4.1 s =
5.3 s total for a short utterance, E2E probe `e2e-clone-probe.ts`, providers.tts
"local-openvoice").

F5-TTS CPU (single trial, nfe_step=16): load ≈ RAM-bound, inference 87.7 s for 3.69 s audio
→ RTF ≈ 23.8, peak RSS 3.3 GB. NOT tested at nfe=32 (time); Fish Speech: NOT TESTED
(insufficient resources for its runtime in this container + license).

## Service-level tests (mini-services/voice-clone-service)

`selftest.py`: **10/10 PASS** — model init, enroll validation (invalid id 400, short ref
rejected), honest 404 on unenrolled convert (no fallback), enroll (256-dim SE), convert fa
(22050 Hz RIFF/WAVE, 3.46 s for 5.17 s audio), convert en, 4× repeated, 2× concurrent,
drop→404 (right-to-erasure).

E2E live probe (`e2e-clone-probe.ts`): **PASS** — enroll → socket utterance → result
providers.tts = "local-openvoice", 210 KB WAV delivered, total 5.31 s.

## Known limitations

1. Synthetic-reference benchmark: absolute similarity numbers are not transferable to real
   users; human-perceived similarity remains UNVERIFIED (no listening panel available in
   this environment — explicitly not claimed).
2. ECAPA itself has a small same/diff margin between neural studio voices — verification
   thresholds are not derived from these numbers.
3. OpenVoice output carries its watermark (wavmark) when ≥~1 s audio; ultra-short clips log
   "fail to add watermark" (harmless, audio still produced).
4. F5-TTS quality measured at reduced NFE (16) for CPU tractability.
5. Railway production box NOT measured — SSH private key was destroyed by the platform
   rollback; numbers above are from the 2-vCPU sandbox class. Railway free-tier containers
   are expected to be smaller → the same code path degrades gracefully (service reports
   honest errors), but NO performance claims are made for that box.
