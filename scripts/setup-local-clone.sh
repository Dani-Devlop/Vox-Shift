#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VoxShift local voice-clone stack installer (v3.7.0)
#
# Installs + verifies the LOCAL zero-shot cloning engines for any host that can
# afford them (measured CPU floors: fish-speech 2.6 GB, f5-tts 3.2 GB — the
# process peak RSS on a 2-core CPU sandbox was 2306 MB / 2875 MB respectively).
#
# WHY THIS EXISTS: on shared platforms (Railway et al.) /proc/meminfo describes
# the HOST (hundreds of GB shared by all projects) while the container's cgroup
# caps the service at its own slice. The detector (src/lib/voice/clone-chain.ts)
# reads BOTH and refuses engines the cgroup cannot afford — honestly. Run this
# script AFTER raising the service memory (or on any server/GPU box), and the
# SAME priority chain picks the local engines up automatically — no code change.
#
# Usage:  bash scripts/setup-local-clone.sh [--with-fish] [--with-f5]
#         (default: both)
# Env:    VOXSHIFT_MODELS_DIR (default /home/z/models)
#         VOXSHIFT_RAM_BUDGET_MB (optional operator override for the RAM gate)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODELS_DIR="${VOXSHIFT_MODELS_DIR:-/home/z/models}"
FISH_REPO="$MODELS_DIR/fish-speech-src"
FISH_WEIGHTS="$MODELS_DIR/fish-speech/checkpoints/fish-speech-1.5"
WANT_FISH=1; WANT_F5=1
for arg in "$@"; do
  case "$arg" in
    --with-fish) WANT_FISH=1; WANT_F5=0 ;;
    --with-f5)   WANT_F5=1; WANT_FISH=0 ;;
  esac
done

echo "▶ VoxShift local-clone setup — models dir: $MODELS_DIR"

# ── 1. CPU torch pair (torchaudio 2.8 keeps the soundfile backend; 2.9+
#       hard-requires torchcodec + ffmpeg shared libs — avoid that tree). ──
python3 -m pip install --index-url https://download.pytorch.org/whl/cpu \
  "torch==2.8.0" "torchaudio==2.8.0"

if [ "$WANT_F5" = "1" ]; then
  echo "▶ F5-TTS: pip install (weights auto-download on first load)"
  python3 -m pip install f5-tts
fi

if [ "$WANT_FISH" = "1" ]; then
  echo "▶ Fish Speech v1.5.0: source checkout + inference deps + weights"
  if [ ! -d "$FISH_REPO/tools/inference_engine" ]; then
    git clone --depth 1 --branch v1.5.0 https://github.com/fishaudio/fish-speech.git "$FISH_REPO"
  fi
  # Minimal INFERENCE dep set — deliberately NOT `pip install -e .` (the
  # upstream pin torch<=2.4.1 would downgrade the runtime for every engine).
  python3 -m pip install hydra-core einops librosa loguru loralib pyrootutils \
    "einx[torch]==0.2.2" "vector-quantize-pytorch==1.14.24" tiktoken cachetools \
    silero-vad pytorch-lightning lightning natsort
  python3 - "$FISH_WEIGHTS" <<'PY'
import sys, os
from huggingface_hub import snapshot_download
dest = sys.argv[1]
os.makedirs(dest, exist_ok=True)
snapshot_download(
    "fishaudio/fish-speech-1.5", local_dir=dest,
    allow_patterns=["model.pth", "config.json", "special_tokens.json",
                    "tokenizer.tiktoken", "firefly-gan-vq-fsq-8x1024-21hz-generator.pth"])
print("fish weights →", dest)
PY
fi

cat <<'EOF'
✔ Setup finished. Restart the translator (and the app) so the 30 s detection
  cache resets — the About page will then show the engines the cgroup affords.

  Effective memory knobs (src/lib/voice/clone-chain.ts):
    VOXSHIFT_RAM_BUDGET_MB   operator-declared usable RAM (wins outright)
    VOXSHIFT_TEST_RAM_MB     deterministic test hook (probes only)

  Reference transcripts (optional but recommended — fish + f5 condition on
  them; f5 without one pulls a whisper model mid-flight):
    put `<profileId>.txt` next to `<profileId>.wav` in db/audio/clone-ref/
    or set VOXSHIFT_CLONE_REF_TEXT.

  Chain probe after install:
    bun run tests/probe-clone-synth.ts     # real synthesis through the worker
EOF
