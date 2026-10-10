#!/usr/bin/env bash
# Boot script — VoxShift voice-clone-service (:3010)
# Restored after platform reset #3 (original script lost; see worklog V33-REST).
# Env:
#   VOXSHIFT_OV_DIR       default /home/z/models/openvoice/converter
#   VOXSHIFT_CLONE_SE_DIR default /home/z/models/voice-clone
#   VOXSHIFT_CLONE_PORT   default 3010
set -u
cd /home/z/my-project/mini-services/voice-clone-service
exec /home/z/.venv/bin/python index.py
