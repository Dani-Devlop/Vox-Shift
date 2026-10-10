#!/usr/bin/env python3
"""VoxShift warm piper worker — keeps the ONNX voice resident in RAM.

Protocol (line-based JSON on stdio):
  stdin : {"id": "<req-id>", "text": "...", "length_scale": 1.0}
  stdout: {"type": "ready", "model": "..."}                       (once, at boot)
          {"type": "result", "id": "...", "ok": true, "b64": "..."}  (base64 WAV)
          {"type": "result", "id": "...", "ok": false, "error": "..."}
          {"type": "fatal", "error": "..."}                        (model load failed)

Stray stdout (piper/onnxruntime logs) is redirected to stderr so the protocol
stream stays clean. The manager (engines/local-tts.ts) spawns one worker per
voice model and falls back to the one-shot piper CLI if this process fails.
"""

import base64
import io
import json
import os
import sys
import wave


def main() -> None:
    # Dedicated protocol stream BEFORE any import noise; everything else -> stderr.
    proto_out = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)

    if len(sys.argv) < 2:
        proto_out.write(json.dumps({"type": "fatal", "error": "model path required"}) + "\n")
        return

    model_path = sys.argv[1]
    try:
        # Container CPU quota is typically 2 vCPUs while os.cpu_count() reports
        # the HOST core count (48) — default ONNX session options then spawn
        # ~48 threads for a 2-CPU budget and thrash (measured 2.8s vs 0.15s).
        # Constrain the session BEFORE the voice loads.
        try:
            import onnxruntime as _ort

            _orig = _ort.SessionOptions

            class _LimitedSessionOptions(_orig):  # type: ignore[name-defined]
                def __init__(self, *a, **k):
                    super().__init__(*a, **k)
                    self.intra_op_num_threads = 2
                    self.inter_op_num_threads = 1
                    self.execution_mode = _ort.ExecutionMode.ORT_SEQUENTIAL

            _ort.SessionOptions = _LimitedSessionOptions
        except Exception:
            pass  # best-effort — stock behavior is still correct, just slower

        from piper import PiperVoice, SynthesisConfig

        voice = PiperVoice.load(model_path)
    except Exception as e:  # noqa: BLE001 — protocol requires an honest fatal
        proto_out.write(json.dumps({"type": "fatal", "error": f"model load failed: {e}"}) + "\n")
        return

    proto_out.write(
        json.dumps({"type": "ready", "model": os.path.basename(model_path)}) + "\n"
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = ""
        try:
            req = json.loads(line)
            req_id = str(req.get("id", ""))
            text = str(req.get("text", "")).strip()
            length_scale = float(req.get("length_scale", 1.0))
            if not text:
                raise ValueError("empty text")
            cfg = SynthesisConfig(length_scale=max(0.25, min(4.0, length_scale)))
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wav:
                voice.synthesize_wav(text, wav, syn_config=cfg)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            proto_out.write(
                json.dumps({"type": "result", "id": req_id, "ok": True, "b64": b64}) + "\n"
            )
        except Exception as e:  # noqa: BLE001 — respond, never crash the worker
            proto_out.write(
                json.dumps(
                    {"type": "result", "id": req_id, "ok": False, "error": str(e)[:300]}
                )
                + "\n"
            )


if __name__ == "__main__":
    main()
