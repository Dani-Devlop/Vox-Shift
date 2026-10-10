#!/usr/bin/env python3
"""VoxShift warm faster-whisper worker — multilingual ASR with the model resident.

Benchmark (2026-10, CPU int8, sandbox venv):
  en  RTF 0.08 — perfect text WITH punctuation/casing
  fa  RTF ≥ 1.0 and garbled at tiny/base for PURE Persian → vosk stays primary
  BUT tiny is multilingual: it detects the language and renders embedded
  ENGLISH words correctly inside Persian speech — exactly what the fa-only
  vosk model cannot do. The manager (engines/local-asr.ts) runs BOTH engines
  in parallel and merges by word timestamps (v3.6.0 code-switching).

Protocol (line-based JSON on stdio — mirrors piper-worker.py):
  stdin : {"id": "<req-id>", "wav_b64": "<WAV>", "lang": "en"|"fa"|null}
          lang null / "auto" → let the model detect the language.
  stdout: {"type": "ready", "model": "<size|dir>"}                       (boot)
          {"type": "result", "id", "ok": true, "text", "lang",
           "words": [{"w","start","end"}]}            (words = word timestamps)
          {"type": "result", "id", "ok": false, "error": "..."}
          {"type": "fatal", "error": "..."}                           (boot fail)

v3.6.0 robustness: beam_size=2 + vad_filter + condition_on_previous_text=False
— measurably steadier across English accents (the tiny model's main weakness),
at a small RTF cost that stays under 0.15 for utterance-length clips.
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

    model_size = sys.argv[1] if len(sys.argv) > 1 else "tiny"

    # A bundled model DIR (with model.bin) is used directly — no HF download,
    # no network dependency on the host. A bare size name ("tiny") means
    # faster-whisper fetches it from the hub on first boot.
    if not os.path.isdir(model_size):
        here = os.path.dirname(os.path.abspath(__file__))
        bundled = os.path.join(here, "whisper-tiny-ct2")
        if os.path.isfile(os.path.join(bundled, "model.bin")):
            model_size = bundled

    try:
        from faster_whisper import WhisperModel

        # Container CPU quota ≈ 2 vCPUs — pin threads like the piper worker does.
        model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8",
            cpu_threads=2,
            num_workers=1,
        )
        # Warmup so the first real request doesn't pay the lazy-init cost.
        import numpy as np

        silence = np.zeros(16000, dtype=np.float32)
        list(model.transcribe(silence, language="en", beam_size=1)[0])
    except Exception as e:  # noqa: BLE001 — protocol requires an honest fatal
        proto_out.write(json.dumps({"type": "fatal", "error": f"model load failed: {e}"}) + "\n")
        return

    proto_out.write(json.dumps({"type": "ready", "model": model_size}) + "\n")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = ""
        try:
            req = json.loads(line)
            req_id = str(req.get("id", ""))
            wav_b64 = str(req.get("wav_b64", ""))
            lang = req.get("lang")
            # "auto" / absent / null → multilingual detection (no language pin).
            pin = None if lang in (None, "", "auto") else str(lang)
            raw = base64.b64decode(wav_b64)
            wf = wave.open(io.BytesIO(raw), "rb")
            sr = wf.getframerate()
            pcm = wf.readframes(wf.getnframes())
            wf.close()
            audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
            if sr != 16000:
                n = int(len(audio) * 16000 / sr)
                audio = np.interp(
                    np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio
                ).astype(np.float32)
            kwargs = {"beam_size": 2, "vad_filter": True,
                      "condition_on_previous_text": False, "word_timestamps": True}
            if pin:
                kwargs["language"] = pin
            segments, info = model.transcribe(audio, **kwargs)
            words = []
            texts = []
            for seg in segments:
                t = seg.text.strip()
                if t:
                    texts.append(t)
                for w in (getattr(seg, "words", None) or []):
                    token = (w.word or "").strip()
                    if token:
                        words.append({"w": token, "start": round(w.start, 3), "end": round(w.end, 3)})
            text = " ".join(texts).strip()
            detected = getattr(info, "language", None) or pin or "en"
            proto_out.write(
                json.dumps(
                    {
                        "type": "result",
                        "id": req_id,
                        "ok": True,
                        "text": text,
                        "lang": detected,
                        "words": words,
                    }
                )
                + "\n"
            )
        except Exception as e:  # noqa: BLE001 — one bad request must not kill the worker
            try:
                proto_out.write(
                    json.dumps({"type": "result", "id": req_id, "ok": False, "error": str(e)[:300]}) + "\n"
                )
            except Exception:
                pass


if __name__ == "__main__":
    main()
