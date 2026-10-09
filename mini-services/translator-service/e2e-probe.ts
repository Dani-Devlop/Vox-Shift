/**
 * E2E probe: connects to the translator service via the Next gateway
 * (http://localhost:81/?XTransformPort=3003) and sends a typed utterance,
 * measuring stage timings. Mirrors the `translate:text` contract.
 */
import { io } from "socket.io-client";

const socket = io("http://localhost:81/?XTransformPort=3003", {
  path: "/",
  transports: ["websocket"],
});

const t0 = Date.now();
const stages: Record<string, number> = {};
let done = false;

const finish = (label: string) => {
  if (done) return;
  done = true;
  console.log("\n--- RESULT:", label);
  console.log("stages:", JSON.stringify(stages));
  console.log("total:", Date.now() - t0, "ms");
  socket.close();
  process.exit(0);
};

socket.on("connect", () => {
  console.log("connected", socket.id);
  socket.emit("translate:text", {
    utteranceId: "probe-" + Date.now(),
    sessionId: "probe",
    text: "سلام، امروز حسابی خسته هستم",
    sourceLang: "fa",
    targetLang: "en",
    style: "natural",
    voice: "default",
    speed: 1.0,
  });
});

socket.on("stage", (e: any) => {
  const el = Date.now() - t0;
  stages[`${e.stage}:${e.status}`] = el;
  console.log(`[stage] ${e.stage} ${e.status} @${el}ms`, e.error || "");
});

socket.on("translation", (e: any) => {
  const el = Date.now() - t0;
  console.log(`[early-text] @${el}ms:`, JSON.stringify(e.translatedText));
});

socket.on("result", (e: any) => {
  console.log("[result] full @", Date.now() - t0, "ms");
  console.log("  translatedText:", JSON.stringify(e.translatedText));
  console.log("  voice:", JSON.stringify(e.voice));
  console.log("  audioBase64 length:", e.audioBase64?.length || 0);
  console.log("  timings:", JSON.stringify(e.timings));
  finish("OK");
});

socket.on("utterance:error", (e: any) => {
  console.error("[error]", JSON.stringify(e));
  finish("ERROR");
});

setTimeout(() => finish("TIMEOUT"), 25000);
