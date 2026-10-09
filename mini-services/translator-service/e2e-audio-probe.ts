/**
 * Audio-path E2E: sends fa_test.pcm (16kHz Int16) as a spoken utterance and
 * verifies ASR → translate → TTS audio round-trip through the gateway.
 */
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";

const socket = io("http://localhost:81/?XTransformPort=3003", {
  path: "/",
  transports: ["websocket"],
});

const pcm = readFileSync("/tmp/fa_test.pcm");
const t0 = Date.now();
let done = false;

const finish = (label: string) => {
  if (done) return;
  done = true;
  console.log("--- RESULT:", label, "total", Date.now() - t0, "ms");
  socket.close();
  process.exit(0);
};

socket.on("connect", () => {
  console.log("connected; sending", pcm.length, "bytes PCM");
  socket.emit("utterance", {
    utteranceId: "audio-probe-" + Date.now(),
    sessionId: "probe",
    audioBase64: pcm.toString("base64"),
    sampleRate: 16000,
    sourceLang: "fa",
    targetLang: "en",
    style: "natural",
    voice: "default",
    speed: 1.0,
  });
});

socket.on("stage", (e: any) =>
  console.log(`[stage] ${e.stage} ${e.status} @${Date.now() - t0}ms`, e.error || "")
);

socket.on("translation", (e: any) =>
  console.log(`[early-text] @${Date.now() - t0}ms:`, JSON.stringify(e.translatedText))
);

socket.on("result", (e: any) => {
  console.log("sourceText:", JSON.stringify(e.sourceText));
  console.log("translatedText:", JSON.stringify(e.translatedText));
  console.log("audioBase64 length:", e.audioBase64?.length || 0, "| RIFF:", e.audioBase64?.slice(0, 8));
  console.log("timings:", JSON.stringify(e.timings));
  finish("OK");
});

socket.on("utterance:error", (e: any) => {
  console.error("[error]", JSON.stringify(e));
  finish("ERROR");
});

setTimeout(() => finish("TIMEOUT"), 30000);
