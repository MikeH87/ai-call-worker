// =============================================================
// TLPI – AI Call Worker  (v2.1)  [fix: fetchWithRetry res undefined]
// =============================================================

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import FormData from "form-data";

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || process.env.ZOOM_ACCESS_TOKEN; // optional

const app = express();
app.use(express.json({ limit: "50mb" }));

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts = {}, retries = 3) {
  let lastResp = null;
  for (let i = 0; i < retries; i++) {
    const resp = await fetch(url, opts);
    if (resp.ok) return resp;
    lastResp = resp;
    console.warn(`[retry] attempt ${i + 1}/${retries} — waiting`);
    await sleep(Math.pow(2, i) * 700);
  }
  const body = lastResp ? await lastResp.text() : "no response";
  const status = lastResp ? lastResp.status : "N/A";
  throw new Error(`HTTP ${status} ${body}`);
}

function authHeadersFor(url) {
  const headers = {};
  // HubSpot protected URLs
  if (/\.hubspot\.com/i.test(url) && HUBSPOT_TOKEN) {
    headers.Authorization = `Bearer ${HUBSPOT_TOKEN}`;
  }
  // Zoom protected URLs (if you have a token)
  if (/\.zoom\.us/i.test(url) && ZOOM_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${ZOOM_BEARER_TOKEN}`;
  }
  return headers;
}

// -------------------------------------------------------------
// Download & Transcribe
// -------------------------------------------------------------
async function downloadRecording(recordingUrl, callId) {
  console.log(`[bg] Downloading recording: ${recordingUrl}`);
  const r = await fetchWithRetry(recordingUrl, { headers: authHeadersFor(recordingUrl) }, 3);
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = ".mp3"; // Whisper accepts many formats; keep it simple
  const filePath = path.join("/tmp", `${callId}${ext}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

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
  if (!r.ok) throw new Error(`OpenAI transcription failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.text || "";
}

// -------------------------------------------------------------
// Call type inference with grace
// -------------------------------------------------------------
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
    `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}?${params}`,
    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
  );
  if (!r.ok) return {};
  const j = await r.json();
  return j?.properties || {};
}

async function classifyCallTypeFromTranscript(transcript) {
  const system =
    "Classify the following call into ONE label. Return ONLY JSON {\"label\":\"<one>\",\"confidence\":<0-100>}.\n" +
    "Valid labels: " + CALL_TYPE_LABELS.join(", ");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: transcript }],
    }),
  });
  const j = await r.json();
  try {
    const o = JSON.parse(j?.choices?.[0]?.message?.content || "{}");
    const label = CALL_TYPE_LABELS.includes(o.label) ? o.label : "Other";
    const confidence = Math.max(0, Math.min(100, Number(o.confidence || 0)));
    return { typeLabel: label, confidence };
  } catch {
    return { typeLabel: "Other", confidence: 0 };
  }
}

async function resolveCallTypeWithGrace(callId, transcript, graceMs = 120000) {
  const first = await fetchCallProps(callId, ["hs_activity_type"]);
  if (first?.hs_activity_type) {
    console.log(`[type] using hs_activity_type immediately: ${first.hs_activity_type}`);
    return first.hs_activity_type;
  }

  console.log(`[type] hs_activity_type blank — waiting ${graceMs / 1000}s`);
  await sleep(graceMs);

  const second = await fetchCallProps(callId, ["hs_activity_type"]);
  if (second?.hs_activity_type) {
    console.log(`[type] rep filled hs_activity_type during grace: ${second.hs_activity_type}`);
    return second.hs_activity_type;
  }

  console.log("[type] inferring type from transcript...");
  const { typeLabel, confidence } = await classifyCallTypeFromTranscript(transcript);
  console.log(`[type] inferred=${typeLabel} confidence=${confidence}`);

  // write AI fields
  await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        ai_inferred_call_type: typeLabel,
        ai_call_type_confidence: String(confidence),
      },
    }),
  });

  // optional: promote to built-in if confident
  if (confidence >= 75) {
    console.log("[type] high confidence — setting hs_activity_type");
    await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { hs_activity_type: typeLabel } }),
    });
  }

  return typeLabel;
}

// -------------------------------------------------------------
// Analysis (skeleton – produces JSON; we’ll expand per type later)
// -------------------------------------------------------------
async function analyseCall(typeLabel, transcript) {
  const system = "You are TLPI’s call analysis bot. Output JSON only.";
  const brief = {
    "Qualification call":
      "Analyse discovery performance, objections, short suggestions.",
    "Initial Consultation":
      "Analyse consultation delivery, product interest, application data when present, objections.",
    "Follow up call":
      "Analyse follow-up status, remaining objections, likelihood to close, next steps.",
    "Application meeting":
      "List key data captured, missing information, and next steps.",
    "Strategy call":
      "Summarise strategy focus areas, recommendations, and engagement level.",
    "Annual Review":
      "Summarise satisfaction, achievements, and improvement areas.",
    "Existing customer call":
      "Detect sentiment, complaints, escalation need, and notes.",
    Other:
      "Generic summary and objections.",
  }[typeLabel] || "Generic summary and objections.";

  const user =
    `Call Type: ${typeLabel}\n\nTranscript:\n${transcript}\n\n` +
    `Return JSON with keys where applicable:
{
  "likelihood_score": <1..10>,
  "score_reasoning": ["...","...","..."],
  "increase_sale_suggestions": ["...","...","..."],
  "product_interest": ["SSAS","FIC","Both"],
  "application_data_points": ["..."],
  "missing_information": ["..."],
  "objections": {
    "bullets": ["..."],
    "categories": ["Price","Timing","Risk","Complexity","Authority","Fit","Clarity"],
    "primary": "<short>",
    "severity": "low|medium|high"
  }
}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: `${brief}\n\n${user}` }],
    }),
  });
  const j = await r.json();
  try {
    return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
  } catch {
    return {};
  }
}

// -------------------------------------------------------------
// HubSpot updates
// -------------------------------------------------------------
async function updateHubSpotCall(callId, properties) {
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) throw new Error(`HubSpot update failed: ${r.status} ${await r.text()}`);
}

// -------------------------------------------------------------
// Endpoint
// -------------------------------------------------------------
app.post("/process-call", async (req, res) => {
  try {
    const body = req.body || {};
    const props = body.properties || {};
    const callId = props.hs_object_id?.value || props.hs_object_id || body.objectId;
    const recordingUrl = props.hs_call_recording_url?.value || props.hs_call_recording_url;

    if (!callId || !recordingUrl) {
      return res.status(400).send("Missing recordingUrl or callId");
    }

    console.log("resolved recordingUrl:", recordingUrl);
    console.log("resolved callId:", callId);

    // respond fast
    res.status(200).send("Processing");

    // background work
    setImmediate(async () => {
      try {
        const filePath = await downloadRecording(recordingUrl, callId);
        const transcript = await transcribeAudio(filePath);

        const effectiveType = await resolveCallTypeWithGrace(callId, transcript, 120000);
        console.log("[type] effectiveType:", effectiveType);

        const analysis = await analyseCall(effectiveType, transcript);

        // Map common objection fields (defensive defaults)
        const objections = analysis.objections || {};
        const updates = {
          ai_objections_bullets: (objections.bullets || []).join(" • "),
          ai_objection_categories: (objections.categories || [])[0] || undefined, // HS accepts multi-select as comma/array via API; we keep single for now
          ai_primary_objection: objections.primary || "",
          ai_objection_severity: objections.severity || "",
        };

        // Initial Consultation extras (example)
        if (effectiveType === "Initial Consultation") {
          if (Array.isArray(analysis.product_interest) && analysis.product_interest.length) {
            // You configured this as a dropdown; if Both appears, set "Both", else SSAS or FIC if single.
            const v = analysis.product_interest.includes("Both")
              ? "Both"
              : analysis.product_interest[0];
            updates.ai_product_interest = v || "";
          }
          if (Array.isArray(analysis.application_data_points) && analysis.application_data_points.length) {
            updates.ai_application_data_points_captured = analysis.application_data_points.join(" • ");
          }
          if (Array.isArray(analysis.missing_information) && analysis.missing_information.length) {
            updates.ai_application_missing_information = analysis.missing_information.join(" • ");
          }
        }

        await updateHubSpotCall(callId, updates);

        console.log(`✅ [bg] Done ${callId}`);
      } catch (e) {
        console.error("❗ [bg] Error", e);
      }
    });
  } catch (err) {
    console.error("Error in /process-call:", err);
    res.status(500).send("Internal error");
  }
});

// -------------------------------------------------------------
// Start
// -------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
