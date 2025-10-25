// =============================================================
// TLPI – AI Call Worker  (v2.0)
// =============================================================

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import FormData from "form-data";

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---- Helpers ----
async function fetchWithRetry(url, opts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, opts);
    if (res.ok) return res;
    console.warn(`[retry] attempt ${i + 1}/${retries} — waiting`);
    await new Promise(r => setTimeout(r, Math.pow(2, i) * 700));
  }
  throw new Error(`HTTP ${res.status} ${await res.text()}`);
}

async function downloadRecording(recordingUrl, callId) {
  console.log(`[bg] Downloading recording: ${recordingUrl}`);
  const r = await fetchWithRetry(recordingUrl, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = path.join("/tmp", `${callId}.mp3`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

// ---- Transcription ----
async function transcribeAudio(filePath) {
  console.log("[bg] Transcribing...");
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`OpenAI transcription failed: ${r.status}`);
  const j = await r.json();
  return j.text;
}

// =============================================================
// ---- CALL TYPE INFERENCE + GRACE ----
// =============================================================

const CALL_TYPE_LABELS = [
  "Qualification call",
  "Initial Consultation",
  "Follow up call",
  "Application meeting",
  "Strategy call",
  "Annual Review",
  "Existing customer call",
  "Other",
];

async function fetchCallProps(callId, props = ["hs_activity_type"]) {
  const params = new URLSearchParams({ properties: props.join(",") });
  const r = await fetch(
    `https://api.hubapi.com/crm/v3/objects/calls/${callId}?${params}`,
    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
  );
  if (!r.ok) return {};
  return (await r.json()).properties || {};
}

async function classifyCallTypeFromTranscript(transcript) {
  const sys =
    "Classify this call transcript into one of these labels ONLY:\n" +
    CALL_TYPE_LABELS.join(", ") +
    "\nReturn JSON {\"label\":\"<one>\",\"confidence\":<0-100>}";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys }, { role: "user", content: transcript }],
    }),
  });
  const j = await r.json();
  try {
    const o = JSON.parse(j?.choices?.[0]?.message?.content || "{}");
    const label = CALL_TYPE_LABELS.includes(o.label) ? o.label : "Other";
    const confidence = Number(o.confidence || 0);
    return { typeLabel: label, confidence };
  } catch {
    return { typeLabel: "Other", confidence: 0 };
  }
}

async function resolveCallTypeWithGrace(callId, transcript, graceMs = 120000) {
  const first = await fetchCallProps(callId, ["hs_activity_type"]);
  if (first.hs_activity_type) return first.hs_activity_type;

  console.log(`[type] hs_activity_type blank — waiting ${graceMs / 1000}s`);
  await new Promise(r => setTimeout(r, graceMs));

  const second = await fetchCallProps(callId, ["hs_activity_type"]);
  if (second.hs_activity_type) return second.hs_activity_type;

  console.log("[type] inferring type...");
  const { typeLabel, confidence } = await classifyCallTypeFromTranscript(transcript);
  console.log(`[type] inferred=${typeLabel} conf=${confidence}`);

  // write inference
  await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        ai_inferred_call_type: typeLabel,
        ai_call_type_confidence: String(confidence),
      },
    }),
  });

  if (confidence >= 75) {
    console.log("[type] promoting to hs_activity_type");
    await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { hs_activity_type: typeLabel } }),
    });
  }

  return typeLabel;
}

// =============================================================
// ---- ANALYSIS LOGIC ----
// =============================================================

async function analyseCall(typeLabel, transcript) {
  const system =
    "You are TLPI’s call analysis bot. Follow rubrics strictly. Output JSON only.";

  const basePrompts = {
    "Qualification call": "Analyse sales discovery performance and output the 10 qualification metrics, 1–10 score, reasoning, objections, and suggestions.",
    "Initial Consultation": "Analyse consultation delivery, tax discussion clarity, application data capture, objections, and closing behaviour.",
    "Follow up call": "Analyse follow-up performance, remaining objections, likelihood to close, and next-step quality.",
    "Application meeting": "List key client data captured, missing information, and next steps.",
    "Strategy call": "Summarise focus areas, recommendations, and engagement level.",
    "Annual Review": "Summarise satisfaction level, achievements, and improvement areas.",
    "Existing customer call": "Detect sentiment, complaints, escalation need, and notes.",
    Other: "General call summary and sentiment.",
  };

  const user =
    `Call Type: ${typeLabel}\n\nTranscript:\n${transcript}\n\nReturn strict JSON.` +
    "Do not output explanations.";

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: basePrompts[typeLabel] + "\n" + user }],
    }),
  });

  const j = await r.json();
  try {
    return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
  } catch {
    return {};
  }
}

// ---- HubSpot patch ----
async function updateHubSpotCall(callId, properties) {
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${callId}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) throw new Error(`HubSpot update failed: ${r.status} ${await r.text()}`);
}

// =============================================================
// ---- MAIN ENDPOINT ----
// =============================================================

app.post("/process-call", async (req, res) => {
  try {
    const props = req.body?.properties || {};
    const callId = props.hs_object_id?.value || props.hs_object_id || req.body.objectId;
    const recordingUrl = props.hs_call_recording_url?.value || props.hs_call_recording_url;
    if (!recordingUrl || !callId) return res.status(400).send("Missing recordingUrl or callId");

    console.log("resolved recordingUrl:", recordingUrl);
    console.log("resolved callId:", callId);

    // Background process
    setImmediate(async () => {
      try {
        const filePath = await downloadRecording(recordingUrl, callId);
        const transcript = await transcribeAudio(filePath);
        const typeLabel = await resolveCallTypeWithGrace(callId, transcript);
        const analysis = await analyseCall(typeLabel, transcript);

        // Merge common fields + specific ones
        const updates = {
          ai_objections_bullets: (analysis.objections || []).join(" • "),
          ai_primary_objection: analysis.primary_objection || "",
          ai_objection_severity: analysis.objection_severity || "",
        };

        // Example per-type handling
        if (typeLabel === "Qualification call" && analysis.metrics) {
          // push to scorecard example fields
          await updateHubSpotCall(callId, updates);
          // future: create Sales Scorecard record with metrics
        } else {
          await updateHubSpotCall(callId, updates);
        }

        console.log(`✅ [bg] Done ${callId}`);
      } catch (err) {
        console.error(`❗ [bg] Error ${err}`);
      }
    });

    res.status(200).send("Processing");
  } catch (err) {
    console.error("Error in /process-call:", err);
    res.status(500).send("Internal error");
  }
});

// ---- start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
