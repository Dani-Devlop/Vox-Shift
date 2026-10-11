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
#   python3 clone-tts-worker.py <fish-speech|f5-tts|chatterbox> <text> <ref_wav> [ref_text]
# Prints ONE JSON line on stdout:
#   {"ok":true,"wav_b64":"...","sr":24000,"ms":1234,"engine":"f5-tts"}
#   {"ok":false,"error":"..."}          — honest failure, no synthetic audio
#
# Engine surfaces (all REAL, verified by measurement):
#   f5-tts      → f5_tts.api.F5TTS().infer(ref_file, ref_text, gen_text)
#                 (ref_text REQUIRED-ish: empty triggers an upstream whisper
#                  auto-transcribe that downloads a model mid-flight)
#   chatterbox  → chatterbox.tts.ChatterboxTTS.from_pretrained().generate(
#                    text, audio_prompt_path=ref)
#   fish-speech → fish-speech v1.5.0 tools.inference_engine.TTSInferenceEngine
#                 (llama_queue + firefly-gan VQ decoder), the OFFICIAL local
#                 surface. Needs the repo checked out (FISH_SPEECH_REPO or the
#                 well-known /home/z/models/fish-speech-src) and the weights
#                 dir (VOXSHIFT_FISH_WEIGHTS or <MODELS>/fish-speech/…).
#
# Measured on a 2-core CPU sandbox (floor calibration, v3.7.0):
#   fish-speech: peak RSS 2306 MB · 3.4 s audio in ~27 s (bf16 LLM on CPU)
#   f5-tts:      peak RSS 2875 MB · 3.4 s audio in ~66 s (NFE 16, cfg 2)
# ─────────────────────────────────────────────────────────────────────────────

import base64
import io
import json
import os
import sys
import time
import wave


def wav_to_b64_sr(data: bytes) -> dict:
    with wave.open(io.BytesIO(data), "rb") as w:
        sr = w.getframerate()
    return {"wav_b64": base64.b64encode(data).decode("ascii"), "sr": sr}


def _pcm16_wav(samples, sr) -> str:
    """float/tensor audio → base64 mono PCM16 WAV."""
    import numpy as np

    if hasattr(samples, "detach"):
        samples = samples.detach().cpu().numpy()
    w = np.asarray(samples, dtype="float32").squeeze()
    pcm16 = (np.clip(w, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(int(sr))
        f.writeframes(pcm16)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def synth_f5(text: str, ref: str, ref_text: str = "") -> dict:
    try:
        from f5_tts.api import F5TTS  # type: ignore
    except Exception as e:
        raise RuntimeError(f"f5_tts.api import failed: {e}") from e
    f5 = F5TTS()  # loads the model configured by the package defaults
    # NOTE: ref_text="" makes upstream run its whisper auto-transcriber (a
    # mid-flight model download) — the caller supplies a transcript whenever
    # one exists; otherwise we still pass it and accept the extra step.
    wav, sr, _ = f5.infer(ref_file=ref, ref_text=ref_text, gen_text=text)
    return {"wav_b64": _pcm16_wav(wav, sr), "sr": int(sr)}


def synth_chatterbox(text: str, ref: str, ref_text: str = "") -> dict:
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        from chatterbox.tts import ChatterboxTTS  # type: ignore
    except Exception as e:
        raise RuntimeError(f"chatterbox.tts import failed: {e}") from e
    model = ChatterboxTTS.from_pretrained(device="cpu")
    wav = model.generate(text, audio_prompt_path=ref)  # torch tensor [1, T]
    return {"wav_b64": _pcm16_wav(wav, model.sr), "sr": int(model.sr)}


FISH_REPO_CANDIDATES = (
    [os.environ["FISH_SPEECH_REPO"]] if os.environ.get("FISH_SPEECH_REPO") else []
) + [
    "/home/z/models/fish-speech-src",
    "/opt/voxshift/models/fish-speech-src",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fish-speech-src"),
]


def _fish_repo() -> str:
    for repo in FISH_REPO_CANDIDATES:
        if repo and os.path.isfile(os.path.join(repo, "tools", "inference_engine", "__init__.py")):
            return repo
    raise RuntimeError(
        "fish-speech v1.5.0 source checkout not found (looked in: "
        + ", ".join([r for r in FISH_REPO_CANDIDATES if r])
        + ") — git clone --branch v1.5.0 https://github.com/fishaudio/fish-speech.git "
        "and set FISH_SPEECH_REPO"
    )


def _fish_weights_dir() -> str:
    """Directory holding model.pth + firefly-gan…pth + config.json.

    Accepts either the checkpoint dir itself or a parent containing
    checkpoints/fish-speech-1.5/ (the tools/download_models.py layout).
    """
    cands = [
        os.environ["VOXSHIFT_FISH_WEIGHTS"] if os.environ.get("VOXSHIFT_FISH_WEIGHTS") else None,
        "/home/z/models/fish-speech/checkpoints/fish-speech-1.5",
        "/home/z/models/fish-speech",
        "/opt/voxshift/models/fish-speech",
    ]
    for d in [c for c in cands if c]:
        if os.path.isfile(os.path.join(d, "model.pth")):
            return d
        inner = os.path.join(d, "checkpoints", "fish-speech-1.5")
        if os.path.isfile(os.path.join(inner, "model.pth")):
            return inner
    raise RuntimeError(
        "fish-speech weights not found (model.pth missing under VOXSHIFT_FISH_WEIGHTS/"
        "/home/z/models/fish-speech) — run scripts/setup-local-clone.sh"
    )


def synth_fish_speech(text: str, ref: str, ref_text: str = "") -> dict:
    """Zero-shot clone via the OFFICIAL fish-speech v1.5.0 local engine.

    Memory notes (measured, 2-core CPU):
      · the LLM random-init happens in the default dtype — fp32 materializes
        ~2.5 GB and OOMs small containers, so the default dtype is scoped to
        bfloat16 ONLY around the LLM load, then restored for the VQ decoder.
    """
    repo = _fish_repo()
    weights = _fish_weights_dir()
    sys.path.insert(0, repo)
    os.environ.setdefault("EINX_FILTER_TRACEBACK", "false")

    import torch

    torch.set_num_threads(min(2, os.cpu_count() or 1))
    from pathlib import Path  # noqa: E402

    try:
        from tools.inference_engine import TTSInferenceEngine  # type: ignore
        from tools.llama.generate import launch_thread_safe_queue  # type: ignore
        from tools.schema import ServeReferenceAudio, ServeTTSRequest  # type: ignore
        from tools.vqgan.inference import load_model as load_decoder_model  # type: ignore
    except Exception as e:
        raise RuntimeError(f"fish-speech tools import failed (repo {repo}): {e}") from e

    ckpt = Path(weights)
    prev_dtype = torch.get_default_dtype()
    torch.set_default_dtype(torch.bfloat16)
    try:
        llama_queue = launch_thread_safe_queue(
            checkpoint_path=ckpt, device="cpu", precision=torch.bfloat16, compile=False
        )
    finally:
        torch.set_default_dtype(prev_dtype)
    decoder = load_decoder_model(
        config_name="firefly_gan_vq",
        checkpoint_path=ckpt / "firefly-gan-vq-fsq-8x1024-21hz-generator.pth",
        device="cpu",
    )
    engine = TTSInferenceEngine(
        llama_queue=llama_queue, decoder_model=decoder, compile=False, precision=torch.bfloat16
    )

    with open(ref, "rb") as f:
        ref_bytes = f.read()
    req = ServeTTSRequest(
        text=text,
        references=[ServeReferenceAudio(audio=ref_bytes, text=ref_text or "")],
        max_new_tokens=1024,
        chunk_length=200,
        top_p=0.7,
        repetition_penalty=1.5,
        temperature=0.7,
        format="wav",
    )
    final = None
    for result in engine.inference(req):
        if result.code == "final":
            final = result.audio
            break
        if result.code == "error":
            raise RuntimeError(f"fish-speech engine error: {result.error}")
    if final is None:
        raise RuntimeError("fish-speech engine produced no audio")
    sr, audio = final
    return {"wav_b64": _pcm16_wav(audio, sr), "sr": int(sr)}


ENGINES = {
    "f5-tts": synth_f5,
    "chatterbox": synth_chatterbox,
    "fish-speech": synth_fish_speech,
}


def main() -> int:
    t0 = time.time()
    if len(sys.argv) not in (4, 5):
        print(json.dumps({"ok": False, "error": "usage: clone-tts-worker.py <engine> <text> <ref_wav> [ref_text]"}))
        return 2
    engine, text, ref = sys.argv[1], sys.argv[2], sys.argv[3]
    ref_text = sys.argv[4] if len(sys.argv) == 5 else ""
    fn = ENGINES.get(engine)
    if fn is None:
        print(json.dumps({"ok": False, "error": f"unknown engine '{engine}'"}))
        return 2
    try:
        out = fn(text, ref, ref_text)
        out.update({"ok": True, "engine": engine, "ms": int((time.time() - t0) * 1000)})
        print(json.dumps(out))
        return 0
    except Exception as e:  # honest failure — the chain records the attempt
        print(json.dumps({"ok": False, "engine": engine, "error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
