// index.js — stable with direct HubSpot fetch for recordingUrl (no getCallRecordingMeta)

// --- express bootstrap ---
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import { analyseTranscript } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";

import {
  getHubSpotObject,
  getAssociations,
  updateCall,
  createScorecard,
  // associateScorecardAllViaTypes, // not required here; createScorecard already enforces types[] internally
} from "./hubspot/hubspot.js";

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Helpful: version banner for troubleshooting
const APP_VERSION =
  process.env.APP_VERSION ||
  (await import("./package.json", { assert: { type: "json" } })).default.version ||
  "dev";
const STARTED_AT = new Date().toISOString();

// Expose app & version if other modules import index.js (optional)
export { app, APP_VERSION, STARTED_AT };

// ---------- small helpers ----------
const isObject = (v) => v && typeof v === "object";
const looksLikeId = (v) => {
  if (v == null) return false;
  const s = String(v).trim();
  return /^[0-9]+$/.test(s) || /^[0-9A-Za-z\-]+$/.test(s);
};

function deepFindId(obj) {
  if (!isObject(obj)) return "";
  const stack = [obj];
  const idKeys = [
    "callId",
    "hs_object_id",
    "objectId",
    "object_id",
    "id",
    // common locations:
    "properties.hs_object_id",
    "object.objectId",
    "input.objectId",
    "event.objectId",
    "object.id",
  ];

  // direct known paths first
  for (const k of idKeys) {
    const parts = k.split(".");
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (!isObject(cur) || !(p in cur)) {
        ok = false;
        break;
      }
      cur = cur[p];
    }
    if (ok && looksLikeId(cur)) return String(cur);
  }

  // fallback: DFS everything, prefer keys containing "id"
  while (stack.length) {
    const cur = stack.pop();
    if (!isObject(cur)) continue;
    for (const [k, v] of Object.entries(cur)) {
      if (k.toLowerCase().includes("id") && looksLikeId(v)) return String(v);
      if (isObject(v)) stack.push(v);
    }
  }
  return "";
}

function findRecordingUrl(body) {
  const direct =
    body?.recordingUrl ||
    body?.hs_call_video_recording_url ||
    body?.hs_call_recording_url ||
    "";

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  // try common nested paths
  const nestedCandidates = [
    body?.properties?.hs_call_video_recording_url,
    body?.properties?.hs_call_recording_url,
    body?.object?.properties?.hs_call_video_recording_url,
    body?.object?.properties?.hs_call_recording_url,
    body?.inputFields?.hs_call_video_recording_url,
    body?.inputFields?.hs_call_recording_url,
  ].filter(Boolean);

  for (const c of nestedCandidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

// ---------- endpoints ----------
app.post("/process-call", async (req, res) => {
  try {
    // 1) Parse webhook
    let callId =
      req.query?.callId ||
      req.body?.callId ||
      req.body?.hs_object_id ||
      deepFindId(req.body);
    if (callId) callId = String(callId).trim();

    let recordingUrl = findRecordingUrl(req.body);

    if (!callId) {
      // last-ditch: some HubSpot workflows wrap in different shapes
      const candidates = [
        req.body?.object?.id,
        req.body?.object?.objectId,
        req.body?.input?.objectId,
      ].filter(Boolean);
      if (candidates.length) callId = String(candidates[0]).trim();
    }

    if (!callId) {
      // explicit response HubSpot will log
      return res.status(400).json({ ok: false, error: "callId is required" });
    }

    // 2) If URL still missing but we have callId, fetch from HubSpot directly (WORKING PATTERN)
    if (!recordingUrl) {
      console.log("[info] recordingUrl missing in webhook — fetching from HubSpot Call…");
      try {
        const call = await getHubSpotObject("calls", callId, [
          "hs_call_video_recording_url",
          "hs_call_recording_url",
          "hs_call_recording_duration",
          "hs_call_status",
          "hubspot_owner_id",
          "hs_activity_type",
        ]);
        const p = call?.properties || {};
        recordingUrl =
          (p.hs_call_video_recording_url && p.hs_call_video_recording_url.trim()) ||
          (p.hs_call_recording_url && p.hs_call_recording_url.trim()) ||
          "";
        if (recordingUrl) console.log("[info] Found recording URL on Call.");
      } catch (err) {
        console.warn("[warn] Could not fetch call to find recording URL:", err.message);
      }
    }

    if (!recordingUrl) {
      console.warn("[warn] Missing callId or recordingUrl", {
        callIdPresent: !!callId,
        recordingUrlPresent: !!recordingUrl,
      });
      return res
        .status(400)
        .json({ ok: false, error: "callId and recordingUrl are required" });
    }

    // 3) Respond immediately to HubSpot; continue work in background
    res.json({ ok: true, callId });

    // ---------- BACKGROUND PIPELINE ----------
    try {
      const outPath = `/tmp/ai-call-worker/${callId}.mp3`;
      const chunkSeconds = Number(req.body?.chunkSeconds) || 120;
      const concurrency = Number(req.body?.concurrency) || 4;

      console.log(`[bg] Downloading audio to ${outPath}`);
      console.log(
        "[bg] Transcribing in parallel… (segment=%ss, concurrency=%s)",
        chunkSeconds,
        concurrency
      );

      // Use the signature that matches your working parallelTranscribe.js
      // transcribeAudioParallel(outFilePath, callId, { sourceUrl, segmentSeconds, concurrency })
      const transcript = await transcribeAudioParallel(outPath, callId, {
        sourceUrl: recordingUrl,
        segmentSeconds: chunkSeconds,
        concurrency,
      });

      console.log("[bg] Transcription done, fetching HubSpot call…");

      // Fetch call again for owner and activity type (safe even if fetched above)
      let callInfo = null;
      try {
        callInfo = await getHubSpotObject("calls", callId, [
          "hubspot_owner_id",
          "hs_activity_type",
        ]);
      } catch {
        // non-fatal
      }
      const ownerId = callInfo?.properties?.hubspot_owner_id || undefined;
      const typeLabel = callInfo?.properties?.hs_activity_type || "Initial Consultation";

      console.log("[ai] Analysing with TLPI context…");
      const analysis = await analyseTranscript(typeLabel, transcript);
      console.log("[ai] analysis:", analysis);

      // If transcript is empty/inaudible, analysis may carry a guard; just exit
      if (analysis?.uncertainty_reason === "Transcript contains no meaningful content.") {
        console.log("✅ Done", callId);
        return;
      }

      // Associations for contact/deal (optional)
      const contactIds = await getAssociations(callId, "contacts");
      const dealIds = await getAssociations(callId, "deals");
      console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

      // Update Call with AI fields (uses your hubspot.js v1.8 implementation)
      await updateCall(callId, analysis);

      // Create Scorecard and associate (hubspot.js createScorecard already enforces both directions via types[])
      const scorecardId = await createScorecard(analysis, {
        callId,
        contactIds,
        dealIds,
        ownerId,
      });
      if (scorecardId) console.log("[scorecard] created id:", scorecardId);

      console.log("✅ Done", callId);
    } catch (err) {
      console.error("❌ Background error:", err);
    }
  } catch (err) {
    console.error("❌ Background error (outer):", err);
    // If we reach here before the early 200, HubSpot needs a proper 500
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  }
});

// Optional: debug endpoints (handy, safe to leave in)
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "ai-call-worker",
    appVersion: APP_VERSION,
    startedAt: STARTED_AT,
  });
});

app.get("/env-check", (req, res) => {
  const keys = Object.keys(process.env)
    .filter((k) => k.toUpperCase().startsWith("HUBSPOT"))
    .sort();
  const hasAccess = !!process.env.HUBSPOT_ACCESS_TOKEN;
  const hasPrivate = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const hasLegacy = !!process.env.HUBSPOT_TOKEN;
  const tokenSource = hasAccess
    ? "HUBSPOT_ACCESS_TOKEN"
    : hasPrivate
    ? "HUBSPOT_PRIVATE_APP_TOKEN"
    : hasLegacy
    ? "HUBSPOT_TOKEN"
    : "NONE";
  res.json({
    ok: true,
    tokenSource,
    hasHubSpotToken: hasAccess || hasPrivate || hasLegacy,
    seenHubSpotEnvKeys: keys,
    node: process.version,
    now: Date.now(),
  });
});

app.get("/debug/call-recording", async (req, res) => {
  try {
    const { callId } = req.query;
    if (!callId) return res.status(400).json({ ok: false, error: "callId required" });
    const call = await getHubSpotObject("calls", String(callId), [
      "hs_call_video_recording_url",
      "hs_call_recording_url",
      "hs_call_recording_duration",
      "hs_call_status",
    ]);
    const p = call?.properties || {};
    res.json({
      ok: true,
      callId,
      hs_call_video_recording_url: p.hs_call_video_recording_url || null,
      hs_call_recording_url: p.hs_call_recording_url || null,
      hs_call_recording_duration: p.hs_call_recording_duration || null,
      hs_call_status: p.hs_call_status || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/debug-prompt", async (req, res) => {
  const { callType, transcript } = req.body || {};
  const prompt = await getCombinedPrompt(callType || "Initial Consultation", transcript || "");
  res.send({ callType, prompt });
});

// --- start server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[boot] ai-call-worker ${APP_VERSION} started at ${STARTED_AT} on port ${PORT}`);
});
