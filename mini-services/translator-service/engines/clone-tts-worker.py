#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# VoxShift LOCAL voice-clone synthesis worker (v3.5.0) — one-shot CLI.
#
# Selected by the local-first priority chain ONLY when the shared detector
# (src/lib/voice/clone-chain.ts) has verified: python package importable +
# weights on disk + host RAM floor. Zero-shot: a reference WAV drives the
# speaker identity, `text` is the translated phrase.
#
# Usage:
#   python3 clone-tts-worker.py <fish-speech|f5-tts|chatterbox> <text> <ref_wav>
# Prints ONE JSON line on stdout:
#   {"ok":true,"wav_b64":"...","sr":24000,"ms":1234,"engine":"f5-tts"}
#   {"ok":false,"error":"..."}          — honest failure, no synthetic audio
#
# Engine APIs (documented upstream surfaces, best-effort adapters):
#   f5-tts      → f5_tts.api.F5TTS().infer(ref_file, ref_text="", gen_text)
#   chatterbox  → chatterbox.tts.ChatterboxTTS.from_pretrained().generate(
#                    text, audio_prompt_path=ref)
#   fish-speech → fish_speech high-level API if exposed; otherwise an honest
#                 error naming the missing surface (never fake audio).
# ─────────────────────────────────────────────────────────────────────────────

import base64
import io
import json
import sys
import time
import wave


def wav_to_b64_sr(data: bytes) -> dict:
    with wave.open(io.BytesIO(data), "rb") as w:
        sr = w.getframerate()
    return {"wav_b64": base64.b64encode(data).decode("ascii"), "sr": sr}


def synth_f5(text: str, ref: str) -> dict:
    try:
        from f5_tts.api import F5TTS  # type: ignore
    except Exception as e:
        raise RuntimeError(f"f5_tts.api import failed: {e}") from e
    f5 = F5TTS()  # loads the model configured by the package defaults
    wav, sr = f5.infer(ref_file=ref, ref_text="", gen_text=text)
    import numpy as np  # f5 returns float32 numpy / torch tensor

    if hasattr(wav, "detach"):
        wav = wav.detach().cpu().numpy().squeeze()
    wav = np.asarray(wav, dtype="float32").squeeze()
    pcm16 = (wav * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm16)
    return {"wav_b64": base64.b64encode(buf.getvalue()).decode("ascii"), "sr": int(sr)}


def synth_chatterbox(text: str, ref: str) -> dict:
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        from chatterbox.tts import ChatterboxTTS  # type: ignore
    except Exception as e:
        raise RuntimeError(f"chatterbox.tts import failed: {e}") from e
    model = ChatterboxTTS.from_pretrained(device="cpu")
    wav = model.generate(text, audio_prompt_path=ref)  # torch tensor [1, T]
    sr = model.sr
    wav = wav.detach().cpu().numpy().squeeze()
    pcm16 = (wav * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm16)
    return {"wav_b64": base64.b64encode(buf.getvalue()).decode("ascii"), "sr": int(sr)}


def synth_fish_speech(text: str, ref: str) -> dict:
    try:
        import fish_speech  # noqa: F401
    except Exception as e:
        raise RuntimeError(f"fish_speech import failed: {e}") from e
    # The upstream high-level surface differs across releases (fish-speech 1.x
    # → openaudio). Probe the known entry points; never fabricate audio.
    try:
        from fish_speech import FishSpeechTTS  # type: ignore

        model = FishSpeechTTS.from_pretrained()
        out = model.synthesize(text, reference_audio=ref)
        if isinstance(out, tuple):
            wav, sr = out
        else:
            wav, sr = out.audio, out.sample_rate
        import numpy as np

        wav = np.asarray(wav, dtype="float32").squeeze()
        pcm16 = (wav * 32767.0).astype("<i2").tobytes()
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(int(sr))
            w.writeframes(pcm16)
        return {"wav_b64": base64.b64encode(buf.getvalue()).decode("ascii"), "sr": int(sr)}
    except ImportError:
        raise RuntimeError(
            "fish_speech is installed but exposes none of the known python "
            "synthesis surfaces (FishSpeechTTS). Use the fish-speech HTTP API "
            "server locally, or upgrade the adapter for this release."
        )


ENGINES = {
    "f5-tts": synth_f5,
    "chatterbox": synth_chatterbox,
    "fish-speech": synth_fish_speech,
}


def main() -> int:
    t0 = time.time()
    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "error": "usage: clone-tts-worker.py <engine> <text> <ref_wav>"}))
        return 2
    engine, text, ref = sys.argv[1], sys.argv[2], sys.argv[3]
    fn = ENGINES.get(engine)
    if fn is None:
        print(json.dumps({"ok": False, "error": f"unknown engine '{engine}'"}))
        return 2
    try:
        out = fn(text, ref)
        out.update({"ok": True, "engine": engine, "ms": int((time.time() - t0) * 1000)})
        print(json.dumps(out))
        return 0
    except Exception as e:  # honest failure — the chain records the attempt
        print(json.dumps({"ok": False, "engine": engine, "error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
