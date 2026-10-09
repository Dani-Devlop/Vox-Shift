# VOICE_MODEL_COMPARISON.md — VoxShift v3.3.1

Date: 2026-10-09 · Sources checked via official repos/model cards + web research (evidence
labels per task §13). Local measurements: 2 vCPU Xeon (AVX-512F), 3.9 GiB RAM, CPU-only.
Persian-specific public benchmarks: **INSUFFICIENT PUBLIC EVIDENCE** for every candidate —
no candidate publishes a Persian speaker-similarity/naturalness benchmark. No number below
substitutes an English benchmark for Persian.

## A. Verified facts (primary sources)

| System | Code license | Weights license | fa support | Verified source |
|---|---|---|---|---|
| Fish Speech / OpenAudio S1 | "FISH AUDIO RESEARCH LICENSE" (repo LICENSE; NOT OSI-open) | same research license; S2 "code and weights" statement unclear → **NEEDS LEGAL REVIEW** | S1 = 13 languages, **fa NOT listed**; S2 claims 80+ (weights not usable per license) | github.com/fishaudio/fish-speech LICENSE; docs.fish.audio "Models Overview"; HF fish-speech-1.4 card; modelscope 1.5 card |
| F5-TTS (SWivid) | MIT (implementation) | **CC-BY-NC-4.0** for Emilia-trained base — non-commercial (author clarification 2025-04) | base model: NO fa (en/zh-centric Emilia + multilingual v1 covers ~en/zh/ja/de/fr/es…); community fa fine-tunes exist but quality unverified | github.com/SWivid/F5-TTS (license + "Clarification on Training Data, Licensing…" 2025-04); arXiv:2410.06885 |
| OpenVoice v2 (MyShell) | MIT (code) | MIT per HF card myshell-ai/OpenVoiceV2 (community discussion about "not fully open" internals noted; weights used here are the published converter+SE) | language-agnostic tone-color converter — fa comes from the base TTS (piper fa_IR-amir) | HF card; arXiv:2312.01479; repo LICENSE |
| Piper (OHF-Voice piper1-gpl) | MIT | voices CC0-ish per voice page (fa_IR-amir-medium from CC0 dataset per prior V31 research) | native fa voice (amir) + en_US voices | rhasspy/piper-voices HF |
| Existing (z-ai preset TTS) | proprietary SaaS | n/a (cloud) | engine voices are zh/en-oriented; fa output heavily accented (LOCAL MEASUREMENT, prior rounds) | this repo |

## B. Local measurements (LOCAL MEASUREMENT — this sandbox, 2 vCPU)

Same reference (spkA), same sentences (8, fa+en+code-switch), ECAPA-TDNN (VoxCeleb)
cosine similarity. Synthetic-reference caveat: ESPEAK-channel outputs (B0) score
inflated vs an espeak reference; the cleanest cross-channel evidence is the
jam-studio test and the F5 ref-vs-control margin.

| Arm | Similarity to target speaker | Latency (P50, warm) | RTF | Peak RAM | Verdict |
|---|---|---|---|---|---|
| B1 piper raw | 0.03–0.16 (≈ identity-free) | ~1.8–2.7 s/sentence | 0.39 | ~200 MB | natural fa/en, no identity |
| **B2 piper→OpenVoice v2 (SELECTED)** | **0.538 vs studio ref** (raw piper 0.025); ref-vs-control margin positive on 8/8 sentences | **3.06 s** conversion (5.47 s audio); full chain ≈ RTF 0.94 | 0.56 (convert) | ~1.5 GB service | near-real-time, identity transferred, MIT, on-box |
| B4 F5-TTS v1 base (CPU, nfe=16) | **0.741** to fa reference (control 0.474) — best identity score, cross-lingual fa-ref→en-text | **87.7 s for 3.7 s audio** | ≈ 24 | **3.3 GB** | quality viable, latency/RAM unusable for live loop on 2 vCPU |
| Fish Speech | NOT TESTED locally — resource (disk/RAM), license (research-only), and no fa in S1 | — | — | — | rejected for this deployment |
| B0 espeak raw | channel-confounded high vs espeak ref; robotic (perceptual) | 0.01 s | ≈0 | ~30 MB | fallback only |
| Existing z-ai preset (kazi) | 0.417 vs a DIFFERENT studio voice = "different person" distance; by design NOT the user | ~1–2.5 s (cloud) | n/a | n/a | root cause of the complaint (R1) |

Reported (NOT independently verified): OpenVoice "1–12 s per sentence depending on
hardware" (third-party); F5-TTS community CPU reports RTF 5–30 — our 23.8 at nfe=16
is consistent with the upper range.

## C. Decision

**Architecture C selected: piper (base, native fa/en) → OpenVoice v2 tone-color
conversion (on-box).** Why it wins over Fish Speech and F5-TTS *for this deployment*:
1. Only candidate that is both near-real-time (RTF≈0.94 full chain) AND identity-bearing
   on the actual 2 vCPU-class hardware.
2. MIT code+weights (Fish Speech: research license; F5 weights: CC-BY-NC).
3. Persian quality comes from a NATIVE fa base voice (piper amir) rather than a model
   that never trained on fa (F5 base) or doesn't list fa (Fish S1).
4. Reference stays on-box (privacy), 6–10 s of clean speech, no transcript needed.
5. Honest failure paths; no GPU dependency (F5 CPU path exists but RTF≈24 measured).

F5-TTS is recorded as the OFFLINE high-fidelity option (replay mode) if a future
deployment adds RAM/CPU or a GPU; not wired into the live loop.
