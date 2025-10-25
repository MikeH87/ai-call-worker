// =============================================================
// TLPI – AI Call Worker (v2.7)
// - Scorecards for: Qualification, Initial Consultation, Follow up
// - No scorecards for other call types
// - Existing-customer fields use portal names:
//     ai_customer_sentiment / ai_complaint_detected / ai_escalation_required / ai_escalation_notes
// - Safe retry-on-unknown properties (works even without calls-read)
// - Keeps: compression/chunking, Whisper, type inference (GRACE_MS)
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN  = process.env.HUBSPOT_TOKEN;
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || process.env.ZOOM_ACCESS_TOKEN;
const GRACE_MS = Number(process.env.GRACE_MS ?? 0); // 0 during testing

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
// Call type inference with (configurable) grace
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
    "Classify the call into ONE label. Return ONLY JSON {\"label\":\"<one>\",\"confidence\":<0-100>}.\n" +
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

async function resolveCallTypeWithGrace(callId, transcript, graceMs = GRACE_MS) {
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

  console.log("[type] inferring type from transcript…");
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
// Analysis (adds follow-up metrics)
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
If Call Type is "Qualification call", ALSO include:
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
If Call Type is "Initial Consultation", ALSO include:
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
If Call Type is "Follow up call", ALSO include:
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
If Call Type is "Existing customer call", ALSO include:
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
// Safe updater: try once; on 400 PROPERTY_DOESNT_EXIST, prune and retry.
async function updateHubSpotCall(callId, properties) {
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`;
  let r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (r.ok) return;

  const text = await r.text();
  if (r.status === 400 && text.includes("PROPERTY_DOESNT_EXIST")) {
    const bad = Array.from(text.matchAll(/"name":"([^"]+)"/g)).map(m => m[1]);
    if (bad.length) {
      console.warn(`[retry] removing unknown properties and retrying once: ${bad.join(", ")}`);
      for (const b of bad) delete properties[b];
      r = await fetch(url, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      });
      if (r.ok) return;
    }
  }
  throw new Error(`HubSpot update failed: ${r.status} ${text}`);
}

// association helpers (discover type ids)
const assocCache = new Map(); // key: `${from}::${to}` -> id
async function getAssociationTypeId(from, to) {
  const key = `${from}::${to}`;
  if (assocCache.has(key)) return assocCache.get(key);
  const r = await fetch(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  if (!r.ok) throw new Error(`assoc labels failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const id = j?.results?.[0]?.typeId;
  if (!id) throw new Error(`no association type between ${from} and ${to}`);
  assocCache.set(key, id);
  return id;
}

async function getCallAssociations(callId) {
  const params = new URLSearchParams({ associations: "contacts,deals" });
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}?${params}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  if (!r.ok) return { contacts: [], deals: [] };
  const j = await r.json();
  const assoc = j?.associations || {};
  const contacts = (assoc.contacts?.results || []).map(x => x.id);
  const deals    = (assoc.deals?.results || []).map(x => x.id);
  return { contacts, deals };
}

const SCORECARD_TYPE = "p49487487_sales_scorecards"; // fully qualified name

async function createSalesScorecard(fields, associations = {}) {
  const body = { properties: fields };
  const assocBlocks = [];

  if (associations.callId) {
    const id = await getAssociationTypeId(SCORECARD_TYPE, "calls");
    assocBlocks.push({ to: { id: String(associations.callId) }, types: [{ associationTypeId: id }] });
  }
  for (const cId of (associations.contactIds || [])) {
    const id = await getAssociationTypeId(SCORECARD_TYPE, "contacts");
    assocBlocks.push({ to: { id: String(cId) }, types: [{ associationTypeId: id }] });
  }
  for (const dId of (associations.dealIds || [])) {
    const id = await getAssociationTypeId(SCORECARD_TYPE, "deals");
    assocBlocks.push({ to: { id: String(dId) }, types: [{ associationTypeId: id }] });
  }

  if (assocBlocks.length) body.associations = assocBlocks;

  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(SCORECARD_TYPE)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`scorecard create failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
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

        // 2) Call type (with optional grace)
        const effectiveType = await resolveCallTypeWithGrace(callId, transcript, GRACE_MS);
        console.log("[type] effectiveType:", effectiveType);

        // 3) Analysis
        const analysis = await analyseCall(effectiveType, transcript);

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

        // Initial Consultation → capture application info if present
        if (effectiveType === "Initial Consultation") {
          if (Array.isArray(analysis.product_interest) && analysis.product_interest.length) {
            const v = analysis.product_interest.includes("Both") ? "Both" : analysis.product_interest[0];
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

        // 5) Scorecards — only for the three call types
        const { contacts: contactIds, deals: dealIds } = await getCallAssociations(callId);

        if (effectiveType === "Qualification call" && analysis.qual_metrics) {
          const m = analysis.qual_metrics || {};
          const fields = {
            // qual_metrics group
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
            // rollup
            qual_score_final:                                  String(analysis.qual_score_final ?? 0)
          };
          await createSalesScorecard(fields, { callId, contactIds, dealIds });
        }

        if (effectiveType === "Initial Consultation" && analysis.consult_metrics) {
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
          await createSalesScorecard(fields, { callId, contactIds, dealIds });
        }

        if (effectiveType === "Follow up call" && analysis.followup_metrics) {
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
          await createSalesScorecard(fields, { callId, contactIds, dealIds });
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
