# VoxShift v3.1 — Previous-Report Claims Audit (§26)
Every claim from the two prior research reports, verified against primary sources (2026-10-09).
Labels: VERIFIED BY PRIMARY SOURCE / THIRD-PARTY BENCHMARK / REPORTED / UNSUPPORTED / ESTIMATE / INCORRECT / OUTDATED.

| # | Previous claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "Faster-Whisper Persian WER ≈ 8.4%" | **INCORRECT as stated** (no test set was ever cited) | Whisper paper [PRIMARY]: large-v2 FLEURS-fa = **32.9%**, CV9-fa = **35.1%**. No official large-v3/turbo per-language fa WER exists. A ~8% figure would require a much cleaner/specific test set — must be re-measured locally on the fixed VoxShift test set. |
| 2 | "Whisper CPU RTF ≈ 0.04" | **UNSUPPORTED** (for large models on CPU) | Only official faster-whisper CPU bench [PRIMARY]: **small** model, int8, 8 threads i7-12700K: 13-min audio in 1m42s → **RTF ≈ 0.13 for small only**. No official large-v3 CPU RTF exists. Local 48-vCPU bench required. |
| 3 | "NLLB latency ≈ 18–30 ms" | **UNVERIFIED / optimistic** | NLLB-600M ct2-int8 short-sentence latency on 48 vCPU plausibly 50–300 ms; 18–30 ms was never demonstrated. Local bench required. Also weights are **CC-BY-NC-4.0** (previous reports did not flag). |
| 4 | "Piper RTF ≈ 0.02" | **REPORTED / NOT INDEPENDENTLY VERIFIED** | No authoritative published RTF found in current Piper/piper1-gpl docs; community "real-time on RPi4" [COMMUNITY]. Local bench required. |
| 5 | "OpenVoice CPU latency ≈ 48–55 ms" | **INCORRECT** (off by ~3 orders of magnitude) | Community/3rd-party [COMMUNITY, THIRD-PARTY]: **30–120 s per utterance** on CPU; tone converter 3–5× real-time. Real-time CPU cloning is infeasible → architecture changed to offline enrollment. |
| 6 | "Diart/Pyannote latency ≈ 28 ms" | **UNSUPPORTED / OUTDATED** | No reproducible CPU source; pyannote models additionally require HF-token gating. Not selected; replaced by online clustering over CAM++ embeddings. |
| 7 | "CAM++ EER ≈ 0.78%" | **VERIFIED BY PRIMARY SOURCE** (approximately correct) | 3D-Speaker paper [PRIMARY arXiv 2303.00332]: **0.73%** VoxCeleb1-O (6.78% CN-Celeb). Caveat: no Persian-trained checkpoint exists — thresholds must be re-validated on VoxShift data. |
| 8 | "Opus-MT usable for fa↔en" (implied fallback) | **INCORRECT** | `Helsinki-NLP/opus-mt-en-fa` and `opus-mt-fa-en` **do not exist (HTTP 401)**. Real alternatives: M2M100-418M (MIT), NLLB-600M (CC-BY-NC), LLM-based translation. |
| 9 | "Qwen2.5-3B-Instruct is Apache-2.0" (implied safe) | **INCORRECT** | HF card [PRIMARY]: license = **qwen-research** (non-commercial). Apache-2.0 swaps: Qwen2.5-1.5B-Instruct, Qwen3-4B-Instruct-2507. |
| 10 | Claimed RAM/CPU allocations, ONNX/INT8 compatibility | **PLAUSIBLE → to be confirmed by local bench** | Machine actually exposes 48 vCPU (not 42 physical), 89 GiB available RAM. INT8 confirmed available in faster-whisper/CT2 [PRIMARY] and sherpa-onnx; hardware VNNI/AVX-512 confirmed ACTUALLY present (audit §2). |
