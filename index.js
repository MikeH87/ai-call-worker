// index.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

import { transcribeFile, analyseTranscript } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";

import {
  createScorecard,
  updateCall,
  getHubSpotObject,
  getAssociations,
} from "./hubspot/hubspot.js";

dotenv.config();
const app = express();
app.use(bodyParser.json({ limit: "20mb" }));

// --- Utils ---
const TMP_DIR = "/tmp/ai-call-worker";
async function ensureTmp() {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

async function downloadToFile(url, outPath, { bearer, headers = {} } = {}) {
  const h = { ...headers };
  if (bearer) h.Authorization = `Bearer ${bearer}`;

  const res = await fetch(url, { headers: h });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Download failed ${res.status} ${res.statusText} — ${text?.slice(0, 250)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
  return outPath;
}

app.get("/", (req, res) => {
  res.send("AI Call Worker v4.x modular running ✅");
});

/**
 * POST /process-call
 * Body: { callId, recordingUrl, zoomToken? }  // zoomToken optional if env ZOOM_TOKEN set
 * Optional: { chunkSeconds, concurrency }
 */
app.post("/process-call", async (req, res) => {
  const startedAt = Date.now();
  const { callId, recordingUrl, zoomToken, chunkSeconds, concurrency } = req.body || {};

  if (!callId || !recordingUrl) {
    return res.status(400).send({ ok: false, error: "callId and recordingUrl are required" });
  }

  // Respond early so the Zoom/HubSpot webhook isn't held open
  res.status(200).send({ ok: true, callId });

  try {
    await ensureTmp();
    const audioPath = path.join(TMP_DIR, `${callId}.mp3`);
    console.log(`[bg] Downloading audio to ${audioPath}`);

    // Prefer explicit token from webhook, else env
    const bearer = zoomToken || process.env.ZOOM_TOKEN || "";
    await downloadToFile(recordingUrl, audioPath, { bearer });

    console.log("[bg] Transcribing in parallel…",
      `(segment=${chunkSeconds || 120}s, concurrency=${concurrency || 4})`);
    const transcript = await transcribeAudioParallel(audioPath, callId, {
      segmentSeconds: Number(chunkSeconds) || 120,
      concurrency: Number(concurrency) || 4,
    });

    console.log("[bg] Transcription done, fetching HubSpot call…");
    const callInfo = await getHubSpotObject("calls", callId, [
      "hubspot_owner_id",
      "hs_activity_type",
    ]);
    const typeLabel = callInfo?.properties?.hs_activity_type || "Unknown";

    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(typeLabel, transcript);
    console.log("[ai] analysis:", analysis);

    const ownerId = callInfo?.properties?.hubspot_owner_id || null;
    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

    try {
      await updateCall(callId, analysis);
    } catch (err) {
      console.warn("[warn] updateCall failed:", err.message);
    }

    try {
      await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    } catch (err) {
      console.warn("[warn] createScorecard failed:", err.message);
    }

    // best-effort cleanup
    try { await fs.rm(audioPath, { force: true }); } catch {}
    console.log(`✅ Done ${callId} in ${Math.round((Date.now() - startedAt)/1000)}s`);
  } catch (err) {
    console.error("❌ Background error:", err);
  }
});

/**
 * POST /debug-prompt
 * Body: { callType, transcript }
 */
app.post("/debug-prompt", async (req, res) => {
  const { callType, transcript } = req.body || {};
  const prompt = await getCombinedPrompt(callType, transcript || "");
  res.send({ callType, prompt });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
