// index.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import { analyseTranscript } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";
import { createScorecard, updateCall, getHubSpotObject, getAssociations } from "./hubspot/hubspot.js";

dotenv.config();
const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

app.get("/", (req, res) => {
  res.send("AI Call Worker v4.x modular running ✅");
});

app.get("/env-check", (req, res) => {
  const keys = Object.keys(process.env).filter(k => k.toUpperCase().startsWith("HUBSPOT")).sort();
  const hasAccess = !!process.env.HUBSPOT_ACCESS_TOKEN;
  const hasPrivate = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const tokenSource = hasAccess ? "HUBSPOT_ACCESS_TOKEN" : (hasPrivate ? "HUBSPOT_PRIVATE_APP_TOKEN" : (process.env.HUBSPOT_TOKEN ? "HUBSPOT_TOKEN" : "NONE"));
  res.json({ ok: true, tokenSource, hasHubSpotToken: hasAccess || hasPrivate || !!process.env.HUBSPOT_TOKEN, seenHubSpotEnvKeys: keys, node: process.version, now: Date.now() });
});

// Helper: robust extractor for HubSpot webhook shapes
function extractFromWebhook(body = {}) {
  const b = body || {};
  // Common locations
  const input = b.inputFields || {};
  const props = b.properties || b.objectProperties || {};
  // Candidates for call id
  const candidatesId = [
    b.callId, b.objectId, b.id, b.hs_object_id,
    input.hs_object_id, input.objectId,
    props.hs_object_id
  ].filter(Boolean);

  // Candidates for recordingUrl
  const candidatesUrl = [
    b.recordingUrl,
    input.recordingUrl,
    props.hs_call_video_recording_url,
    props.hs_call_recording_url,
    input.hs_call_video_recording_url,
    input.hs_call_recording_url
  ].filter(Boolean);

  const callId = String(candidatesId[0] || "").trim();
  const recordingUrl = String(candidatesUrl[0] || "").trim();

  return { callId, recordingUrl, seen: { candidatesId, candidatesUrl } };
}

// Optional: check a call’s recording URL using the configured token
app.get("/debug/call-recording", async (req, res) => {
  try {
    const { callId } = req.query;
    if (!callId) return res.status(400).json({ ok: false, error: "callId required" });
    const call = await getHubSpotObject("calls", String(callId), [
      "hs_call_video_recording_url",
      "hs_call_recording_url",
      "hs_call_recording_duration",
      "hs_call_status"
    ]);
    const p = call?.properties || {};
    res.json({
      ok: true,
      callId,
      hs_call_video_recording_url: p.hs_call_video_recording_url || null,
      hs_call_recording_url: p.hs_call_recording_url || null,
      hs_call_recording_duration: p.hs_call_recording_duration || null,
      hs_call_status: p.hs_call_status || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/process-call", async (req, res) => {
  try {
    // 1) Parse webhook
    let { callId, recordingUrl, chunkSeconds, concurrency } = req.body || {};
    const parsed = extractFromWebhook(req.body);
    callId = String(callId || parsed.callId || "").trim();
    recordingUrl = String(recordingUrl || parsed.recordingUrl || "").trim();

    // Log what we saw
    if (!callId || !recordingUrl) {
      console.log("[webhook] raw keys:", Object.keys(req.body || {}));
      console.log("[webhook] parsed candidates:", parsed.seen);
    }

    // 2) If recordingUrl not provided, try to fetch from HubSpot
    if (callId && !recordingUrl) {
      console.log("[info] recordingUrl missing — fetching from HubSpot Call…");
      try {
        const call = await getHubSpotObject("calls", callId, [
          "hs_call_video_recording_url",
          "hs_call_recording_url",
          "hs_call_recording_duration",
          "hs_call_status"
        ]);
        recordingUrl = call?.properties?.hs_call_video_recording_url
          || call?.properties?.hs_call_recording_url
          || null;
        if (recordingUrl) console.log("[info] Found recording URL on Call.");
      } catch (err) {
        console.warn("[warn] Could not fetch call to find recording URL:", err.message);
      }
    }

    // 3) Validate presence
    if (!callId || !recordingUrl) {
      console.warn("[warn] Missing callId or recordingUrl", { callIdPresent: !!callId, recordingUrlPresent: !!recordingUrl });
      return res.status(400).json({ ok: false, error: "callId and recordingUrl are required" });
    }

    // Respond immediately, then background work
    res.status(200).send({ ok: true, callId });

    // 4) Transcription
    const dest = `/tmp/ai-call-worker/${callId}.mp3`;
    console.log(`[bg] Downloading audio to ${dest}`);
    console.log("[bg] Transcribing in parallel… (segment=%ss, concurrency=%s)", Number(chunkSeconds) || 120, Number(concurrency) || 4);

    let transcript;
    try {
      transcript = await transcribeAudioParallel(dest, callId, {
        sourceUrl: recordingUrl,
        segmentSeconds: Number(chunkSeconds) || 120,
        concurrency: Number(concurrency) || 4,
      });
    } catch (err) {
      if (err && err.code === "EMPTY_TRANSCRIPT") {
        console.warn("[bg] Empty/blank recording detected — skipping AI analysis to save tokens.");
        return;
      }
      throw err;
    }

    console.log("[bg] Transcription done, fetching HubSpot call…");

    // 5) Analysis (using TLPI context + call type)
    const callInfo = await getHubSpotObject("calls", callId, ["hubspot_owner_id", "hs_activity_type"]);
    const typeLabel = callInfo?.properties?.hs_activity_type || "Initial Consultation";

    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(typeLabel, transcript);
    console.log("[ai] analysis:", analysis);

    // 6) Associations + updates
    const ownerId = callInfo?.properties?.hubspot_owner_id;
    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

    await updateCall(callId, analysis);
    const newId = await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    if (newId) console.log("[scorecard] created id:", newId);

    console.log(`✅ Done ${callId}`);
  } catch (err) {
    console.error("❌ Background error:", err);
  }
});

app.post("/debug-prompt", async (req, res) => {
  const { callType, transcript } = req.body || {};
  const prompt = await getCombinedPrompt(callType || "Initial Consultation", transcript || "");
  res.send({ callType, prompt });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
