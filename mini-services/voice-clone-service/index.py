#!/usr/bin/env python3
"""VoxShift voice-clone-service (v3.3.1) — OpenVoice v2 tone-color conversion.

Architecture C (measured winner for CPU-only live loop):
  base TTS (piper, in the bun translator-service) → THIS service converts the
  synthesized audio's tone color to the enrolled speaker → final WAV.

Endpoints (127.0.0.1 only, behind the Caddy gateway):
  GET  /health                        → {status, modelLoaded, speakers, device}
  POST /enroll  {speakerId, wavBase64}→ extract + persist SE, returns {ok, seDims}
  POST /convert {speakerId, wavBase64, tau?} → {wavBase64, sr, convertMs}
  POST /drop    {speakerId}           → remove cached SE (privacy: right-to-erasure)

Design constraints honored from VOICE_CLONING_AUDIT.md:
  - models load ONCE (lazy on first use), torch threads = 2 (vCPU budget)
  - honest errors (no silent fallback), WAV in/out, strict id charset
  - SE cache on disk: /home/z/models/voice-clone/{speakerId}.se  (artifact, untracked)
"""
import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import soundfile as sf
import torch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, "/home/z/OpenVoice")
from openvoice.api import ToneColorConverter  # noqa: E402

MODEL_DIR = Path(os.environ.get("VOXSHIFT_OV_DIR", "/home/z/models/openvoice/converter"))
SE_DIR = Path(os.environ.get("VOXSHIFT_CLONE_SE_DIR", "/home/z/models/voice-clone"))
PORT = int(os.environ.get("VOXSHIFT_CLONE_PORT", "3010"))
MAX_WAV_BYTES = 8 * 1024 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

torch.set_num_threads(int(os.environ.get("VOXSHIFT_TORCH_THREADS", "2")))
cv: ToneColorConverter | None = None


def get_converter() -> ToneColorConverter:
    global cv
    if cv is None:
        t0 = time.time()
        # upstream quirk: enable_watermark kwarg breaks __init__; default True kept
        cv = ToneColorConverter(str(MODEL_DIR / "config.json"), device="cpu")
        cv.load_ckpt(str(MODEL_DIR / "checkpoint.pth"))
        print(f"[voice-clone] model loaded in {time.time()-t0:.1f}s", flush=True)
    return cv


def load_wav_from_b64(wav_b64: str):
    if not wav_b64 or len(wav_b64) > MAX_WAV_BYTES * 2:
        raise ValueError("wavBase64 missing or too large")
    data = base64.b64decode(wav_b64, validate=True)
    wav, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if wav.size < 800:  # <~36ms @22k — reject garbage early
        raise ValueError("audio too short to process")
    return wav, sr


def se_path(speaker_id: str) -> Path:
    if not ID_RE.match(speaker_id or ""):
        raise ValueError("invalid speakerId (allowed: A-Za-z0-9_- up to 64)")
    return SE_DIR / f"{speaker_id}.se"


def handle(body: dict, action: str) -> dict:
    if action == "health":
        return {
            "status": "ok",
            "modelLoaded": cv is not None,
            "device": "cpu",
            "threads": torch.get_num_threads(),
            "speakers": sorted(p.stem for p in SE_DIR.glob("*.se")) if SE_DIR.exists() else [],
        }

    if action == "enroll":
        wav, sr = load_wav_from_b64(body.get("wavBase64"))
        dur = len(wav) / sr
        if dur < 3.0:
            raise ValueError(f"reference too short: {dur:.1f}s (need >= 3s of clean speech)")
        if dur > 60.0:
            raise ValueError(f"reference too long: {dur:.1f}s (limit 60s)")
        tmp_in = SE_DIR / ".enroll_in.wav"
        sf.write(tmp_in, wav, sr, format="WAV")
        sp = se_path(body.get("speakerId", ""))
        SE_DIR.mkdir(parents=True, exist_ok=True)
        get_converter().extract_se([str(tmp_in)], str(sp))
        tmp_in.unlink(missing_ok=True)
        dim = int(torch.load(str(sp), map_location="cpu", weights_only=True).numel())
        return {"ok": True, "speakerId": body.get("speakerId"), "refSeconds": round(dur, 2), "seDims": dim}

    if action == "convert":
        sp = se_path(body.get("speakerId", ""))
        if not sp.exists():
            raise FileNotFoundError(f"speaker '{body.get('speakerId')}' not enrolled — enroll first (no fallback voice is used)")
        wav, sr = load_wav_from_b64(body.get("wavBase64"))
        tau = float(body.get("tau", 0.3))
        tau = min(0.9, max(0.0, tau))
        tmp_in = SE_DIR / ".conv_in.wav"
        tmp_out = SE_DIR / ".conv_out.wav"
        sf.write(tmp_in, wav, sr, format="WAV")
        src_se_path = SE_DIR / ".conv_src.se"
        get_converter().extract_se([str(tmp_in)], str(src_se_path))
        t0 = time.time()
        get_converter().convert(
            str(tmp_in),
            torch.load(str(src_se_path), map_location="cpu", weights_only=True),
            torch.load(str(sp), map_location="cpu", weights_only=True),
            str(tmp_out),
            tau=tau,
        )
        convert_ms = int((time.time() - t0) * 1000)
        out_bytes = tmp_out.read_bytes()
        info = sf.info(str(tmp_out))
        tmp_in.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)
        src_se_path.unlink(missing_ok=True)
        return {"wavBase64": base64.b64encode(out_bytes).decode(), "sr": info.samplerate,
                "convertMs": convert_ms, "durS": round(info.frames / info.samplerate, 3)}

    if action == "drop":
        sp = se_path(body.get("speakerId", ""))
        existed = sp.exists()
        sp.unlink(missing_ok=True)
        return {"ok": True, "dropped": existed}

    raise ValueError(f"unknown action {action}")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict):
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            try:
                self._send(200, handle({}, "health"))
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": str(e)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        action = {"/enroll": "enroll", "/convert": "convert", "/drop": "drop"}.get(self.path)
        if not action:
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, handle(body, action))
        except FileNotFoundError as e:
            self._send(404, {"error": str(e)})
        except (ValueError, KeyError) as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):  # structured-ish, no audio/secrets
        sys.stderr.write("[voice-clone] %s\n" % (fmt % args))


if __name__ == "__main__":
    SE_DIR.mkdir(parents=True, exist_ok=True)
    # load eagerly so the first user utterance doesn't pay cold-start
    get_converter()
    print(f"[voice-clone] listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
