// index.js — v4.2.5-qualification-call-mapping
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

let _zoomTokenCache = { token: null, expiresAt: 0 };

function _basicAuthHeader(user, pass) {
  const raw = `${user}:${pass}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

async function getZoomAccessToken() {
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Missing Zoom env vars: ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET");
  }

  const now = Date.now();
  if (_zoomTokenCache.token && now < _zoomTokenCache.expiresAt) {
    return _zoomTokenCache.token;
  }

  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: _basicAuthHeader(clientId, clientSecret),
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Zoom token request failed: ${res.status} ${t.slice(0, 200)}`);
  }

  const js = await res.json();
  const token = js.access_token;
  const expiresIn = Number(js.expires_in || 3600);

  if (!token) throw new Error("Zoom token response missing access_token");

  // refresh ~60s early
  _zoomTokenCache.token = token;
  _zoomTokenCache.expiresAt = Date.now() + Math.max(0, (expiresIn - 60)) * 1000;

  return token;
}

function looksLikeMediaContentType(ct) {
  if (!ct) return false;
  const c = ct.toLowerCase();
  return c.startsWith("audio/") || c.startsWith("video/") || c.includes("octet-stream");
}

async function getZoomDownloadUrl(rawUrl) {
  const u = new URL(rawUrl);
  const isZoomWebhookDownload =
    /zoom\.us$/i.test(u.hostname) && u.pathname.includes("/rec/webhook_download/");

  if (!isZoomWebhookDownload) return rawUrl;

  const token = await getZoomAccessToken();
  if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", token);
  return u.toString();
}

import { analyseTranscript } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { getCombinedPrompt } from "./ai/getCombinedPrompt.js";
import { analyseQualification } from "./ai/analyseQualification.js";


import * as HS from "./hubspot/hubspot.js";

const {
  createScorecard,
  updateCall,
  getHubSpotObject,
  getAssociations,
  associateScorecardAllViaTypes,
  updateQualificationCall,
  createQualificationScorecard,
} = HS;

dotenv.config();
const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

console.log("index.js — v4.2.5-qualification-call-mapping");
try { console.log("HS exports available:", Object.keys(HS)); } catch {}

// ---------- tiny utils ----------
function getPath(obj, path) { return path.split(".").reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj); }
function firstDefined(...vals) { for (const v of vals) if (v !== undefined && v !== null) return v; }
function urlify(val) { if (!val) return ""; if (Array.isArray(val)) return urlify(val[0]); if (typeof val === "object") return urlify(val.url || val.href || val.link || val.value || val.src || val.source || val.toString?.()); const s = String(val).trim(); return /^https?:\/\//i.test(s) ? s : ""; }
function idify(val) { if (!val) return ""; if (Array.isArray(val)) return idify(val[0]); if (typeof val) return String(val.id || val.hs_object_id || val.value || val).trim(); }

// ---------- routes ----------
app.get("/", (_req, res) => res.send("AI Call Worker v4.x running ✅"));

app.get("/env-check", (_req, res) => {
  const keys = Object.keys(process.env).filter(k => k.toUpperCase().startsWith("HUBSPOT")).sort();
  const hasAccess = !!process.env.HUBSPOT_ACCESS_TOKEN;
  const hasPrivate = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const hasLegacy = !!process.env.HUBSPOT_TOKEN;
  const tokenSource = hasAccess ? "HUBSPOT_ACCESS_TOKEN" : (hasPrivate ? "HUBSPOT_PRIVATE_APP_TOKEN" : (hasLegacy ? "HUBSPOT_TOKEN" : "NONE"));
  res.json({ ok: true, tokenSource, hasHubSpotToken: hasAccess || hasPrivate || hasLegacy, seenHubSpotEnvKeys: keys, node: process.version, now: Date.now() });
});

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

  return { callId, recordingUrl };
}

app.post("/process-call", async (req, res) => {
  try {
    let { callId, recordingUrl, chunkSeconds, concurrency } = req.body || {};
    const parsed = extractFromWebhook(req.body);
    callId = idify(callId) || parsed.callId;
    recordingUrl = urlify(recordingUrl) || parsed.recordingUrl;

    if (!callId) return res.status(400).json({ ok: false, error: "callId required" });

    if (!recordingUrl) {
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

    if (!recordingUrl) return res.status(400).json({ ok: false, error: "recordingUrl required" });

    // Early 200 so HubSpot doesn't retry immediately
    res.status(200).send({ ok: true, callId });

    const dest = `/tmp/ai-call-worker/${callId}.download`;
    console.log("[bg] Processing call", callId);
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
      if (err && err.code === "EMPTY_TRANSCRIPT") { console.warn("[bg] Empty/blank recording — skipping AI analysis."); return; }
      console.error("[bg] Transcription error:", err.message || err);
      throw err;
    }

    const callInfo = await getHubSpotObject("calls", callId, ["hubspot_owner_id", "hs_activity_type"]);
    const ownerId = callInfo?.properties?.hubspot_owner_id;
    const typeLabel = callInfo?.properties?.hs_activity_type || "Initial Consultation";

    // Branch by activity type
    if (/^qualification call$/i.test(typeLabel)) {
      console.log("[ai] Call type detected: Qualification Call");
      console.log("🟦 Running Qualification Call analysis…");

      const analysis = await analyseQualification(transcript);

      const contactIds = await getAssociations(callId, "contacts");
      const dealIds = await getAssociations(callId, "deals");
      console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

      // Write ONLY generic call fields (NOT ai_qualification_* — those belong to scorecard)
      await updateQualificationCall(callId, analysis);

        { const { patchQualificationCallProps } = await import("./hubspot/patch_qualification_props.js"); await patchQualificationCallProps({ callId, data: analysis }); } // Create scorecard (owner carried)

      const scorecardId = await createQualificationScorecard({ callId, contactIds, ownerId, data: analysis });
      console.log("[scorecard] Qualification created:", scorecardId);

      if (scorecardId) {
        console.log("[force-assoc] start (qualification) …");
        if (typeof associateScorecardAllViaTypes === "function") await associateScorecardAllViaTypes({ scorecardId, callId, contactIds, dealIds });
        console.log("[force-assoc] done (qualification).");
      }
      console.log("✅ Qualification Call complete");
      return;
    }

    // Default: Initial Consultation
    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(typeLabel, transcript);

    const contactIds = await getAssociations(callId, "contacts");
    const dealIds = await getAssociations(callId, "deals");
    console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

    await updateCall(callId, analysis);

    const scorecardId = await createScorecard(analysis, { callId, contactIds, dealIds, ownerId });
    if (scorecardId) {
      console.log("[force-assoc] start…");
      if (typeof associateScorecardAllViaTypes === "function") await associateScorecardAllViaTypes({ scorecardId, callId, contactIds, dealIds });
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






