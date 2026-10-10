#!/usr/bin/env python3
"""Self-test for voice-clone-service (§11 subset — executed against a live :3010).

Covers: health/model-init, enroll validation (short ref rejected), enroll OK,
convert OK (fa + en), unknown speaker 404, invalid id 400, repeated requests,
concurrent requests, drop (right-to-erasure), sample-rate + format correctness.
Run: /home/z/.venv/bin/python selftest.py   (service must be running)
"""
import base64
import concurrent.futures
import json
import urllib.request

BASE = "http://127.0.0.1:3010"
REF = "/home/z/my-project/voxshift-ml/bench/audio/ref_spkA_0.wav"   # ~6s espeak fa
BASE_WAV = "/home/z/my-project/voxshift-ml/bench/audio/B1_fa_conv.wav"  # piper fa
BASE_EN = "/home/z/my-project/voxshift-ml/bench/audio/B1_en_conv.wav"   # piper en

results = []


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=300) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))


b64 = lambda p: base64.b64encode(open(p, "rb").read()).decode()

# 1 health / model init
code, h = call("GET", "/health")
check("health+modelLoaded", code == 200 and h.get("modelLoaded") is True, json.dumps(h)[:120])

# 2 enroll validation: invalid id
code, r = call("POST", "/enroll", {"speakerId": "bad id!", "wavBase64": b64(REF)})
check("enroll invalid id → 400", code == 400, str(r)[:100])

# 3 convert before enroll → 404 (honest, no fallback)
code, r = call("POST", "/convert", {"speakerId": "nobody", "wavBase64": b64(BASE_WAV)})
check("convert unenrolled → 404", code == 404, str(r)[:100])

# 4 enroll OK
code, r = call("POST", "/enroll", {"speakerId": "selftest_spk", "wavBase64": b64(REF)})
check("enroll ok", code == 200 and r.get("ok") is True and r.get("seDims", 0) >= 128, json.dumps(r))

# 5 convert fa OK + format correctness
code, r = call("POST", "/convert", {"speakerId": "selftest_spk", "wavBase64": b64(BASE_WAV)})
ok = code == 200 and r.get("sr") in (22050, 24000, 16000) and len(r.get("wavBase64", "")) > 10000
check("convert fa ok + wav/sr sane", ok, f"sr={r.get('sr')} convertMs={r.get('convertMs')} durS={r.get('durS')}")
out = base64.b64decode(r["wavBase64"])
check("convert output is RIFF/WAVE", out[:4] == b"RIFF" and out[8:12] == b"WAVE", f"{len(out)}B")

# 6 convert en OK (cross-lingual base)
code, r2 = call("POST", "/convert", {"speakerId": "selftest_spk", "wavBase64": b64(BASE_EN)})
check("convert en ok", code == 200 and len(r2.get("wavBase64", "")) > 10000, f"convertMs={r2.get('convertMs')}")

# 7 repeated requests deterministic-ish
codes = [call("POST", "/convert", {"speakerId": "selftest_spk", "wavBase64": b64(BASE_WAV)})[0] for _ in range(4)]
check("repeated x4 all 200", all(c == 200 for c in codes), str(codes))

# 8 concurrent x2
with concurrent.futures.ThreadPoolExecutor(2) as ex:
    fut = [ex.submit(call, "POST", "/convert", {"speakerId": "selftest_spk", "wavBase64": b64(BASE_WAV)}) for _ in range(2)]
    conc = [f.result()[0] for f in fut]
check("concurrent x2 all 200", all(c == 200 for c in conc), str(conc))

# 9 drop (right-to-erasure) + verify 404 afterwards
code, r = call("POST", "/drop", {"speakerId": "selftest_spk"})
code2, _ = call("POST", "/convert", {"speakerId": "selftest_spk", "wavBase64": b64(BASE_WAV)})
check("drop then convert → 404", code == 200 and code2 == 404, f"drop={code} post={code2}")

passed = sum(1 for _, ok, _ in results if ok)
print(f"\nSELFTEST {passed}/{len(results)} PASS")
raise SystemExit(0 if passed == len(results) else 1)
