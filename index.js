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

// Accept standard JSON; raise limit defensively
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

app.get("/health", (req, res) => {
  res.status(200).send({ ok: true, now: Date.now() });
});

/**
 * Try to extract {callId, recordingUrl, zoomToken, chunkSeconds, concurrency} from various body shapes
 * Supports:
 *  - { callId, recordingUrl, zoomToken, ... }
 *  - { id/objectId/engagementId, recording_url/zoomRecordingUrl }
 *  - [ { objectId, ... }, ... ]  // HubSpot webhook array
 *  - { object: { id } }
 */
function deriveBasics(body) {
  if (!body) return {};
  let callId =
    body.callId ||
    body.id ||
    body.objectId ||
    body.engagementId ||
    body?.object?.id;

  // If body is an array (HubSpot webhook)
  if (!callId && Array.isArray(body) && body.length > 0) {
    callId =
      body[0].callId ||
      body[0].id ||
      body[0].objectId ||
      body[0].engagementId ||
      body[0]?.object?.id;
  }

  let recordingUrl =
    body.recordingUrl ||
    body.recording_url ||
    body.zoomRecordingUrl ||
    body?.object?.recordingUrl;

  if (!recordingUrl && Array.isArray(body) && body.length > 0) {
    recordingUrl =
      body[0].recordingUrl ||
      body[0].recording_url ||
      body[0].zoomRecordingUrl ||
      body[0]?.object?.recordingUrl;
  }

  const zoomToken = body.zoomToken || process.env.ZOOM_TOKEN || null;
  const chunkSeconds = Number(body.chunkSeconds) || undefined;
  const concurrency = Number(body.concurrency) || undefined;

  return { callId, recordingUrl, zoomToken, chunkSeconds, concurrency };
}

/**
 * Fallback: if we have callId but not recordingUrl, try to fetch it from HubSpot
 * Checks common property names on the Call.
 */
async function fetchRecordingUrlFromHubSpot(callId) {
  try {
    const propsToTry = [
      "hs_call_recording_url",
      "hs_call_recording",
      "recording_url",
      "zoom_recording_url",
    ];
    const call = await getHubSpotObject("calls", callId, propsToTry);
    const p = call?.properties || {};
    for (const k of propsToTry) {
      if (p[k]) return p[k];
    }
  } catch (e) {
    console.warn("[warn] Could not fetch recording URL from HubSpot:", e.message);
  }
  return null;
}

/**
 * POST /process-call
 * Body (any of the supported shapes above)
 * Optional: { chunkSeconds, concurrency }
 */
app.post("/process-call", async (req, res) => {
  const startedAt = Date.now();
  let { callId, recordingUrl, zoomToken, chunkSeconds, concurrency } = deriveBasics(req.body);

  // If callId/recordingUrl missing, try to auto-derive from HubSpot
  if (!callId && Array.isArray(req.body) && req.body.length > 0) {
    // HubSpot webhook often posts an array: use the objectId as callId
    callId = req.body[0].objectId || req.body[0].id || req.body[0]?.object?.id;
  }

  if (callId && !recordingUrl) {
    recordingUrl = await fetchRecordingUrlFromHubSpot(callId);
  }

  if (!callId || !recordingUrl) {
    // Log body keys (safe): helps debugging payload shape
    const keys = Array.isArray(req.body)
      ? ["[array payload]", ...Object.keys(req.body[0] || {})]
      : Object.keys(req.body || {});
    console.warn("[payload] Missing fields. Seen keys:", keys);

    return res
      .status(400)
      .send({
        ok: false,
        error: "callId and recordingUrl are required",
        hint: "Accepts { callId, recordingUrl } OR HubSpot webhook array with objectId. If no recordingUrl posted, we try to fetch hs_call_recording_url from HubSpot.",
        seenKeys: keys,
      });
  }

  // Respond early so webhook isn’t held open
  res.status(200).send({ ok: true, callId });

  try {
    await ensureTmp();
    const audioPath = path.join(TMP_DIR, `${String(callId)}.mp3`);
    console.log(`[bg] Downloading audio to ${audioPath}`);

    await downloadToFile(recordingUrl, audioPath, { bearer: zoomToken });

    console.log(
      "[bg] Transcribing in parallel…",
      `(segment=${chunkSeconds || 120}s, concurrency=${concurrency || 4})`
    );
    const transcript = await transcribeAudioParallel(audioPath, callId, {
      segmentSeconds: Number(chunkSeconds) || 120,
      concurrency: Number(concurrency) || 4,
    });

    // ===== Failsafe: skip empty/silent transcripts =====
    if (!transcript || transcript.trim().length < 50) {
      console.warn(`[skip] Transcript empty or too short for ${callId}. Skipping analysis.`);
      // Best-effort cleanup
      try { await fs.rm(audioPath, { force: true }); } catch {}
      return; // exit early — no AI cost, no HubSpot updates
    }

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
    try {
      await fs.rm(audioPath, { force: true });
    } catch {}
    console.log(`✅ Done ${callId} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    console.error("❌ Background error:", err);
  }
});

/**
 * Convenience endpoint: post the raw HubSpot webhook payload here.
 * We’ll auto-derive callId and recordingUrl (via HubSpot if needed) and then process.
 */
app.post("/hubspot-calls-webhook", async (req, res) => {
  // Just forward the body to /process-call logic.
  // Some HubSpot setups prefer a separate path—this keeps your existing integrations clean.
  return app._router.handle(req, res, () => {}, "/process-call");
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
