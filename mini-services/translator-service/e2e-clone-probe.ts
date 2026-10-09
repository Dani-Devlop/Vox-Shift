/**
 * E2E probe — LOCAL voice-clone loop (v3.3.1):
 *  1. enroll the benchmark reference via POST /api/voice-profile/clone
 *  2. send a typed fa→en utterance with profileMode=clone + providerModel=local-openvoice
 *  3. assert the result's providers.tts === 'local-openvoice' and audio WAV arrives
 *
 * Run: bun mini-services/translator-service/e2e-clone-probe.ts
 * Requires: next dev :3000 + translator-service :3003 + voice-clone-service :3010
 */
import { io } from "socket.io-client";
import { readFileSync } from "fs";

const REF_WAV = "/home/z/my-project/voxshift-ml/bench/audio/ref_spkA_0.wav";
const GATE = "http://localhost:3000";

function wavToPcm16B64(wavPath: string): { b64: string; sampleRate: number } {
  const buf = readFileSync(wavPath);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error(`expected 16-bit WAV, got ${bits}`);
  const dataIdx = buf.indexOf("data", 12, "ascii");
  const pcm = buf.subarray(dataIdx + 4);
  return { b64: pcm.toString("base64"), sampleRate };
}

async function enroll(): Promise<string> {
  const { b64, sampleRate } = wavToPcm16B64(REF_WAV);
  const res = await fetch(`${GATE}/api/voice-profile/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64: b64, sampleRate, consented: true, name: "bench spkA" }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`enroll failed: ${JSON.stringify(j).slice(0, 300)}`);
  console.log(`ENROLL_OK profileId=${j.profile.id} refSeconds=${j.clone.refSeconds} seDims=${j.clone.seDims}`);
  return j.profile.id;
}

const t0 = Date.now();
const stages: Record<string, number> = {};
let done = false;

const finish = (label: string, extra = "") => {
  if (done) return;
  done = true;
  console.log(`\n--- E2E_${label}`, extra);
  console.log("stages:", JSON.stringify(stages), "total:", Date.now() - t0, "ms");
  process.exit(label === "PASS" ? 0 : 1);
};

const profileId = await enroll();

const socket = io("http://localhost:81/?XTransformPort=3003", {
  path: "/",
  transports: ["websocket"],
});
socket.on("connect", () => {
  console.log("socket connected");
  socket.emit("translate:text", {
    utteranceId: "clone-probe-" + Date.now(),
    sessionId: "clone-probe",
    text: "سلام، حالت چطوره؟",
    sourceLang: "fa",
    targetLang: "en",
    style: "natural",
    voice: "default",
    speed: 1.0,
    profileMode: "clone",
    providerProfileId: profileId,
    providerModel: "local-openvoice",
  });
});
socket.on("stage", (e: any) => {
  stages[`${e.stage}:${e.status}`] = Date.now() - t0;
  console.log(`[stage] ${e.stage} ${e.status} @${Date.now() - t0}ms`, e.error || "");
});
socket.on("result", (r: any) => {
  const tts = r?.providers?.tts ?? "?";
  const audioLen = r?.audioBase64?.length ?? 0;
  const isLocalClone = tts === "local-openvoice";
  const isWav = audioLen > 10000;
  console.log(`RESULT providers=${JSON.stringify(r?.providers)} audioB64Len=${audioLen}`);
  finish(isLocalClone && isWav ? "PASS" : "FAIL", `tts=${tts}`);
  socket.close();
});
socket.on("utterance:error", (e: any) => {
  console.log("UTTERANCE_ERROR", JSON.stringify(e).slice(0, 300));
  finish("FAIL", "utterance:error");
});
setTimeout(() => finish("FAIL", "timeout 180s"), 180_000);
