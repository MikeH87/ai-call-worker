// =============================================================
// TLPI – AI Call Worker (v3.3)
// - Always create Sales Scorecards; associate to CALL only
//   (Contact/Deal associations are skipped entirely so they cannot
//    block creation; we log that we skipped them).
// - IC fields: ai_data_points_captured / ai_missing_information
// - Scorecards for Qualification / Initial Consultation / Follow up
// - Strong call-type rules (Zoom vs phone; data capture vs DocuSign)
// - Robust HubSpot updater (prunes unknown props; retry; continue)
// - Whisper compression/chunking; grace for hs_activity_type
// =============================================================

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import FormData from "form-data";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

// ---- ENV ----
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN    = process.env.HUBSPOT_TOKEN;
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || process.env.ZOOM_ACCESS_TOKEN;
const GRACE_MS = Number(process.env.GRACE_MS ?? 0); // 0 during testing
const SCORECARD_BY_METRICS = String(process.env.SCORECARD_BY_METRICS ?? "true").toLowerCase() === "true";

// IC field keys in your portal
const IC_DATA_POINTS_KEY = "ai_data_points_captured";
const IC_MISSING_INFO_KEY = "ai_missing_information";

// ---- Constants ----
const MAX_WHISPER_BYTES = 25 * 1024 * 1024; // Whisper limit
const TMP_DIR = os.tmpdir();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: "50mb" }));

// -------------------------------------------------------------
// Utils
// -------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileSizeBytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const tmpPath = (name) => path.join(TMP_DIR, name);

async function fetchWithRetry(url, opts = {}, retries = 3) {
  let last = null;
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    last = r;
    console.warn(`[retry] attempt ${i + 1}/${retries}`);
    await sleep(400 * (i + 1));
  }
  const body = last ? await last.text() : "no response";
  throw new Error(`HTTP ${last?.status || "N/A"} ${body}`);
}

function authHeadersFor(url) {
  const headers = {};
  if (/\.hubspot\.com/i.test(url) && HUBSPOT_TOKEN) headers.Authorization = `Bearer ${HUBSPOT_TOKEN}`;
  if (/\.zoom\.us/i.test(url) && ZOOM_BEARER_TOKEN) headers.Authorization = `Bearer ${ZOOM_BEARER_TOKEN}`;
  return headers;
}

const isZoomUrl = (u) => /\.zoom\.us\//i.test(String(u || ""));

// -------------------------------------------------------------
// Download & Prepare Audio (compress + chunk if needed)
// -------------------------------------------------------------
async function downloadRecording(recordingUrl, callId) {
  console.log(`[bg] Downloading recording: ${recordingUrl}`);
  const r = await fetchWithRetry(recordingUrl, { headers: authHeadersFor(recordingUrl) }, 3);
  const buf = Buffer.from(await r.arrayBuffer());
  const srcPath = tmpPath(`${callId}_src`);
  fs.writeFileSync(srcPath, buf);
  return srcPath;
}

function transcodeToSpeechMp3(inPath, outPath) {
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

function segmentAudio(inPath, outPattern, seconds = 600) {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions(["-f", "segment", "-segment_time", String(seconds), "-reset_timestamps", "1"])
      .output(outPattern)
      .on("error", reject)
      .on("end", () => {
        const dir = path.dirname(outPattern);
        const base = path.basename(outPattern).replace("%03d", "");
        const all = fs.readdirSync(dir).filter(f => f.startsWith(base)).map(f => path.join(dir, f)).sort();
        resolve(all);
      })
      .run();
  });
}

async function ensureWhisperFriendlyAudio(srcPath, callId) {
  const firstMp3 = tmpPath(`${callId}.mp3`);
  await transcodeToSpeechMp3(srcPath, firstMp3);
  const size = fileSizeBytes(firstMp3);
  if (size <= MAX_WHISPER_BYTES) return { mode: "single", files: [firstMp3] };
  console.log(`[prep] compressed file too large (${(size/1048576).toFixed(1)} MB). Segmenting…`);
  const pattern = tmpPath(`${callId}_part_%03d.mp3`);
  const parts = await segmentAudio(firstMp3, pattern, 600);
  return { mode: "multi", files: parts };
}

// -------------------------------------------------------------
// Transcription
// -------------------------------------------------------------
async function transcribeFileWithOpenAI(filePath) {
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

async function transcribeAudioSmart(srcPath, callId) {
  console.log("[bg] Preparing audio for Whisper…");
  const prep = await ensureWhisperFriendlyAudio(srcPath, callId);
  if (prep.mode === "single") {
    console.log("[bg] Transcribing single compressed file…");
    return await transcribeFileWithOpenAI(prep.files[0]);
  }
  console.log(`[bg] Transcribing ${prep.files.length} chunks…`);
  const pieces = [];
  for (let i = 0; i < prep.files.length; i++) {
    console.log(`[bg] Chunk ${i + 1}/${prep.files.length}`);
    pieces.push(await transcribeFileWithOpenAI(prep.files[i]));
  }
  return pieces.join("\n");
}

// -------------------------------------------------------------
// Heuristics for call type (assist the model)
// -------------------------------------------------------------
function heuristicType(recordingUrl, transcript) {
  const t = (transcript || "").toLowerCase();
  const zoom = isZoomUrl(recordingUrl);

  const docusign    = /docusign|sign(ing)? (the )?(application|forms?)|envelope/i.test(t);
  const dataCapture = /(date of birth|dob|national insurance|ni number|address|postcode|company (reg|registration)|utr|tax reference|bank details|sort code|account number)/i.test(t);
  const walkthrough = /(features|benefits|compare|ssas|fic|small self administered|family investment company|pension|property purchase|how it works)/i.test(t);
  const followUp    = /(following up|as discussed last time|had (a )?chance to review|remaining questions|what'?s stopping you|close plan|next steps from last time)/i.test(t);

  if (!zoom) {
    return { hint: "Qualification call", reason: "phone only rule; not Zoom" };
  } else {
    if (docusign && !dataCapture) return { hint: "Application meeting", reason: "DocuSign signing only" };
    if (followUp) return { hint: "Follow up call", reason: "follow-up cues on Zoom" };
    if (dataCapture || walkthrough) return { hint: "Initial Consultation", reason: "data capture and/or walkthrough on Zoom" };
    return { hint: "Initial Consultation", reason: "Zoom default (weak)" };
  }
}

// -------------------------------------------------------------
// Call type inference with grace + heuristic reconcile
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

async function classifyCallTypeFromTranscript(transcript, recordingUrl) {
  const rules =
`Classify HubSpot calls using STRICT definitions:

- Qualification call: PHONE ONLY. Discover interest/eligibility and book a Zoom consultation. Never a Zoom recording. No structured product walkthrough.
- Initial Consultation: ZOOM ONLY. Explain SSAS/FIC/Both, answer questions, ask to proceed. MAY include capturing personal details (DOB, NI, address, etc.) → fill "application_data_points"/"missing_information".
- Follow up call: ZOOM. After the initial consultation. Address remaining objections, confirm materials were reviewed, attempt to close.
- Application meeting: ZOOM ONLY. Sole purpose is completing DocuSign signing of the full pension application. Data was collected earlier; do NOT capture new personal details here.
- Strategy / Annual Review / Existing customer / Other: as usual.

Disambiguation:
- Non-Zoom recording ⇒ NOT Initial Consultation/Application (likely Qualification).
- DocuSign signing without data capture ⇒ Application meeting.
- Personal data capture on Zoom ⇒ Initial Consultation (not Application).
- Follow-up cues (“as discussed last time”, “had a chance to review”, “remaining questions”, “close plan”) ⇒ Follow up call.

Return ONLY JSON: {"label":"<one>","confidence":<0-100>}.`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: rules },
        { role: "user", content: `Recording URL: ${recordingUrl}\n\nTranscript:\n${transcript}` },
      ],
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

async function resolveCallTypeWithGrace(callId, transcript, recordingUrl, graceMs = GRACE_MS) {
  const first = await fetchCallProps(callId, ["hs_activity_type"]);
  if (first?.hs_activity_type) {
    console.log(`[type] using hs_activity_type immediately: ${first.hs_activity_type}`);
    return first.hs_activity_type;
  }

  if (graceMs > 0) {
    console.log(`[type] hs_activity_type blank — waiting ${graceMs / 1000}s`);
    await sleep(graceMs);
    const second = await fetchCallProps(callId, ["hs_activity_type"]);
    if (second?.hs_activity_type) {
      console.log(`[type] rep filled hs_activity_type during grace: ${second.hs_activity_type}`);
      return second.hs_activity_type;
    }
  } else {
    console.log("[type] grace wait disabled for testing");
  }

  const hint = heuristicType(recordingUrl, transcript);
  if (hint.hint) console.log(`[type] heuristic hint: ${hint.hint} (${hint.reason})`);

  console.log("[type] inferring type from transcript…");
  const { typeLabel, confidence } = await classifyCallTypeFromTranscript(transcript, recordingUrl);
  console.log(`[type] inferred=${typeLabel} confidence=${confidence}`);

  const MAIN = new Set(["Qualification call","Initial Consultation","Follow up call","Application meeting"]);
  let finalLabel = typeLabel;

  if (!isZoomUrl(recordingUrl) && (typeLabel === "Initial Consultation" || typeLabel === "Application meeting")) {
    finalLabel = "Qualification call";
    console.log(`[type] override: not Zoom recording ⇒ forcing Qualification call`);
  } else if (confidence < 85 && hint.hint && MAIN.has(hint.hint)) {
    finalLabel = hint.hint;
    console.log(`[type] overriding to heuristic due to low confidence: ${finalLabel}`);
  }

  // Write AI fields
  await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        ai_inferred_call_type: finalLabel,
        ai_call_type_confidence: String(confidence),
      },
    }),
  });

  if (confidence >= 75) {
    console.log("[type] high confidence — setting hs_activity_type");
    await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { hs_activity_type: finalLabel } }),
    });
  }

  return finalLabel;
}

// -------------------------------------------------------------
// Analysis (+ MUST-return metric blocks; second-pass ensure)
// -------------------------------------------------------------
async function analyseCall(typeLabel, transcript) {
  const system = "You are TLPI’s call analysis bot. Output JSON only.";
  const base =
`Call Type: ${typeLabel}

Transcript:
${transcript}

Return JSON with these keys where applicable:
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
}
`;

  const qualAsk = `
If Call Type is "Qualification call", you MUST include:
{
  "qual_metrics": {
    "q1_need_clearly_stated": 0|0.5|1,
    "q2_budget_discussed": 0|0.5|1,
    "q3_decision_maker_present": 0|0.5|1,
    "q4_authority_confirmed": 0|0.5|1,
    "q5_timeline_identified": 0|0.5|1,
    "q6_pain_depth_understood": 0|0.5|1,
    "q7_current_solution_understood": 0|0.5|1,
    "q8_competition_identified": 0|0.5|1,
    "q9_next_step_clearly_agreed": 0|0.5|1,
    "q10_fit_assessed": 0|0.5|1
  },
  "qual_score_final": <integer 1..10>
}
`;

  const consultAsk = `
If Call Type is "Initial Consultation", you MUST include:
{
  "consult_metrics": {
    "c1_goal_alignment": 0|0.5|1,
    "c2_current_state_captured": 0|0.5|1,
    "c3_risk_tolerance_explored": 0|0.5|1,
    "c4_tax_context_understood": 0|0.5|1,
    "c5_pension_context_understood": 0|0.5|1,
    "c6_cashflow_model_discussed": 0|0.5|1,
    "c7_ssas_fic_fit_discussed": 0|0.5|1,
    "c8_fees_explained": 0|0.5|1,
    "c9_regulatory_disclosures_made": 0|0.5|1,
    "c10_key_risks_explained": 0|0.5|1,
    "c11_questions_addressed": 0|0.5|1,
    "c12_next_steps_agreed": 0|0.5|1,
    "c13_materials_promised": 0|0.5|1,
    "c14_decision_criteria_logged": 0|0.5|1,
    "c15_objections_summarised": 0|0.5|1,
    "c16_stakeholders_identified": 0|0.5|1,
    "c17_urgency_established": 0|0.5|1,
    "c18_buyer_journey_stage": 0|0.5|1,
    "c19_application_readiness": 0|0.5|1,
    "c20_close_plan_started": 0|0.5|1
  },
  "consult_score_final": <integer 1..10>
}
`;

  const followupAsk = `
If Call Type is "Follow up call", you MUST include:
{
  "followup_metrics": {
    "f1_recap_clear": 0|0.5|1,
    "f2_objections_addressed": 0|0.5|1,
    "f3_materials_reviewed": 0|0.5|1,
    "f4_new_info_collected": 0|0.5|1,
    "f5_decision_progressed": 0|0.5|1,
    "f6_relationship_strengthened": 0|0.5|1,
    "f7_next_steps_agreed": 0|0.5|1,
    "f8_close_likelihood_discussed": 0|0.5|1,
    "f9_timeframe_reconfirmed": 0|0.5|1,
    "f10_overall_call_effectiveness": 0|0.5|1
  },
  "followup_score_final": <integer 1..10>
}
`;

  const existingAsk = `
If Call Type is "Existing customer call", include:
{
  "customer_sentiment": "positive|neutral|negative",
  "complaint_detected": "yes|no|unclear",
  "escalation_required": "yes|no|monitor",
  "escalation_notes": "<short text>"
}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: base + qualAsk + consultAsk + followupAsk + existingAsk }
      ],
    }),
  });

  const j = await r.json();
  try { return JSON.parse(j?.choices?.[0]?.message?.content || "{}"); }
  catch { return {}; }
}

// Ensure metrics exist for IC/Follow-up (second pass if needed)
async function ensureMetricsIfNeeded(typeLabel, transcript, analysis) {
  if (typeLabel !== "Initial Consultation" && typeLabel !== "Follow up call") return analysis;
  const missingIC = typeLabel === "Initial Consultation" && !analysis.consult_metrics;
  const missingFU = typeLabel === "Follow up call" && !analysis.followup_metrics;
  if (!missingIC && !missingFU) return analysis;

  const ask = typeLabel === "Initial Consultation"
    ? `From the transcript, return ONLY JSON with:
{"consult_metrics": {"c1_goal_alignment":0|0.5|1,"c2_current_state_captured":0|0.5|1,"c3_risk_tolerance_explored":0|0.5|1,"c4_tax_context_understood":0|0.5|1,"c5_pension_context_understood":0|0.5|1,"c6_cashflow_model_discussed":0|0.5|1,"c7_ssas_fic_fit_discussed":0|0.5|1,"c8_fees_explained":0|0.5|1,"c9_regulatory_disclosures_made":0|0.5|1,"c10_key_risks_explained":0|0.5|1,"c11_questions_addressed":0|0.5|1,"c12_next_steps_agreed":0|0.5|1,"c13_materials_promised":0|0.5|1,"c14_decision_criteria_logged":0|0.5|1,"c15_objections_summarised":0|0.5|1,"c16_stakeholders_identified":0|0.5|1,"c17_urgency_established":0|0.5|1,"c18_buyer_journey_stage":0|0.5|1,"c19_application_readiness":0|0.5|1,"c20_close_plan_started":0|0.5|1},"consult_score_final":1..10}`
    : `From the transcript, return ONLY JSON with:
{"followup_metrics": {"f1_recap_clear":0|0.5|1,"f2_objections_addressed":0|0.5|1,"f3_materials_reviewed":0|0.5|1,"f4_new_info_collected":0|0.5|1,"f5_decision_progressed":0|0.5|1,"f6_relationship_strengthened":0|0.5|1,"f7_next_steps_agreed":0|0.5|1,"f8_close_likelihood_discussed":0|0.5|1,"f9_timeframe_reconfirmed":0|0.5|1,"f10_overall_call_effectiveness":0|0.5|1},"followup_score_final":1..10}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return ONLY valid JSON for the requested keys." },
        { role: "user", content: `Transcript:\n${transcript}\n\n${ask}` },
      ],
    }),
  });
  const j = await r.json();
  let add = {};
  try { add = JSON.parse(j?.choices?.[0]?.message?.content || "{}"); } catch {}
  return { ...analysis, ...add };
}

// -------------------------------------------------------------
// Normalisers
// -------------------------------------------------------------
const normaliseSeverity = (v) => {
  const s = String(v || "").trim().toLowerCase();
  if (s === "low") return "Low";
  if (s === "medium") return "Medium";
  if (s === "high") return "High";
  return "";
};
const normaliseSentiment = (v) => {
  const s = String(v || "").trim().toLowerCase();
  if (s === "positive") return "Positive";
  if (s === "neutral") return "Neutral";
  if (s === "negative") return "Negative";
  return "";
};
const normaliseYesNoUnclear = (v) => {
  const s = String(v || "").trim().toLowerCase();
  if (s === "yes") return "Yes";
  if (s === "no") return "No";
  if (s === "unclear") return "Unclear";
  return "";
};
const normaliseEscalation = (v) => {
  const s = String(v || "").trim().toLowerCase();
  if (s === "yes") return "Yes";
  if (s === "no") return "No";
  if (s === "monitor") return "Monitor";
  return "";
};

// -------------------------------------------------------------
// HubSpot helpers
// -------------------------------------------------------------
// Safe updater: prune unknown props; retry once; if still unknowns, log and continue
async function updateHubSpotCall(callId, properties) {
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`;

  async function patch(props) {
    return fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
  }

  let r = await patch(properties);
  if (r.ok) return;

  const text1 = await r.text();

  if (r.status === 400 && text1.includes("PROPERTY_DOESNT_EXIST")) {
    const bad = Array.from(text1.matchAll(/"name":"([^"]+)"/g)).map(m => m[1]);
    if (bad.length) {
      console.warn(`[retry] removing unknown properties and retrying once: ${bad.join(", ")}`);
      for (const b of bad) delete properties[b];
      const r2 = await patch(properties);
      if (r2.ok) return;

      const text2 = await r2.text();
      if (r2.status === 400 && text2.includes("PROPERTY_DOESNT_EXIST")) {
        console.warn(`[skip] still unknown after prune; continuing. Response: ${text2}`);
        return;
      }
      throw new Error(`HubSpot update failed after retry: ${r2.status} ${text2}`);
    }
  }

  throw new Error(`HubSpot update failed: ${r.status} ${text1}`);
}

// Association helpers — fetch typeId + category for Scorecard→Call
const assocCache = new Map(); // key: `${from}::${to}` -> { typeId, category }

async function findAssocType(from, to) {
  const key = `${from}::${to}`;
  if (assocCache.has(key)) return assocCache.get(key);

  const headers = { Authorization: `Bearer ${HUBSPOT_TOKEN}` };

  // Prefer /labels (often includes custom labels)
  let r = await fetch(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels`, { headers });
  if (r.ok) {
    const j = await r.json();
    const first = j?.results?.[0];
    if (first?.typeId && first?.category) {
      const val = { typeId: first.typeId, category: first.category };
      assocCache.set(key, val);
      return val;
    }
  }

  // Fallback to /types
  r = await fetch(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/types`, { headers });
  if (r.ok) {
    const j = await r.json();
    const first = j?.results?.[0];
    if (first?.typeId && first?.category) {
      const val = { typeId: first.typeId, category: first.category };
      assocCache.set(key, val);
      return val;
    }
  }

  return null; // not found
}

const SCORECARD_TYPE = "p49487487_sales_scorecards";

// Create a scorecard associated ONLY to the Call (never fail because of contact/deal)
async function createSalesScorecardCallFirst(fields, { callId } = {}) {
  const body = { properties: fields };
  const assocBlocks = [];

  if (callId) {
    const t = await findAssocType(SCORECARD_TYPE, "calls");
    if (t) {
      assocBlocks.push({
        to: { id: String(callId) },
        types: [{ associationCategory: t.category, associationTypeId: t.typeId }],
      });
    } else {
      console.warn(`[assoc] no scorecard→call association type; creating scorecard without call link`);
    }
  }

  if (assocBlocks.length) body.associations = assocBlocks;

  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(SCORECARD_TYPE)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`scorecard create failed: ${r.status} ${await r.text()}`);
  const j = await r.json();

  // Intentionally skip Contact/Deal attachments here so they can NEVER block creation.
  console.log(`[assoc] skipped optional Contact/Deal associations by design`);

  return j?.id;
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

    if (!callId || !recordingUrl) return res.status(400).send("Missing recordingUrl or callId");
    console.log("resolved recordingUrl:", recordingUrl);
    console.log("resolved callId:", callId);

    res.status(200).send("Processing"); // respond fast

    setImmediate(async () => {
      try {
        // 1) Audio -> Transcript
        const srcPath = await downloadRecording(recordingUrl, callId);
        const transcript = await transcribeAudioSmart(srcPath, callId);

        // 2) Call type (with grace + heuristic reconcile)
        const effectiveType = await resolveCallTypeWithGrace(callId, transcript, recordingUrl, GRACE_MS);
        console.log("[type] effectiveType:", effectiveType);

        // 3) Analysis (+ ensure metrics if missing)
        let analysis = await analyseCall(effectiveType, transcript);
        analysis = await ensureMetricsIfNeeded(effectiveType, transcript, analysis);

        // 4) Call-level updates (common + type-specific)
        const objections = analysis.objections || {};
        const updates = {
          ai_objections_bullets: (objections.bullets || []).join(" • "),
          ai_primary_objection: objections.primary || "",
          ai_objection_severity: normaliseSeverity(objections.severity),
        };

        // Existing customer call → your portal field names
        if (effectiveType === "Existing customer call") {
          updates.ai_customer_sentiment  = normaliseSentiment(analysis.customer_sentiment);
          updates.ai_complaint_detected  = normaliseYesNoUnclear(analysis.complaint_detected);
          updates.ai_escalation_required = normaliseEscalation(analysis.escalation_required);
          updates.ai_escalation_notes    = analysis.escalation_notes || "";
        }

        // Initial Consultation → capture data points & missing info using your keys
        if (effectiveType === "Initial Consultation") {
          if (Array.isArray(analysis.product_interest) && analysis.product_interest.length) {
            const v = analysis.product_interest.includes("Both") ? "Both" : analysis.product_interest[0];
            updates.ai_product_interest = v || "";
          }
          if (Array.isArray(analysis.application_data_points) && analysis.application_data_points.length) {
            updates[IC_DATA_POINTS_KEY] = analysis.application_data_points.join(" • ");
          }
          if (Array.isArray(analysis.missing_information) && analysis.missing_information.length) {
            updates[IC_MISSING_INFO_KEY] = analysis.missing_information.join(" • ");
          }
        }

        await updateHubSpotCall(callId, updates);

        // 5) Scorecards — only for the three call types (metrics fallback if enabled)
        const createQual    = (effectiveType === "Qualification call")    || (SCORECARD_BY_METRICS && analysis.qual_metrics);
        const createConsult = (effectiveType === "Initial Consultation")  || (SCORECARD_BY_METRICS && analysis.consult_metrics);
        const createFollow  = (effectiveType === "Follow up call")        || (SCORECARD_BY_METRICS && analysis.followup_metrics);

        // Single scorecard per call — priority: Qualification > Consultation > Follow up
        if (createQual && analysis.qual_metrics) {
          const m = analysis.qual_metrics || {};
          const fields = {
            qual_metrics_q1_need_clearly_stated:              String(m.q1_need_clearly_stated ?? 0),
            qual_metrics_q2_budget_discussed:                  String(m.q2_budget_discussed ?? 0),
            qual_metrics_q3_decision_maker_present:            String(m.q3_decision_maker_present ?? 0),
            qual_metrics_q4_authority_confirmed:               String(m.q4_authority_confirmed ?? 0),
            qual_metrics_q5_timeline_identified:               String(m.q5_timeline_identified ?? 0),
            qual_metrics_q6_pain_depth_understood:             String(m.q6_pain_depth_understood ?? 0),
            qual_metrics_q7_current_solution_understood:       String(m.q7_current_solution_understood ?? 0),
            qual_metrics_q8_competition_identified:            String(m.q8_competition_identified ?? 0),
            qual_metrics_q9_next_step_clearly_agreed:          String(m.q9_next_step_clearly_agreed ?? 0),
            qual_metrics_q10_fit_assessed:                     String(m.q10_fit_assessed ?? 0),
            qual_score_final:                                  String(analysis.qual_score_final ?? 0)
          };
          try {
            const id = await createSalesScorecardCallFirst(fields, { callId });
            console.log(`[scorecard] created ${id} for Qualification call (call ${callId})`);
          } catch (e) {
            console.error(`[scorecard] creation failed (Qualification) but continuing: ${e.message}`);
          }
        } else if (createConsult && analysis.consult_metrics) {
          const c = analysis.consult_metrics || {};
          const fields = {
            consult_metrics_c1_goal_alignment:              String(c.c1_goal_alignment ?? 0),
            consult_metrics_c2_current_state_captured:      String(c.c2_current_state_captured ?? 0),
            consult_metrics_c3_risk_tolerance_explored:     String(c.c3_risk_tolerance_explored ?? 0),
            consult_metrics_c4_tax_context_understood:      String(c.c4_tax_context_understood ?? 0),
            consult_metrics_c5_pension_context_understood:  String(c.c5_pension_context_understood ?? 0),
            consult_metrics_c6_cashflow_model_discussed:    String(c.c6_cashflow_model_discussed ?? 0),
            consult_metrics_c7_ssas_fic_fit_discussed:      String(c.c7_ssas_fic_fit_discussed ?? 0),
            consult_metrics_c8_fees_explained:              String(c.c8_fees_explained ?? 0),
            consult_metrics_c9_regulatory_disclosures_made: String(c.c9_regulatory_disclosures_made ?? 0),
            consult_metrics_c10_key_risks_explained:        String(c.c10_key_risks_explained ?? 0),
            consult_metrics_c11_questions_addressed:        String(c.c11_questions_addressed ?? 0),
            consult_metrics_c12_next_steps_agreed:          String(c.c12_next_steps_agreed ?? 0),
            consult_metrics_c13_materials_promised:         String(c.c13_materials_promised ?? 0),
            consult_metrics_c14_decision_criteria_logged:   String(c.c14_decision_criteria_logged ?? 0),
            consult_metrics_c15_objections_summarised:      String(c.c15_objections_summarised ?? 0),
            consult_metrics_c16_stakeholders_identified:    String(c.c16_stakeholders_identified ?? 0),
            consult_metrics_c17_urgency_established:        String(c.c17_urgency_established ?? 0),
            consult_metrics_c18_buyer_journey_stage:        String(c.c18_buyer_journey_stage ?? 0),
            consult_metrics_c19_application_readiness:      String(c.c19_application_readiness ?? 0),
            consult_metrics_c20_close_plan_started:         String(c.c20_close_plan_started ?? 0),
            consult_score_final:                             String(analysis.consult_score_final ?? 0)
          };
          try {
            const id = await createSalesScorecardCallFirst(fields, { callId });
            console.log(`[scorecard] created ${id} for Initial Consultation (call ${callId})`);
          } catch (e) {
            console.error(`[scorecard] creation failed (Initial Consultation) but continuing: ${e.message}`);
          }
        } else if (createFollow && analysis.followup_metrics) {
          const f = analysis.followup_metrics || {};
          const fields = {
            followup_metrics_f1_recap_clear:                 String(f.f1_recap_clear ?? 0),
            followup_metrics_f2_objections_addressed:        String(f.f2_objections_addressed ?? 0),
            followup_metrics_f3_materials_reviewed:          String(f.f3_materials_reviewed ?? 0),
            followup_metrics_f4_new_info_collected:          String(f.f4_new_info_collected ?? 0),
            followup_metrics_f5_decision_progressed:         String(f.f5_decision_progressed ?? 0),
            followup_metrics_f6_relationship_strengthened:   String(f.f6_relationship_strengthened ?? 0),
            followup_metrics_f7_next_steps_agreed:           String(f.f7_next_steps_agreed ?? 0),
            followup_metrics_f8_close_likelihood_discussed:  String(f.f8_close_likelihood_discussed ?? 0),
            followup_metrics_f9_timeframe_reconfirmed:       String(f.f9_timeframe_reconfirmed ?? 0),
            followup_metrics_f10_overall_call_effectiveness: String(f.f10_overall_call_effectiveness ?? 0),
            followup_score_final:                             String(analysis.followup_score_final ?? 0)
          };
          try {
            const id = await createSalesScorecardCallFirst(fields, { callId });
            console.log(`[scorecard] created ${id} for Follow up call (call ${callId})`);
          } catch (e) {
            console.error(`[scorecard] creation failed (Follow up) but continuing: ${e.message}`);
          }
        } else {
          console.log(`[scorecard] not created (type=${effectiveType}, metrics present? qual=${!!analysis.qual_metrics}, consult=${!!analysis.consult_metrics}, follow=${!!analysis.followup_metrics})`);
        }

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
