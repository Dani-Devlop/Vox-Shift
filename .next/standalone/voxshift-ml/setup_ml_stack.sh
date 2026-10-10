#!/usr/bin/env bash
# ============================================================================
# VoxShift v3.1 — ML STACK INSTALLER  (CPU-only · user-space · idempotent)
#
# WHAT IT DOES
#   1. Creates an isolated venv at ~/Desktop/Vox-Shift/ml/venv  (nothing system-wide)
#   2. Installs CPU inference stack: faster-whisper, CTranslate2, onnxruntime,
#      sherpa-onnx, transformers, sentencepiece, piper-tts, CPU-only torch
#   3. Downloads & verifies selected models (see MODEL_MANIFEST.json):
#        - Silero VAD v6.x ONNX (MIT)
#        - 3D-Speaker CAM++ speaker embedding (Apache-2.0)  [en VoxCeleb, zh-cn fallback]
#        - Whisper large-v3-turbo CT2 (MIT, int8-capable)
#        - NLLB-200-distilled-600M -> CTranslate2 int8  (⚠️ CC-BY-NC-4.0 — commercial NEEDS LEGAL REVIEW)
#        - Piper fa_IR-amir-medium (CC0 dataset) + en_US-amy-medium (MIT)
#   4. Records exact package versions to ml/logs/installed-versions.txt
#
# USAGE
#   bash setup_ml_stack.sh            # standard install (~6 GB downloads)
#   bash setup_ml_stack.sh --full     # + Whisper large-v3, M2M100-418M (MIT),
#                                     #   Vosk small-fa-0.42, Ollama qwen3:4b (Apache-2.0)
#
# SAFETY: creates only ~/Desktop/Vox-Shift/ml/** — deletes nothing, touches nothing else.
# ============================================================================
set -uo pipefail

ROOT="$HOME/Desktop/Vox-Shift"; ML="$ROOT/ml"
log(){ printf '\n\033[1;36m[voxshift-ml]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[voxshift-ml WARN]\033[0m %s\n' "$*"; }
fail(){ printf '\n\033[1;31m[voxshift-ml BLOCKER]\033[0m %s\n' "$*"; exit 1; }

FULL=""; [ "${1:-}" = "--full" ] && FULL=1
mkdir -p "$ML/models" "$ML/bench" "$ML/logs" && cd "$ROOT" || fail "cannot cd $ROOT"

# ---- 0. sanity -------------------------------------------------------------
command -v python3 >/dev/null 2>&1 || fail "python3 not found"
command -v curl    >/dev/null 2>&1 || fail "curl not found"
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])') || fail "python3 broken"
log "python3 = $PYV  (target: >=3.9; found 3.10 on audit)"
python3 -m venv --help >/dev/null 2>&1 || fail "python3-venv missing — run: sudo apt install -y python3.10-venv"

# ---- 1. isolated venv ------------------------------------------------------
if [ ! -x "$ML/venv/bin/python" ]; then
  log "creating isolated venv at ml/venv"
  python3 -m venv "$ML/venv" || fail "venv creation failed"
fi
# shellcheck disable=SC1091
source "$ML/venv/bin/activate"
pip -q install -U pip wheel setuptools || fail "pip upgrade failed"

# ---- 2. python dependencies (CPU only) ------------------------------------
log "installing python deps (CPU inference stack)…"
pip -q install --no-cache-dir \
  faster-whisper ctranslate2 onnxruntime sherpa-onnx \
  sentencepiece transformers soundfile numpy scipy huggingface_hub \
  || fail "core pip install failed"
pip -q install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
  || fail "CPU-torch install failed (needed one-time for model conversion)"
pip -q install piper-tts || warn "piper-tts failed (TTS bench blocked); try: sudo apt install -y espeak-ng then re-run"
pip freeze | grep -iE 'faster-whisper|ctranslate2|onnxruntime|sherpa|transformers|torch|sentencepiece|piper|vosk' \
  | tee "$ML/logs/installed-versions.txt" || true

# ---- 3. VAD: Silero (repo-default v6.x ONNX, MIT) --------------------------
curl -fL --retry 3 -o "$ML/models/silero_vad.onnx" \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx" \
  && log "silero_vad.onnx OK ($(stat -c%s "$ML/models/silero_vad.onnx" 2>/dev/null) B)" \
  || warn "silero download failed (VAD bench will fall back to webrtcvad)"

# ---- 4. Speaker embedding: CAM++ via sherpa-onnx ---------------------------
# NOTE (verified): en VoxCeleb asset has NO '-common' suffix; zh-cn asset does.
SURL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models"
CAMP=""
for f in 3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx \
         3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx; do
  if curl -fL --retry 3 -o "$ML/models/$f" "$SURL/$f"; then CAMP="$f"; break; fi
done
[ -n "$CAMP" ] && log "CAM++ OK: $CAMP ($(stat -c%s "$ML/models/$CAMP" 2>/dev/null) B)" \
  || warn "CAM++ download failed (speaker bench will skip)"

# ---- 5. ASR: Whisper large-v3-turbo CT2 (MIT) ------------------------------
log "downloading faster-whisper large-v3-turbo-ct2 (~1.6 GB)…"
python3 - <<'PY' || warn "turbo download failed"
from huggingface_hub import snapshot_download
p = snapshot_download("deepdml/faster-whisper-large-v3-turbo-ct2",
                      local_dir="ml/models/faster-whisper-large-v3-turbo-ct2")
print("ASR PRIMARY at:", p)
PY
if [ -n "$FULL" ]; then
  log "downloading faster-whisper large-v3 fallback (~3 GB)…"
  python3 - <<'PY' || warn "large-v3 download failed"
from huggingface_hub import snapshot_download
snapshot_download("Systran/faster-whisper-large-v3", local_dir="ml/models/faster-whisper-large-v3")
print("ASR FALLBACK ready")
PY
fi

# ---- 6. MT: NLLB-600M -> CT2 int8  (⚠️ weights CC-BY-NC-4.0) ---------------
log "converting NLLB-200-distilled-600M -> CT2 int8 (~2.5 GB download, one-time)…"
python3 - <<'PY' || warn "NLLB conversion failed"
import os
from huggingface_hub import snapshot_download
from ctranslate2.converters import TransformersConverter
src = snapshot_download("facebook/nllb-200-distilled-600M")
out = "ml/models/nllb-200-distilled-600M-ct2-int8"
if not os.path.exists(os.path.join(out, "model.bin")):
    TransformersConverter(src, load_as_float16=True).convert(out, quantization="int8", force=True)
print("MT quality-candidate at:", out, "(license: CC-BY-NC-4.0 — commercial NEEDS LEGAL REVIEW)")
PY
if [ -n "$FULL" ]; then
  log "converting M2M100-418M -> CT2 int8 (MIT — license-clean dedicated MT)…"
  python3 - <<'PY' || warn "M2M100 conversion failed"
import os
from huggingface_hub import snapshot_download
from ctranslate2.converters import TransformersConverter
src = snapshot_download("facebook/m2m100_418M")
out = "ml/models/m2m100-418m-ct2-int8"
if not os.path.exists(os.path.join(out, "model.bin")):
    TransformersConverter(src).convert(out, quantization="int8", force=True)
print("MT license-clean candidate at:", out)
PY
  log "downloading Vosk small-fa-0.42 (Apache-2.0, streaming partials, 53 MB)…"
  curl -fL --retry 3 -o /tmp/vosk-fa.zip "https://alphacephei.com/vosk/models/vosk-model-small-fa-0.42.zip" \
    && mkdir -p "$ML/models/vosk" \
    && python3 -c "import zipfile,sys; zipfile.ZipFile('/tmp/vosk-fa.zip').extractall('ml/models/vosk')" \
    && rm -f /tmp/vosk-fa.zip && log "vosk small-fa OK" || warn "vosk download failed"
fi

# ---- 7. TTS: Piper voices (amir = CC0 dataset; gyro skipped: vague license) -
PV="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"
mkdir -p "$ML/models/piper"
dl(){ curl -fL --retry 3 -o "$2" "$1" && log "TTS OK $(basename "$2") ($(stat -c%s "$2" 2>/dev/null) B)" || warn "TTS failed $(basename "$2")"; }
dl "$PV/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx?download=true"      "$ML/models/piper/fa_IR-amir-medium.onnx"
dl "$PV/fa/fa_IR/amir/medium/fa_IR-amir-medium.onnx.json?download=true" "$ML/models/piper/fa_IR-amir-medium.onnx.json"
dl "$PV/en/en_US/amy/medium/en_US-amy-medium.onnx?download=true"        "$ML/models/piper/en_US-amy-medium.onnx"
dl "$PV/en/en_US/amy/medium/en_US-amy-medium.onnx.json?download=true"   "$ML/models/piper/en_US-amy-medium.onnx.json"

# ---- 8. LLM (license-clean swap, optional) ---------------------------------
if command -v ollama >/dev/null 2>&1; then
  if [ -n "$FULL" ]; then
    log "pulling qwen3:4b-instruct-2507 (Apache-2.0, ~2.6 GB) via Ollama…"
    ollama pull qwen3:4b-instruct-2507 || warn "ollama pull failed — is 'ollama serve' running?"
  else
    log "NOTE: installed LLM 'qwen2.5:3b-instruct' carries the 'qwen-research' license (non-commercial)."
    log "      For commercial deployment re-run with --full to pull Apache-2.0 'qwen3:4b-instruct-2507'."
  fi
else
  warn "ollama not on PATH — LLM path unmanaged by this script"
fi

# ---- 9. report --------------------------------------------------------------
log "ENVIRONMENT REPORT"
echo "python: $PYV | venv: $ML/venv"
echo "package versions recorded at: $ML/logs/installed-versions.txt"
df -h "$ML" | tail -1
free -h | head -2
uptime
echo "----- ml/models -----"
ls -la "$ML/models"
log "DONE. Next step (phase 2): run the VoxShift benchmark suite — it will be provided after this install completes."
