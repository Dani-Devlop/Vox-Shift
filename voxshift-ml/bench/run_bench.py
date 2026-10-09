#!/usr/bin/env python3
"""VoxShift v3.3.1 voice-cloning benchmark harness (CPU, 2 vCPU sandbox).

Arms (same sentences, same reference):
  B0-espeak   : espeak-ng direct (current LOCAL fallback)
  B1-piper    : piper fa_IR-amir / en_US-amy (current local best)
  B2-piper+ov : piper base → OpenVoice v2 tone-color conversion (candidate)
  B3-zaikazi  : z-ai preset 'kazi' + pitch conform (current production default,
                produced by the running app; imported as pre-generated WAV)

References (SYNTHETIC pseudo-speakers — caveat documented):
  spkA: espeak-ng fa  (pitch 30)   spkB: espeak-ng fa (pitch 85)   spkC: espeak-ng en-us

Metric: SpeechBrain ECAPA-TDNN (VoxCeleb) 192-d embedding cosine similarity.
Caveats are printed in the results JSON and discussed in VOICE_BENCHMARK_RESULTS.md.

Usage:
  run_bench.py refs            # build reference clips + SEs
  run_bench.py synth           # run all local arms on all sentences
  run_bench.py score           # ECAPA similarity matrix → results JSON
  run_bench.py latency         # 20 warm trials of B2 + P50/P95
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path("/home/z/my-project/voxshift-ml/bench")
OUT = ROOT / "audio"
MODELS = Path("/home/z/models")
OV_CKPT = MODELS / "openvoice/converter"
SR = 22050

SENTENCES = {
    "fa_conv": "سلام، حالت چطوره؟ امروز کلی کار داشتم ولی در کل روز خوبی بود.",
    "fa_formal": "احتراماً به اطلاع می‌رساند جلسه هماهنگی فردا ساعت ده صبح در سالن کنفرانس برگزار خواهد شد.",
    "en_conv": "Hey, how's it going? I had a busy day today but overall it was good.",
    "en_tech": "The inference pipeline uses quantized embeddings and batched matrix multiplication on CPU.",
    "fa_codeswitch": "فایل رو توی درایو D آپلود کن، بعد یه اسکرین‌شات با WinRAR بفرست.",
    "fa_short": "سلام",
    "fa_long": "طبق آمار سال گذشته، فروش شرکت در بخش صادرات رشد چشمگیری داشته و پیش‌بینی می‌شود این روند در فصل آینده نیز ادامه یابد؛ لطفاً گزارش کامل را تا پایان هفته آماده کنید.",
    "en_question": "Could you explain how the voice cloning pipeline actually preserves the speaker's identity?",
}

REFS = {
    "spkA": ["سلام، حالت چطوره؟ امروز کلی کار داشتم ولی در کل روز خوبی بود.",
             "فردا صبح زود باید به جلسه برسیم، لطفاً به موقع بیا."],
    "spkB": ["امروز هوا واقعاً گرم بود و بازار شلوغ بود.",
             "من هر روز صبح چای سبز می‌نوشم و کمی مطالعه می‌کنم."],
    "spkC": ["This is a reference speaker recording for the benchmark harness.",
             "The quick brown fox jumps over the lazy dog near the river bank."],
}
REF_VOICE = {"spkA": ["fa", "30"], "spkB": ["fa", "85"], "spkC": ["en-us", "45"]}


def espeak(text, voice, pitch, out, speed=160):
    subprocess.run(["espeak-ng", "-v", voice, "-p", pitch, "-s", str(speed), "-a", "185",
                    "-w", str(out), "--", text], check=True)


def audio_duration(path):
    info = sf.info(str(path))
    return info.frames / info.samplerate


# ── OpenVoice singleton ──────────────────────────────────────────────────────
_ov = None


def ov_converter():
    global _ov
    if _ov is None:
        import sys
        sys.path.insert(0, "/home/z/OpenVoice")
        import torch
        torch.set_num_threads(2)
        from openvoice.api import ToneColorConverter
        # NOTE: upstream quirk — passing enable_watermark kwarg breaks __init__
        # (it forwards kwargs to the base class); omitting it defaults to True.
        _ov = ToneColorConverter(str(OV_CKPT / "config.json"), device="cpu")
        _ov.load_ckpt(str(OV_CKPT / "checkpoint.pth"))
    return _ov


def extract_se(wav_path, tag):
    se_path = OUT / f"se_{tag}.pth"
    if se_path.exists():
        return se_path
    cv = ov_converter()
    cv.extract_se([str(wav_path)], str(se_path))
    return se_path


def load_se(se_path):
    import torch
    return torch.load(str(se_path), map_location="cpu", weights_only=True)


# ── stages ───────────────────────────────────────────────────────────────────
def stage_refs():
    OUT.mkdir(parents=True, exist_ok=True)
    for spk, lines in REFS.items():
        voice, pitch = REF_VOICE[spk]
        outs = []
        for i, line in enumerate(lines):
            w = OUT / f"ref_{spk}_{i}.wav"
            espeak(line, voice, pitch, w)
            outs.append(str(w))
        extract_se(outs[0], f"{spk}_0")
        extract_se(outs[1], f"{spk}_1")
        print(f"REF {spk}: {len(outs)} clips, SE extracted")


def piper_synth(text, lang, out_path):
    voice = MODELS / "piper" / ("fa_IR-amir-medium.onnx" if lang.startswith("fa") else "en_US-amy-medium.onnx")
    p = subprocess.run(
        ["/home/z/ttsbench/bin/piper", "--model", str(voice), "--output_file", str(out_path)],
        input=text.encode(), capture_output=True, timeout=180)
    if p.returncode != 0:
        raise RuntimeError(f"piper failed: {p.stderr[:300]}")


def stage_synth():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {}
    # target speaker for conversion = spkA (the "user")
    tgt_se = OUT / "se_spkA_0.pth"

    for key, text in SENTENCES.items():
        lang = "fa" if key.startswith("fa") else "en"
        # B0 espeak
        w0 = OUT / f"B0_{key}.wav"
        t0 = time.time()
        espeak(text, "fa" if lang == "fa" else "en-us", "45", w0, speed=170)
        results[f"B0_{key}"] = {"synth_s": round(time.time() - t0, 3), "dur_s": round(audio_duration(w0), 3), "sr": sf.info(str(w0)).samplerate}

        # B1 piper
        w1 = OUT / f"B1_{key}.wav"
        t0 = time.time()
        piper_synth(text, lang, w1)
        results[f"B1_{key}"] = {"synth_s": round(time.time() - t0, 3), "dur_s": round(audio_duration(w1), 3), "sr": sf.info(str(w1)).samplerate}

        # B2 piper → OpenVoice conversion
        w2 = OUT / f"B2_{key}.wav"
        t0 = time.time()
        cv = ov_converter()
        src_se = load_se(extract_se(w1, f"src_{key}"))
        tgt = load_se(tgt_se)
        cv.convert(str(w1), src_se, tgt, str(w2), tau=0.3)
        dt = time.time() - t0
        results[f"B2_{key}"] = {"synth_s": round(dt, 3), "dur_s": round(audio_duration(w2), 3), "sr": sf.info(str(w2)).samplerate}
        print(f"{key}: B0 {results[f'B0_{key}']['synth_s']}s B1 {results[f'B1_{key}']['synth_s']}s B2 {results[f'B2_{key}']['synth_s']}s (audio {results[f'B2_{key}']['dur_s']}s)")

    (ROOT / "synth_results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print("WROTE synth_results.json")


def stage_score():
    import torch
    torch.set_num_threads(2)
    from speechbrain.inference.speaker import EncoderClassifier
    ec = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="/home/z/models/ecapa", run_opts={"device": "cpu"})

    def embed(path):
        wav, sr = sf.read(str(path))
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        if sr != 16000:
            import librosa
            wav = librosa.resample(wav.astype(np.float32), orig_sr=sr, target_sr=16000)
        t = torch.tensor(wav, dtype=torch.float32).unsqueeze(0)
        with torch.no_grad():
            return ec.encode_batch(t).squeeze().cpu().numpy()

    def cos(a, b):
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

    refs = {spk: embed(OUT / f"ref_{spk}_0.wav") for spk in REFS}
    rows = {}
    for f in sorted(OUT.glob("B*_*.wav")):
        e = embed(f)
        rows[f.name] = {spk: round(cos(e, r), 4) for spk, r in refs.items()}
    same = cos(refs["spkA"], embed(OUT / "ref_spkA_1.wav"))
    diff = cos(refs["spkA"], refs["spkB"])
    (ROOT / "sim_results.json").write_text(json.dumps(
        {"same_speaker_control": round(same, 4), "diff_speaker_control": round(diff, 4), "outputs": rows},
        indent=2, ensure_ascii=False))
    print(json.dumps(rows, indent=2, ensure_ascii=False))
    print(f"CONTROL same={same:.3f} diff={diff:.3f}")


def stage_latency():
    """20 warm trials of the candidate arm B2 on a representative sentence."""
    text = SENTENCES["fa_conv"]
    w1 = OUT / "lat_base.wav"
    piper_synth(text, "fa", w1)
    tgt_se = OUT / "se_spkA_0.pth"
    cv = ov_converter()
    src_se = load_se(extract_se(w1, "src_lat"))
    tgt = load_se(tgt_se)
    w2 = OUT / "lat_out.wav"
    cv.convert(str(w1), src_se, tgt, str(w2), tau=0.3)  # warm-up
    trials = []
    for _ in range(20):
        t0 = time.time()
        cv.convert(str(w1), src_se, tgt, str(w2), tau=0.3)
        trials.append(time.time() - t0)
    dur = audio_duration(w2)
    p50 = float(np.percentile(trials, 50))
    p95 = float(np.percentile(trials, 95))
    res = {"trials": 20, "audio_dur_s": round(dur, 3), "p50_s": round(p50, 3),
           "p95_s": round(p95, 3), "rtf_p50": round(p50 / dur, 3), "rtf_p95": round(p95 / dur, 3),
           "all": [round(t, 3) for t in trials]}
    (ROOT / "latency_results.json").write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "refs"
    {"refs": stage_refs, "synth": stage_synth, "score": stage_score, "latency": stage_latency}[stage]()
