# VoxShift v3.1 — Research Digest & Source Audit
Compiled 2026-10-09 from fresh web research (12 searches + ~30 primary-source fetches: HF model cards, GitHub LICENSE/README, arXiv, alphacephei, PyPI).
Labels: [PRIMARY]=official repo/paper/model card · [THIRD-PARTY]=independent benchmark · [COMMUNITY]=forum/report · [UNVERIFIED]=not confirmed.

## 1. VAD
| Candidate | Exact checkpoint | License | CPU | Verdict |
|---|---|---|---|---|
| **Silero VAD (SELECTED)** | `snakers4/silero-vad` → `src/silero_vad/data/silero_vad.onnx` (repo-default = v6.x, 2,327,524 B, HTTP 200 [PRIMARY]) | MIT | "<1 ms per 30 ms chunk, 1 thread" [PRIMARY README] | PRIMARY |
| WebRTC VAD | `pypi:webrtcvad` 2.0.10 | MIT/BSD-3 | µs/frame, higher false-positive rate | FALLBACK |
| TEN-VAD | `TEN-framework/ten-vad` | Apache-2.0 **+ Agora anti-competition rider** | — | REJECTED (license trap) |

## 2. Speaker embedding / recognition
| Candidate | Exact checkpoint | License | Quality | Verdict |
|---|---|---|---|---|
| **CAM++ via sherpa-onnx (SELECTED)** | `k2-fsa/sherpa-onnx` release tag `speaker-recongition-models` (typo is real) → **`3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`** (29,596,978 B, HTTP 200 — NOTE: no `-common` suffix) ; alt `…_zh-cn_16k-common.onnx` (28,281,138 B, HTTP 200) | Apache-2.0 (3D-Speaker) | **EER 0.73% VoxCeleb1-O, 6.78% CN-Celeb** [PRIMARY: arXiv 2303.00332] | PRIMARY (no fa-trained checkpoint exists → validate thresholds on own data) |
| SpeechBrain ECAPA | `speechbrain/spkrec-ecapa-voxceleb` | Apache-2.0 | EER 0.80% VoxCeleb1-test cleaned [PRIMARY card] | FALLBACK (heavier; torch) |

## 3. ASR
| Candidate | Exact checkpoint | License | Persian | Verdict |
|---|---|---|---|---|
| **faster-whisper large-v3-turbo (SELECTED)** | `deepdml/faster-whisper-large-v3-turbo-ct2` (HTTP 200; canonical per SYSTRAN maintainer in issue #1025; community-maintained) | MIT | inherits Whisper turbo multilingual | PRIMARY (int8) |
| Whisper large-v3 (fallback) | `Systran/faster-whisper-large-v3` (HTTP 200) | MIT | paper: no per-language v3 numbers; "10–20% error reduction vs v2" [PRIMARY card] | FALLBACK |
| faster-whisper runtime | `SYSTRAN/faster-whisper` v1.2.1, int8 on CPU supported [PRIMARY README]; only official CPU bench = **small** model: 13-min audio in 1m42s, 8 threads, int8, 1477 MB → RTF≈0.13 | MIT | — | ENGINE |
| **Vosk small-fa-0.42** (streaming partials option) | `vosk-model-small-fa-0.42` (53 MB) | Apache-2.0 | **WER 23.4 (CV17) / 14.0 (FLEURS)** [PRIMARY alphacephei]; big fa model 16.7/11.1; newer 0.5 models are WORSE (29.7) — pin 0.42 | OPTIONAL partials |
| Kyutai STT | `stt-1b-en_fr`, `stt-2.6b-en` | — | **no fa** | REJECTED |
| Meta Omnilingual CTC 300M int8 (sherpa-onnx conversion, 2025-11) | `csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12` | check | fa among "1600 langs" | WATCHLIST (streaming status [UNVERIFIED]) |

**Persian WER ground truth (Whisper paper, appendix D.2.2/D.2.4 [PRIMARY]):** large-v2 → FLEURS-fa **32.9%**, Common Voice 9-fa **35.1%**. No official large-v3/turbo per-language fa WER exists. Any "8.4% fa WER" claim must be re-measured on VoxShift's own test set.

## 4. Machine translation
| Candidate | Exact checkpoint | License (weights) | Persian | Verdict |
|---|---|---|---|---|
| **Ollama LLM (SELECTED production path)** | qwen2.5:3b-instruct (INSTALLED ✅) | ⚠️ **qwen-research license — NOT Apache-2.0** [PRIMARY card] | ✅ | benchmark as installed; commercial → swap to **qwen3:4b-instruct-2507** or **qwen2.5:1.5b-instruct** (both Apache-2.0, verified [PRIMARY]) |
| NLLB-200-distilled-600M | `facebook/nllb-200-distilled-600M` (HTTP 200) → CT2 int8 (supported [PRIMARY CHANGELOG]) | ⚠️ **CC-BY-NC-4.0 (non-commercial)** [PRIMARY card] | ✅ `pes_Arab` | QUALITY CANDIDATE — commercial NEEDS LEGAL REVIEW |
| M2M100-418M | `facebook/m2m100_418M` | **MIT** [PRIMARY] | ✅ fa↔en (2200 directions) | LICENSE-CLEAN dedicated-MT candidate (quality unverified → bench) |
| ~~opus-mt-en-fa / fa-en~~ | **DO NOT EXIST (HTTP 401 both)** | — | — | PREVIOUS REPORTS WRONG |
| opus-mt-tc-big-fa-itc | `Helsinki-NLP/opus-mt-tc-big-fa-itc` | CC-BY-4.0 | fa→fr/pt/ro only — **no English** | REJECTED |
| Tatoeba-Challenge fas-eng | zip from Helsinki-NLP/Tatoeba-Challenge (BLEU 38.2 tatoeba-test / 18.5 tico19 [PRIMARY]) | per-model | ✅ | awkward distribution; watchlist |

## 5. TTS
| Candidate | Exact checkpoint | License | Persian | Verdict |
|---|---|---|---|---|
| **Piper (SELECTED)** | engine: `pip install piper-tts` (piper1-gpl; orig. rhasspy/piper says "development has moved") | GPL (engine) / MIT (orig.) | via espeak-ng fa phonemization | PRIMARY ENGINE |
| **fa_IR-amir-medium** | `rhasspy/piper-voices@v1.0.0` → `fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx` (63,531,379 B, HTTP 200) | MIT; dataset **CC0** [PRIMARY MODEL_CARD] | ✅ 22.05 kHz | PRIMARY fa voice |
| en_US-amy-medium | same repo (63,201,294 B, HTTP 200) | MIT | ✅ en | PRIMARY en voice |
| fa_IR-gyro-medium | HTTP 200 | dataset license vague ("See URL") | ✅ | SKIP (license) |
| Published RTF | none authoritative [UNVERIFIED]; "real-time on RPi4" [COMMUNITY] | → local bench required | | |

## 6. Voice cloning / conversion (CPU reality check)
| Candidate | License | CPU reality | Verdict |
|---|---|---|---|
| OpenVoice v2 | **MIT code + weights — "Free for commercial use" since April 2024** [PRIMARY card] | **30–120 s per utterance** [COMMUNITY]; tone converter 3–5× RT [THIRD-PARTY] | OFFLINE-ONLY (enrollment-time tone profiling) |
| XTTS-v2 | **CPML non-commercial** [PRIMARY card] | GPU-first | REJECTED |
| F5-TTS | weights **CC-BY-NC-4.0** [PRIMARY] | GPU-first | REJECTED |
| CosyVoice2-0.5B | Apache-2.0 [PRIMARY] | CPU feasibility [UNVERIFIED] | WATCHLIST |

**Conclusion:** real-time zero-shot cloning on CPU is NOT viable with any open engine. VoxShift architecture: OpenVoice v2 tone-color transfer as **offline enrollment pass** (per Voice Contact) + live Piper synthesis with the existing per-contact pitch/formant mapping (`src/lib/voice/pitch-shift.ts`, `mapping.ts`). Cloud IVC (ElevenLabs) remains the real-time cloning path.

## 7. LID
- Whisper `detect_language` on first segment (free, already in engine) — PRIMARY; fa/en confusion unlikely (script + phonology distance) but validate locally.
- `speechbrain/lang-id-voxlingua107-ecapa` — Apache-2.0, **Persian explicitly supported** [PRIMARY card] — FALLBACK if dedicated LID needed (torch).

## URL verification (curl -sI)
| URL | Status | Size |
|---|---|---|
| silero-vad raw onnx | 200 | 2,327,524 B |
| campplus en voxceleb (no `-common`) | 200 | 29,596,978 B |
| campplus zh-cn common | 200 | 28,281,138 B |
| Systran/faster-whisper-large-v3 | 200 | — |
| deepdml/faster-whisper-large-v3-turbo-ct2 | 200 | — |
| facebook/nllb-200-distilled-600M | 200 | — |
| ~~Helsinki-NLP/opus-mt-en-fa~~ | **401 (does not exist)** | — |
| ~~Helsinki-NLP/opus-mt-fa-en~~ | **401 (does not exist)** | — |
| piper fa_IR-amir-medium.onnx | 200 | 63,531,379 B |
| piper fa_IR-gyro-medium.onnx | 200 | 63,122,309 B |
| piper en_US-amy-medium.onnx | 200 | 63,201,294 B |
| myshell-ai/OpenVoiceV2 | 200 | — |
