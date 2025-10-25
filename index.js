// index.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";

import { analyseTranscript } from "./ai/analyse.js";
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
app.use(bodyParser.json());

/* ---------- helpers ---------- */
async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}
async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = await res.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(buf));
  return destPath;
}

/* ---------- routes ---------- */
app.get("/", (req, res) => {
  res.send("AI Call Worker v4.x modular running ✅");
});

// simple health with timestamp
app.get("/health", (req, res) => {
  res.status(200).send({ ok: true, now: Date.now() });
});

app.post("/debug-prompt", async (req, res) => {
  const { callType, transcript } = req.body;
  const prompt = await getCombinedPrompt(callType || "Initial Consultation", transcript || "");
  res.send({ callType, prompt });
});

// main webhook/trigger
app.post("/process-call", async (req, res) => {
  try {
    // Accept either our direct payload or HubSpot Automation JSON
    let { callId, recordingUrl, chunkSeconds, concurrency } = req.body || {};
    if (!callId) callId = req.body?.objectId || req.body?.object_id || req.body?.id;
    if (!recordingUrl) {
      recordingUrl =
        req.body?.recordingUrl ||
        req.body?.recording_url ||
        req.body?.inputFields?.recordingUrl ||
        req.body?.inputFields?.recording_url;
    }

    if (!callId || !recordingUrl) {
      return res.status(400).send({ ok: false, error: "callId and recordingUrl are required" });
    }

    // quick ACK
    res.status(200).send({ ok: true, callId });

    // download
    const tmpRoot = "/tmp/ai-call-worker";
    await ensureDir(tmpRoot);
    const audioPath = path.join(tmpRoot, `${String(callId)}.mp3`);
    console.log(`[bg] Downloading audio to ${audioPath}`);
    await downloadToFile(recordingUrl, audioPath);

    // transcribe
    const seg = Number(chunkSeconds) || 120;
    const conc = Number(concurrency) || 4;
    console.log(`[bg] Transcribing in parallel… (segment=${seg}s, concurrency=${conc})`);
    const transcript = await transcribeAudioParallel(audioPath, callId, {
      segmentSeconds: seg,
      concurrency: conc,
    });

    // fail-safe: skip blank/near-blank calls to avoid token waste
    const cleaned = (transcript || "").replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length < 40) {
      console.log("[bg] Transcript is empty/very short; skipping analysis & updates.");
      try {
        await updateCall(callId, {
          call_type: null,
          summary: ["No usable audio detected (empty/short recording)."],
          outcome: "Neutral",
          objections: [],
          next_actions: [],
          materials_to_send: [],
          key_details: {},
          ai_missing_information: "Recording appears blank or too short.",
          ai_decision_criteria: null,
        });
      } catch (e) {
        console.warn("[warn] updateCall for blank transcript failed:", e.message);
      }
      console.log(`✅ Done ${callId} (blank transcript)`);
      return;
    }

    // fetch call info + associations
    console.log("[bg] Transcription done, fetching HubSpot call…");
    const callInfo = await getHubSpotObject("calls", callId, [
      "hubspot_owner_id",
      "hs_activity_type",
    ]);
    const typeLabel = callInfo?.properties?.hs_activity_type || "Unknown";
    const ownerId = callInfo?.properties?.hubspot_owner_id;

    // analyse with TLPI context
    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(typeLabel, cleaned);
    console.log("[ai] analysis:", analysis);

    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

    // update call
    try {
      await updateCall(callId, analysis);
    } catch (err) {
      console.warn("[warn] updateCall failed:", err.message);
    }

    // create scorecard with owner copy
    try {
      await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    } catch (err) {
      console.warn("[warn] createScorecard failed:", err.message);
    }

    console.log(`✅ Done ${callId}`);
  } catch (err) {
    console.error("❌ Background error:", err);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
