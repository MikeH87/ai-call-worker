console.log("index.js — v4.2.2-qualification-assoc");
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import { analyseTranscript } from "./ai/analyse.js";
import { analyseQualification } from "./ai/analyseQualification.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";
import {
  updateQualificationCall,
  createQualificationScorecard,
} from "./hubspot/hubspot.js";

// Namespace import for all HubSpot exports
import * as HS from "./hubspot/hubspot.js";

dotenv.config();
const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

console.log("index.js — v4.2.1-qualification-assoc");
try { console.log("HS exports available:", Object.keys(HS)); } catch {}

const {
  createScorecard,
  updateCall,
  getHubSpotObject,
  getAssociations,
  associateScorecardAllViaTypes,
} = HS;

// ---------- routes ----------
app.get("/", (req, res) => {
  res.send("AI Call Worker v4.2.1 (Qualification + IC) ✅");
});

app.get("/env-check", (req, res) => {
  const keys = Object.keys(process.env).filter(k => k.toUpperCase().startsWith("HUBSPOT")).sort();
  const hasAccess = !!process.env.HUBSPOT_ACCESS_TOKEN;
  const hasPrivate = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const hasLegacy = !!process.env.HUBSPOT_TOKEN;
  const tokenSource = hasAccess ? "HUBSPOT_ACCESS_TOKEN" : (hasPrivate ? "HUBSPOT_PRIVATE_APP_TOKEN" : (hasLegacy ? "HUBSPOT_TOKEN" : "NONE"));
  res.json({ ok: true, tokenSource, hasHubSpotToken: hasAccess || hasPrivate || hasLegacy, seenHubSpotEnvKeys: keys, node: process.version, now: Date.now() });
});

// ---------- helpers ----------
function getPath(obj, path) { return path.split(".").reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj); }
function firstDefined(...vals) { for (const v of vals) if (v !== undefined && v !== null) return v; return undefined; }
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
  const callId = idify(firstDefined(b.callId, b.objectId, b.id, b.hs_object_id, input.hs_object_id, input.objectId, input.id, props.hs_object_id, getPath(b, "object.id")));
  const recordingUrl = urlify(firstDefined(b.recordingUrl, input.recordingUrl, props.hs_call_video_recording_url, props.hs_call_recording_url, input.hs_call_video_recording_url, input.hs_call_recording_url, getPath(b, "recording.url"), getPath(b, "properties.recordingUrl"), getPath(b, "inputFields.recording.url")));
  return { callId, recordingUrl };
}

// ---------- main route ----------
app.post("/process-call", async (req, res) => {
  try {
    let { callId, recordingUrl, chunkSeconds, concurrency } = req.body || {};
    const parsed = extractFromWebhook(req.body);
    callId = idify(callId) || parsed.callId;
    recordingUrl = urlify(recordingUrl) || parsed.recordingUrl;

    if (!callId || !recordingUrl) {
      return res.status(400).json({ ok: false, error: "callId and recordingUrl required" });
    }

    // Acknowledge immediately
    res.status(200).send({ ok: true, callId });

    console.log(`[bg] Processing call ${callId}`);
    const dest = `/tmp/ai-call-worker/${callId}.mp3`;

    // Transcribe
    const transcript = await transcribeAudioParallel(dest, callId, {
      sourceUrl: recordingUrl,
      segmentSeconds: Number(chunkSeconds) || 120,
      concurrency: Number(concurrency) || 4,
    });

    const callInfo = await getHubSpotObject("calls", callId, ["hubspot_owner_id", "hs_activity_type"]);
    const typeLabel = callInfo?.properties?.hs_activity_type || "";
    const ownerId = callInfo?.properties?.hubspot_owner_id;
    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });
    console.log(`[ai] Call type detected: ${typeLabel || "(none)"}`);

    // Qualification path
    if (typeLabel === "Qualification Call") {
      console.log("🟦 Running Qualification Call analysis…");
      const analysis = await analyseQualification(transcript);

      await updateQualificationCall(callId, analysis);
      const scorecardId = await createQualificationScorecard({ callId, contactIds, data: analysis });
      console.log("[scorecard] Qualification created:", scorecardId);

      // NEW: use robust association helper (handles label/type discovery)
      if (scorecardId) {
        console.log("[force-assoc] start (qualification) …");
        await associateScorecardAllViaTypes({ scorecardId, callId, contactIds, dealIds: [] });
        console.log("[force-assoc] done (qualification).");
      }

      console.log("✅ Qualification Call complete");
      return;
    }

    // Initial Consultation path (existing)
    console.log("🟩 Running Initial Consultation analysis…");
    const analysis = await analyseTranscript(typeLabel, transcript);
    await updateCall(callId, analysis);

    const scorecardId = await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    if (scorecardId) {
      console.log("[scorecard] created id:", scorecardId);
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
