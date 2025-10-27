// index.js — v4.1.0-force-assoc
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import { analyseTranscript } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";
import {
  createScorecard,
  updateCall,
  getHubSpotObject,
  getAssociations,
  associateScorecardAllViaTypes,
} from "./hubspot/hubspot.js";

dotenv.config();
const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

console.log("index.js — v4.1.0-force-assoc");

app.get("/", (req, res) => {
  res.send("AI Call Worker v4.x modular running ✅");
});

app.get("/env-check", (req, res) => {
  const keys = Object.keys(process.env).filter(k => k.toUpperCase().startsWith("HUBSPOT")).sort();
  const hasAccess = !!process.env.HUBSPOT_ACCESS_TOKEN;
  const hasPrivate = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const hasLegacy = !!process.env.HUBSPOT_TOKEN;
  const tokenSource = hasAccess ? "HUBSPOT_ACCESS_TOKEN" : (hasPrivate ? "HUBSPOT_PRIVATE_APP_TOKEN" : (hasLegacy ? "HUBSPOT_TOKEN" : "NONE"));
  res.json({ ok: true, tokenSource, hasHubSpotToken: hasAccess || hasPrivate || hasLegacy, seenHubSpotEnvKeys: keys, node: process.version, now: Date.now() });
});

// helpers
function getPath(obj, path) {
  return path.split(".").reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj);
}
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}
function urlify(val) {
  if (!val) return "";
  if (Array.isArray(val)) return urlify(val[0]);
  if (typeof val === "object") return urlify(val.url || val.href || val.link || val.value || val.src || val.source || val.toString?.());
  const s = String(val).trim();
  return /^https?:\/\//i.test(s) ? s : "";
}
function idify(val) {
  if (!val) return "";
  if (Array.isArray(val)) return idify(val[0]);
  if (typeof val === "object") return idify(val.id || val.hs_object_id || val.value || val.toString?.());
  const s = String(val).trim();
  return s.length ? s : "";
}

function extractFromWebhook(body = {}) {
  const b = body || {};
  const input = b.inputFields || {};
  const props = b.properties || b.objectProperties || b.object?.properties || {};

  const callId = idify(firstDefined(
    b.callId, b.objectId, b.id, b.hs_object_id,
    input.hs_object_id, input.objectId, input.id,
    props.hs_object_id,
    getPath(b, "object.id")
  ));

  const recordingUrl = urlify(firstDefined(
    b.recordingUrl,
    input.recordingUrl,
    props.hs_call_video_recording_url,
    props.hs_call_recording_url,
    input.hs_call_video_recording_url,
    input.hs_call_recording_url,
    getPath(b, "recording.url"),
    getPath(b, "properties.recordingUrl"),
    getPath(b, "inputFields.recording.url")
  ));

  const candidatesId = [b.callId, b.objectId, b.id, b.hs_object_id, input.hs_object_id, input.objectId, input.id, props.hs_object_id, getPath(b, "object.id")].filter(v => v !== undefined);
  const candidatesUrl = [b.recordingUrl, input.recordingUrl, props.hs_call_video_recording_url, props.hs_call_recording_url, input.hs_call_video_recording_url, input.hs_call_recording_url, getPath(b, "recording.url"), getPath(b, "properties.recordingUrl"), getPath(b, "inputFields.recording.url")].filter(v => v !== undefined);

  return { callId, recordingUrl, seen: { candidatesId, candidatesUrl } };
}

// optional debug
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
    res.json({ ok: true, callId,
      hs_call_video_recording_url: p.hs_call_video_recording_url || null,
      hs_call_recording_url: p.hs_call_recording_url || null,
      hs_call_recording_duration: p.hs_call_recording_duration || null,
      hs_call_status: p.hs_call_status || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// NEW: manual assoc test endpoint
app.post("/assoc-test", async (req, res) => {
  try {
    const { scorecardId, callId, contactIds = [], dealIds = [] } = req.body || {};
    if (!scorecardId || !callId) return res.status(400).json({ ok: false, error: "scorecardId and callId are required" });
    await associateScorecardAllViaTypes({ scorecardId, callId, contactIds, dealIds });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/process-call", async (req, res) => {
  try {
    let { callId, recordingUrl, chunkSeconds, concurrency } = req.body || {};
    const parsed = extractFromWebhook(req.body);
    callId = idify(callId) || parsed.callId;
    recordingUrl = urlify(recordingUrl) || parsed.recordingUrl;

    if (!callId || !recordingUrl) {
      console.log("[webhook] raw keys:", Object.keys(req.body || {}));
      console.log("[webhook] parsed candidates (IDs):", parsed.seen.candidatesId);
      console.log("[webhook] parsed candidates (URLs):", parsed.seen.candidatesUrl);
    }

    if (callId && !recordingUrl) {
      console.log("[info] recordingUrl missing — fetching from HubSpot Call…");
      try {
        const call = await getHubSpotObject("calls", callId, [
          "hs_call_video_recording_url",
          "hs_call_recording_url",
          "hs_call_recording_duration",
          "hs_call_status"
        ]);
        const p = call?.properties || {};
        recordingUrl = (p.hs_call_video_recording_url && /^https?:\/\//i.test(p.hs_call_video_recording_url)) ? p.hs_call_video_recording_url
                      : (p.hs_call_recording_url && /^https?:\/\//i.test(p.hs_call_recording_url)) ? p.hs_call_recording_url
                      : "";
        if (recordingUrl) console.log("[info] Found recording URL on Call.");
      } catch (err) {
        console.warn("[warn] Could not fetch call to find recording URL:", err.message);
      }
    }

    if (!callId || !recordingUrl) {
      console.warn("[warn] Missing callId or recordingUrl", { callIdPresent: !!callId, recordingUrlPresent: !!recordingUrl });
      return res.status(400).json({ ok: false, error: "callId and recordingUrl are required" });
    }

    res.status(200).send({ ok: true, callId });

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
      console.error("[bg] Transcription error:", err.message || err);
      throw err;
    }

    console.log("[bg] Transcription done, fetching HubSpot call…");

    const callInfo = await getHubSpotObject("calls", callId, ["hubspot_owner_id", "hs_activity_type"]);
    const typeLabel = callInfo?.properties?.hs_activity_type || "Initial Consultation";

    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(typeLabel, transcript);
    console.log("[ai] analysis:", analysis);

    const ownerId = callInfo?.properties?.hubspot_owner_id;
    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

    await updateCall(callId, analysis);

    const scorecardId = await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    if (scorecardId) {
      console.log("[scorecard] created id:", scorecardId);

      // FORCED association (with verification GETs inside)
      console.log("[force-assoc] start…");
      await associateScorecardAllViaTypes({ scorecardId, callId, contactIds, dealIds });
      console.log("[force-assoc] done.");
    }

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
