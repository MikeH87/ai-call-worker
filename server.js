// =============================================================
// TLPI – AI Call Worker (v3.9.3)
// - Adds expanded Initial Consultation fields
// - Mirrors all key consultation fields into Sales Scorecard
// - Copies owner and propagates associations (Call→Contact→Deal→Scorecard)
// =============================================================

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import FormData from "form-data";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const GRACE_MS = Number(process.env.GRACE_MS ?? 0);
const SCORECARD_BY_METRICS = String(process.env.SCORECARD_BY_METRICS ?? "true").toLowerCase() === "true";
const TMP_DIR = os.tmpdir();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: "50mb" }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tmpPath = (n) => path.join(TMP_DIR, n);

// --- Utility
async function fetchWithRetry(url, opts = {}, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    last = r;
    await sleep(400 * (i + 1));
  }
  throw new Error(`HTTP ${last?.status} ${await last.text()}`);
}
function ymd(d) { const dt = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}`; }

// --- Download and transcode
async function downloadRecording(url, callId) {
  console.log("[bg] Downloading recording:", url);
  const r = await fetchWithRetry(url, { headers: {} });
  const buf = Buffer.from(await r.arrayBuffer());
  const p = tmpPath(`${callId}_src`);
  fs.writeFileSync(p, buf);
  return p;
}
function transcodeToMp3(inP, outP) {
  return new Promise((res, rej) => {
    ffmpeg(inP)
      .audioCodec("libmp3lame").audioChannels(1).audioFrequency(16000).audioBitrate("24k").format("mp3")
      .output(outP).on("end", () => res(outP)).on("error", rej).run();
  });
}
async function ensureAudio(inP, callId) {
  const out = tmpPath(`${callId}.mp3`);
  await transcodeToMp3(inP, out);
  return out;
}

// --- Whisper transcription
async function transcribe(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form
  });
  const j = await r.json();
  return j.text || "";
}

// --- HubSpot helpers
async function updateCall(callId, props) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: props })
  });
  if (!r.ok) console.warn("[warn] updateCall failed:", await r.text());
}
async function getCall(callId, fields = ["hubspot_owner_id"]) {
  const params = new URLSearchParams({ properties: fields.join(",") });
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}?${params}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  const j = await r.json();
  return j?.properties || {};
}

// --- Associations
async function getAssociations(from, to) {
  const r = await fetch(`https://api.hubapi.com/crm/v4/objects/${from}/${to}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  const j = await r.json();
  return j?.results?.map(x => x.id) || [];
}
async function createScorecard(props, { callId, contactIds, dealIds, ownerId, typeLabel, timestamp }) {
  const body = { properties: {
    activity_type: typeLabel,
    activity_name: `${callId} — ${typeLabel} — ${ymd(timestamp)}`,
    hubspot_owner_id: ownerId || undefined,
    ...props
  }};
  body.associations = [];
  const assoc = (ids, obj) => ids.forEach(id => body.associations.push({
    to: { id: String(id) },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 0 }]
  }));
  assoc([callId], "calls");
  assoc(contactIds, "contacts");
  assoc(dealIds, "deals");
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/p49487487_sales_scorecards", {
    method: "POST", headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) console.warn("[warn] createScorecard failed", j);
  else console.log("[scorecard] created", j.id);
}

// --- AI
async function aiAnalyse(transcript) {
  const prompt = `
Analyse this Initial Consultation transcript. Return JSON with:
{
 "ai_consultation_outcome": "proceed now|likely|unclear|not now|no fit",
 "ai_decision_criteria": "<text>",
 "ai_key_objections": "<text>",
 "ai_consultation_likelihood_to_close": 1-10,
 "ai_next_steps": "<text>",
 "ai_consultation_required_materials": "<text>",
 "ai_product_interest": "FIC|SSAS|Both",
 "ai_data_points_captured": ["..."],
 "ai_missing_information": ["..."]
}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: `${prompt}\n\nTranscript:\n${transcript}` }]
    })
  });
  const j = await r.json();
  try { return JSON.parse(j?.choices?.[0]?.message?.content || "{}"); }
  catch { return {}; }
}

// --- Endpoint
app.post("/process-call", async (req, res) => {
  try {
    const b = req.body || {};
    const props = b.properties || {};
    const callId = props.hs_object_id?.value || props.hs_object_id || b.objectId;
    const recUrl = props.hs_call_recording_url?.value || props.hs_call_recording_url;
    const ts = Number(props.hs_timestamp?.value || props.hs_timestamp || Date.now());
    if (!callId || !recUrl) return res.status(400).send("Missing data");
    res.status(200).send("Processing");

    setImmediate(async () => {
      const src = await downloadRecording(recUrl, callId);
      const mp3 = await ensureAudio(src, callId);
      const transcript = await transcribe(mp3);
      const analysis = await aiAnalyse(transcript);
      console.log("[ai] analysis:", analysis);

      // --- Update Call
      const callUpdates = {
        ai_consultation_outcome: analysis.ai_consultation_outcome || "",
        ai_decision_criteria: analysis.ai_decision_criteria || "",
        ai_key_objections: analysis.ai_key_objections || "",
        ai_consultation_likelihood_to_close: String(analysis.ai_consultation_likelihood_to_close || 0),
        ai_next_steps: analysis.ai_next_steps || "",
        ai_consultation_required_materials: analysis.ai_consultation_required_materials || "",
        ai_product_interest: analysis.ai_product_interest || "",
        ai_data_points_captured: (analysis.ai_data_points_captured || []).join(" • "),
        ai_missing_information: (analysis.ai_missing_information || []).join(" • ")
      };
      await updateCall(callId, callUpdates);

      // --- Associations + owner
      const callInfo = await getCall(callId, ["hubspot_owner_id"]);
      const contactIds = await getAssociations(`calls/${callId}`, "contacts");
      const dealIds = await getAssociations(`calls/${callId}`, "deals");

      // --- Create Scorecard
      await createScorecard(callUpdates, {
        callId, contactIds, dealIds,
        ownerId: callInfo.hubspot_owner_id,
        typeLabel: "Initial Consultation", timestamp: ts
      });
      console.log("✅ Done", callId);
    });
  } catch (e) {
    console.error("❌ Error", e);
    res.status(500).send("Internal error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker v3.9.3 running on :${PORT}`));
