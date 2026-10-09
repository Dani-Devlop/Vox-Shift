/**
 * E2E probe: live-caption path — sends two incremental `asr:partial` snapshots
 * (growing PCM) then a full utterance, mirroring the client contract.
 * Reads /tmp/fa_test.pcm (16 kHz Int16 LE mono) for realistic Persian audio.
 */
import { readFileSync } from "fs";
import { io } from "socket.io-client";

const socket = io("http://localhost:81/?XTransformPort=3003", {
  path: "/",
  transports: ["websocket"],
});

const t0 = Date.now();
const pcm = readFileSync("/tmp/fa_test.pcm"); // full utterance
const capId = "cap-" + Date.now();
let partials = 0;
let done = false;

const finish = (label: string) => {
  if (done) return;
  done = true;
  console.log(`\n--- RESULT: ${label} (partials received: ${partials})`);
  console.log("total:", Date.now() - t0, "ms");
  socket.close();
  process.exit(0);
};

const b64 = (buf: Buffer) => buf.toString("base64");

socket.on("connect", () => {
  console.log("connected", socket.id);

  // 1st snapshot: first ~1.2s of speech (38400 samples × 2 bytes)
  const snap1 = pcm.subarray(0, Math.min(pcm.length, 76800));
  socket.emit("asr:partial", {
    utteranceId: capId,
    audioBase64: b64(snap1),
    sampleRate: 16000,
    sourceLang: "fa",
  });

  // 2nd snapshot after 1.3s: everything so far (if any audio remains)
  setTimeout(() => {
    if (pcm.length > 76800) {
      const snap2 = pcm.subarray(0, Math.min(pcm.length, 153600));
      socket.emit("asr:partial", {
        utteranceId: capId,
        audioBase64: b64(snap2),
        sampleRate: 16000,
        sourceLang: "fa",
      });
    }
  }, 1300);

  // Full utterance after 2.6s → normal FIFO path
  setTimeout(() => {
    socket.emit("utterance", {
      utteranceId: "u-" + Date.now(),
      sessionId: "probe",
      audioBase64: b64(pcm),
      sampleRate: 16000,
      sourceLang: "fa",
      targetLang: "en",
      style: "natural",
      voice: "default",
      speed: 1.0,
    });
  }, 2600);
});

socket.on("asr:partial:result", (e: any) => {
  partials++;
  console.log(`[partial #${partials}] @${Date.now() - t0}ms:`, JSON.stringify(e.text));
});

socket.on("stage", (e: any) => {
  console.log(`[stage] ${e.stage}:${e.status} @${Date.now() - t0}ms`);
});

socket.on("result", (e: any) => {
  console.log("[result] full @", Date.now() - t0, "ms");
  console.log("  sourceText:", JSON.stringify(e.sourceText));
  console.log("  translatedText:", JSON.stringify(e.translatedText));
  console.log("  audioBase64 length:", e.audioBase64?.length || 0);
  finish("OK");
});

socket.on("utterance:error", (e: any) => {
  console.error("[error]", JSON.stringify(e));
  finish("ERROR");
});

setTimeout(() => finish("TIMEOUT"), 25000);
