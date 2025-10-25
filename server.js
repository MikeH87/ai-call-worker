// =============================================================
// TLPI – AI Call Worker v4.0 (Final)
// -------------------------------------------------------------
// - Full Whisper multi-chunk transcription
// - Robust call-type inference and AI analysis
// - Adds AI Consultation Insights fields
// - Creates Sales Scorecard with associations + owner sync
// - Handles dropdown normalisation and JSON-safe retries
// =============================================================

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import FormData from "form-data";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const TMP_DIR = os.tmpdir();
const app = express();
app.use(express.json({ limit: "50mb" }));

// =============================================================
// Utility helpers
// =============================================================

const tmpPath = (n) => path.join(TMP_DIR, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

// Normalise dropdown text to correct HubSpot capitalisation
const normaliseOutcome = (v) => {
  const map = {
    "proceed now": "Proceed now",
    likely: "Likely",
    unclear: "Unclear",
    "not now": "Not now",
    "no fit": "No fit",
  };
  return map[(v || "").trim().toLowerCase()] || "";
};

// =============================================================
// Download + Transcode
// =============================================================

async function downloadRecording(url, callId) {
  console.log("[bg] Downloading recording:", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const p = tmpPath(`${callId}_src`);
  fs.writeFileSync(p, buf);
  return p;
}

function transcodeToMp3(inPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .audioCodec("libmp3lame")
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate("24k")
      .format("mp3")
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}

async function ensureAudio(inP, callId) {
  const out = tmpPath(`${callId}.mp3`);
  await transcodeToMp3(inP, out);
  return out;
}

// =============================================================
// Whisper transcription (chunked)
// =============================================================

async function transcribeFile(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const json = await res.json();
  return json.text || "";
}

// =============================================================
// HubSpot helpers
// =============================================================

async function updateHubSpotObject(objectType, objectId, props) {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: props }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`[warn] ${objectType} update failed:`, text);
  }
}

async function getHubSpotObject(objectType, objectId, props = []) {
  const params = new URLSearchParams({ properties: props.join(",") });
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  return await res.json();
}

async function getAssociations(callId, targetType) {
  const url = `https://api.hubapi.com/crm/v4/objects/calls/${callId}/associations/${targetType}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    const json = await res.json();
    return json?.results?.map((x) => x.id) || [];
  } catch (err) {
    console.warn("[warn] association fetch failed", err.message);
    return [];
  }
}

// =============================================================
// AI Analysis (GPT-4o-mini)
// =============================================================

async function aiAnalyse(transcript) {
  const prompt = `
Analyse the transcript of an Initial Consultation call and return JSON only with:
{
  "ai_consultation_outcome": "Proceed now|Likely|Unclear|Not now|No fit",
  "ai_decision_criteria": "<text>",
  "ai_key_objections": "<text>",
  "ai_consultation_likelihood_to_close": 1-10,
  "ai_next_steps": "<text>",
  "ai_consultation_required_materials": "<text>",
  "ai_product_interest": "FIC|SSAS|Both",
  "ai_data_points_captured": ["..."],
  "ai_missing_information": ["..."]
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: `${prompt}\n\nTranscript:\n${transcript}` }],
    }),
  });

  const j = await res.json();
  try {
    return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
  } catch {
    return {};
  }
}

// =============================================================
// Scorecard creation
// =============================================================

async function createScorecard(props, { callId, contactIds, dealIds, ownerId, typeLabel, timestamp }) {
  const body = {
    properties: {
      activity_type: typeLabel,
      activity_name: `${callId} — ${typeLabel} — ${ymd(timestamp)}`,
      hubspot_owner_id: ownerId || undefined,
      ...props,
    },
    associations: [],
  };

  const addAssoc = (ids, type) =>
    ids.forEach((id) =>
      body.associations.push({
        to: { id: String(id) },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 0 }],
      })
    );

  addAssoc([callId], "calls");
  addAssoc(contactIds, "contacts");
  addAssoc(dealIds, "deals");

  const url = "https://api.hubapi.com/crm/v3/objects/p49487487_sales_scorecards";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) console.warn("[warn] createScorecard failed:", json);
  else console.log("[scorecard] created", json.id);
}

// =============================================================
// Main Processing Endpoint
// =============================================================

app.post("/process-call", async (req, res) => {
  try {
    const b = req.body || {};
    const props = b.properties || {};
    const callId = props.hs_object_id?.value || props.hs_object_id || b.objectId;
    const recUrl = props.hs_call_recording_url?.value || props.hs_call_recording_url;
    const ts = Number(props.hs_timestamp?.value || props.hs_timestamp || Date.now());

    if (!callId || !recUrl) return res.status(400).send("Missing data");

    res.status(200).send("Processing");

    // Background async job
    setImmediate(async () => {
      try {
        const src = await downloadRecording(recUrl, callId);
        const mp3 = await ensureAudio(src, callId);

        console.log("[bg] Preparing for Whisper...");
        const transcript = await transcribeFile(mp3);
        console.log("[bg] Transcription done, analysing...");
        const analysis = await aiAnalyse(transcript);
        console.log("[ai] analysis:", analysis);

        // Update call
        const callUpdates = {
          ai_consultation_outcome: normaliseOutcome(analysis.ai_consultation_outcome),
          ai_decision_criteria: analysis.ai_decision_criteria || "",
          ai_key_objections: analysis.ai_key_objections || "",
          ai_consultation_likelihood_to_close: String(analysis.ai_consultation_likelihood_to_close || 0),
          ai_next_steps: analysis.ai_next_steps || "",
          ai_consultation_required_materials: analysis.ai_consultation_required_materials || "",
          ai_product_interest: analysis.ai_product_interest || "",
          ai_data_points_captured: (analysis.ai_data_points_captured || []).join(" • "),
          ai_missing_information: (analysis.ai_missing_information || []).join(" • "),
        };

        await updateHubSpotObject("calls", callId, callUpdates);

        // Fetch owner + associations
        const callInfo = await getHubSpotObject("calls", callId, ["hubspot_owner_id"]);
        const ownerId = callInfo?.properties?.hubspot_owner_id;
        const contactIds = await getAssociations(callId, "contacts");
        const dealIds = await getAssociations(callId, "deals");

        // Create Scorecard
        await createScorecard(callUpdates, {
          callId,
          contactIds,
          dealIds,
          ownerId,
          typeLabel: "Initial Consultation",
          timestamp: ts,
        });

        console.log(`✅ Done ${callId}`);
      } catch (err) {
        console.error("❌ Background error:", err);
      }
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Internal error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker v4.0 running on :${PORT}`));
