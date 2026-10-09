#!/usr/bin/env python3
"""Controlled cross-channel similarity test:
reference speaker = z-ai studio TTS voice 'jam' (neural, human-like acoustics).
Arms scored against jam:
  B1 piper raw                    (no identity)
  B2J piper → OpenVoice→jam SE    (candidate conversion)
  kazi studio voice               (different-speaker studio control)
  jam other sentence              (same-speaker control needs a 2nd jam clip)
"""
import json, sys
from pathlib import Path
import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, str(Path(__file__).parent))
from run_bench import ov_converter, extract_se, load_se, piper_synth, OUT, SENTENCES  # noqa

def embed_fn():
    from speechbrain.inference.speaker import EncoderClassifier
    ec = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb",
                                        savedir="/home/z/models/ecapa", run_opts={"device": "cpu"})
    def embed(path):
        wav, sr = sf.read(str(path))
        if wav.ndim > 1: wav = wav.mean(axis=1)
        if sr != 16000:
            import librosa
            wav = librosa.resample(wav.astype(np.float32), orig_sr=sr, target_sr=16000)
        t = torch.tensor(wav, dtype=torch.float32).unsqueeze(0)
        with torch.no_grad():
            return ec.encode_batch(t).squeeze().cpu().numpy()
    return embed

def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

# 1) build the B2J arm: piper fa_conv → OpenVoice with jam SE
base = OUT / "B1_fa_conv.wav"
if not base.exists():
    piper_synth(SENTENCES["fa_conv"], "fa", base)
jam_se = load_se(extract_se(OUT / "refzai_jam.wav", "jam"))
cv = ov_converter()
out2j = OUT / "B2J_fa_conv.wav"
cv.convert(str(base), load_se(extract_se(base, "src_ctrl")), jam_se, str(out2j), tau=0.3)

# 2) second jam clip (different sentence) for same-speaker control
# (reuse jam speaking the formal sentence)
import subprocess
zai_script = Path("/tmp/gen_jam2.ts")
zai_script.write_text('''
import ZAI from 'z-ai-web-dev-sdk'
import { writeFileSync } from 'fs'
const zai = await ZAI.create()
const r = await zai.audio.tts.create({ input: 'احتراماً به اطلاع می‌رساند جلسه فردا ساعت ده صبح برگزار خواهد شد.', voice: 'jam', speed: 1.0, response_format: 'wav' })
writeFileSync('/home/z/my-project/voxshift-ml/bench/audio/refzai_jam2.wav', Buffer.from(new Uint8Array(await r.arrayBuffer())))
console.log('JAM2_OK')
''')
p = subprocess.run(["bun", str(zai_script)], capture_output=True, text=True, timeout=120, cwd="/home/z/my-project")
print(p.stdout.strip() or p.stderr.strip()[:200])

# 3) embed + score
embed = embed_fn()
jam = embed(OUT / "refzai_jam.wav")
jam2 = embed(OUT / "refzai_jam2.wav")
kazi = embed(OUT / "refzai_kazi.wav")
rows = {
    "control_jam_vs_jam2(same)": round(cos(jam, jam2), 4),
    "control_jam_vs_kazi(diff-studio)": round(cos(jam, kazi), 4),
    "B1_piper_raw vs jam": round(cos(embed(base), jam), 4),
    "B2J_piper_to_jam vs jam": round(cos(embed(out2j), jam), 4),
    "B2J_piper_to_jam vs kazi": round(cos(embed(out2j), kazi), 4),
    "kazi_out vs jam": round(cos(kazi, jam), 4),
}
Path(__file__).parent.joinpath("sim2_results.json").write_text(json.dumps(rows, indent=2))
print(json.dumps(rows, indent=2))
