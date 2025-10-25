// index.js
// Main entry point for AI Call Worker
// Modular structure with clean imports for analysis, transcription, and HubSpot sync

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import { transcribeFile, analyseTranscript } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";

import { createScorecard, updateCall, getHubSpotObject, getAssociations } from "./hubspot/hubspot.js";

dotenv.config();
const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("AI Call Worker v4.x modular running ✅");
});

/**
 * Core webhook endpoint from HubSpot
 * Triggered when a new call recording is available
 */
app.post("/process-call", async (req, res) => {
  try {
    const { callId, recordingUrl } = req.body;
    console.log(`[bg] Downloading: ${recordingUrl}`);

    res.status(200).send({ ok: true, callId });

    // === 1. Transcribe ===
    console.log("[bg] Transcribing in parallel (segment=120s, concurrency=4)…");
    const transcript = await transcribeAudioParallel(
      "./tmp/audio.mp3",
      callId
    );

    // === 2. Analyse ===
    console.log("[bg] Transcription done, analysing...");
    const callInfo = await getHubSpotObject("calls", callId, [
      "hubspot_owner_id",
      "hs_activity_type",
    ]);
    const typeLabel = callInfo?.properties?.hs_activity_type || "Unknown";

    const analysis = await analyseTranscript(typeLabel, transcript);
    console.log("[ai] analysis:", analysis);

    // === 3. Fetch associations ===
    const ownerId = callInfo?.properties?.hubspot_owner_id;
    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

    // === 4. Update HubSpot objects ===
    try {
      await updateCall(callId, analysis);
    } catch (err) {
      console.warn("[warn] updateCall failed:", err.message);
    }

    try {
      await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    } catch (err) {
      console.warn("[warn] createScorecard failed:", err);
    }

    console.log(`✅ Done ${callId}`);
  } catch (err) {
    console.error("❌ Background error:", err);
  }
});

/**
 * Debug endpoint to test prompts locally
 */
app.post("/debug-prompt", async (req, res) => {
  const { callType, transcript } = req.body;
  const prompt = await getCombinedPrompt(callType, transcript);
  res.send({ callType, prompt });
});

// === Start server ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AI Call Worker listening on :${PORT}`);
});
