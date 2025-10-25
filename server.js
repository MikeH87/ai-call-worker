// =============================================================
// TLPI – AI Call Worker (v3.8.4)
// - Aligns metric property names to portal schema created by your bootstrap script
// - Parallel Whisper + iterative scorecard prune (from 3.8.3)
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
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN       = process.env.HUBSPOT_TOKEN;
const ZOOM_BEARER_TOKEN   = process.env.ZOOM_BEARER_TOKEN || process.env.ZOOM_ACCESS_TOKEN;
const GRACE_MS            = Number(process.env.GRACE_MS ?? 0);
const SCORECARD_BY_METRICS= String(process.env.SCORECARD_BY_METRICS ?? "true").toLowerCase() === "true";

// Performance tuning
const ALWAYS_SEGMENT         = String(process.env.ALWAYS_SEGMENT ?? "false").toLowerCase() === "true";
const FORCE_SEGMENT_SIZE_MB  = Number(process.env.FORCE_SEGMENT_SIZE_MB ?? 25);
const SEGMENT_SECONDS        = Number(process.env.SEGMENT_SECONDS ?? 600);
const TRANSCRIBE_CONCURRENCY = Math.max(1, Number(process.env.TRANSCRIBE_CONCURRENCY ?? 3));
const WHISPER_TIMEOUT_MS     = Number(process.env.WHISPER_TIMEOUT_MS ?? 300000);
const WHISPER_MAX_RETRIES    = Number(process.env.WHISPER_MAX_RETRIES ?? 2);

// ---- Call property keys ----
const IC_DATA_POINTS_KEY   = "ai_data_points_captured";
const IC_MISSING_INFO_KEY  = "ai_missing_information";

// ---- Sales Scorecard keys ----
const SCORECARD_TYPE           = "p49487487_sales_scorecards";
const SCORECARD_NAME_KEY       = "activity_name"; // optional: will be pruned if not present
const SCORECARD_TYPE_KEY       = "activity_type";
const SCORECARD_RATING_KEY     = "sales_performance_rating_";
const SCORECARD_SUMMARY_KEY    = "sales_scorecard___what_you_can_improve_on";

// ---- Constants ----
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
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
const isZoomUrl = (u) => /\.zoom\.us\//i.test(String(u || ""));
const nowIso = () => new Date().toISOString();

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

function ymd(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// -------------------------------------------------------------
// Download & Prepare Audio
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

function segmentAudio(inPath, outPattern, seconds = SEGMENT_SECONDS) {
  const dir = path.dirname(outPattern);
  const prefix = path.basename(outPattern).split("%")[0];
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions(["-f", "segment", "-segment_time", String(seconds), "-reset_timestamps", "1"])
      .output(outPattern)
      .on("error", reject)
      .on("end", () => {
        const files = fs.readdirSync(dir)
          .filter((f) => f.startsWith(prefix))
          .map((f) => path.join(dir, f))
          .sort();
        resolve(files);
      })
      .run();
  });
}

async function ensureWhisperFriendlyAudio(srcPath, callId) {
  const mp3Path = tmpPath(`${callId}.mp3`);
  await transcodeToSpeechMp3(srcPath, mp3Path);
  const size = fileSizeBytes(mp3Path);
  const mb = (size / 1048576).toFixed(2);
  console.log(`[prep] compressed MP3 size=${mb} MB at ${nowIso()}`);

  const mustSegment = size > Math.max(FORCE_SEGMENT_SIZE_MB, 25) * 1024 * 1024;
  if (ALWAYS_SEGMENT || mustSegment) {
    console.log(`[prep] segmenting audio (ALWAYS_SEGMENT=${ALWAYS_SEGMENT}, size>${FORCE_SEGMENT_SIZE_MB}MB? ${mustSegment})…`);
    const pattern = tmpPath(`${callId}_part_%03d.mp3`);
    const parts = await segmentAudio(mp3Path, pattern, SEGMENT_SECONDS);
    console.log(`[prep] created ${parts.length} chunk(s).`);
    if (!parts.length) {
      console.warn(`[prep] WARNING: segmentation produced 0 chunks – falling back to single file.`);
      return { mode: "single", files: [mp3Path] };
    }
    return { mode: "multi", files: parts };
  }

  if (size <= MAX_WHISPER_BYTES) {
    console.log(`[prep] using single file (<=25MB & segmentation not forced).`);
    return { mode: "single", files: [mp3Path] };
  }

  console.log(`[prep] single file >25MB, segmenting to meet Whisper limit…`);
  const pattern = tmpPath(`${callId}_part_%03d.mp3`);
  const parts = await segmentAudio(mp3Path, pattern, SEGMENT_SECONDS);
  console.log(`[prep] created ${parts.length} chunk(s) due to 25MB limit.`);
  if (!parts.length) {
    console.warn(`[prep] WARNING: forced segmentation produced 0 chunks – falling back to single file.`);
    return { mode: "single", files: [mp3Path] };
  }
  return { mode: "multi", files: parts };
}

// -------------------------------------------------------------
// Transcription (parallel)
// -------------------------------------------------------------
async function transcribeFileWithOpenAI(filePath) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    form.append("model", "whisper-1");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`OpenAI transcription failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return j.text || "";
  } finally { clearTimeout(to); }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function transcribeWithRetries(filePath, label) {
  let attempt = 0;
  let wait = 1000;
  const start = Date.now();
  for (;;) {
    attempt += 1;
    console.log(`[whisper] ${label} attempt ${attempt} started`);
    try {
      const text = await transcribeFileWithOpenAI(filePath);
      console.log(`[whisper] ${label} finished in ${Math.round((Date.now()-start)/1000)}s`);
      return text;
    } catch (e) {
      console.warn(`[whisper] ${label} failed: ${e.message}`);
      if (attempt >= WHISPER_MAX_RETRIES) throw e;
      console.log(`[whisper] backing off ${wait}ms…`);
      await sleepMs(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
}

async function transcribeAudioSmart(srcPath, callId) {
  console.log("[bg] Preparing audio for Whisper…");
  const prep = await ensureWhisperFriendlyAudio(srcPath, callId);

  if (prep.mode === "single") {
    const sizeMb = (fileSizeBytes(prep.files[0]) / 1048576).toFixed(2);
    console.log(`[bg] Transcribing single compressed file (size=${sizeMb} MB)…`);
    return await transcribeWithRetries(prep.files[0], "single");
  }

  console.log(`[bg] Transcribing ${prep.files.length} chunk(s) in parallel (concurrency=${TRANSCRIBE_CONCURRENCY})…`);
  const queue = [...prep.files.entries()];
  const results = new Array(prep.files.length).fill("");

  async function worker(workerId) {
    while (queue.length) {
      const [i, f] = queue.shift();
      const sizeMb = (fileSizeBytes(f) / 1048576).toFixed(2);
      const label = `chunk ${i + 1}/${prep.files.length} (w${workerId}, ${sizeMb} MB)`;
      results[i] = await transcribeWithRetries(f, label);
    }
  }

  const workers = Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, prep.files.length) }, (_, k) => worker(k + 1));
  await Promise.all(workers);

  console.log("[whisper] all chunks transcribed; stitching…");
  return results.join("\n");
}

// -------------------------------------------------------------
// Heuristics & classification
// -------------------------------------------------------------
function heuristicType(recordingUrl, transcript) {
  const t = (transcript || "").toLowerCase();
  const zoom = isZoomUrl(recordingUrl);
  const docusign    = /docusign|sign(ing)? (the )?(application|forms?)|envelope/i.test(t);
  const dataCapture = /(date of birth|dob|national insurance|ni number|address|postcode|company (reg|registration)|utr|tax reference|bank details|sort code|account number)/i.test(t);
  const walkthrough = /(features|benefits|compare|ssas|fic|small self administered|family investment company|pension|property purchase|how it works)/i.test(t);
  const followUp    = /(following up|as discussed last time|had (a )?chance to review|remaining questions|what'?s stopping you|close plan|next steps from last time)/i.test(t);

  if (!zoom) return { hint: "Qualification call", reason: "phone only rule; not Zoom" };
  if (docusign && !dataCapture) return { hint: "Application meeting", reason: "DocuSign signing only" };
  if (followUp) return { hint: "Follow up call", reason: "follow-up cues on Zoom" };
  if (dataCapture || walkthrough) return { hint: "Initial Consultation", reason: "data capture / walkthrough" };
  return { hint: "Initial Consultation", reason: "Zoom default (weak)" };
}

const CALL_TYPE_LABELS = [
  "Qualification call","Initial Consultation","Follow up call","Application meeting",
  "Strategy call","Annual Review","Existing customer call","Other",
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
`Classify HubSpot calls using STRICT definitions…
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

  // Write AI fields on Call
  await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { ai_inferred_call_type: finalLabel, ai_call_type_confidence: String(confidence) },
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
// Coaching & Analysis (unchanged behaviour)
// -------------------------------------------------------------
function enforceSSAS(text) { return typeof text === "string" ? text.replace(/\bsaas\b/gi, "SSAS") : ""; }

async function scoreSalesPerformance(transcript) {
  const system = "You are TLPI’s transcript analysis bot. Follow rubrics exactly. Output ONLY the integer 1..10.";
  const prompt = `EVALUATE THE CONSULTANT…\nTranscript:\n${enforceSSAS(transcript)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.1, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
  });
  const j = await r.json();
  const text = (j?.choices?.[0]?.message?.content || "").trim();
  const m = text.match(/\b(10|[1-9])\b/);
  return m ? Math.max(1, Math.min(10, parseInt(m[1], 10))) : 5;
}

async function summariseSalesPerformance(transcript) {
  const system = 'You are TLPI’s transcript analysis bot. Always spell "SSAS".';
  const prompt = `What went well:\n- …\n\nAreas to improve:\n- …\n\nTranscript:\n${enforceSSAS(transcript)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
  });
  const j = await r.json();
  const raw = (j?.choices?.[0]?.message?.content || "").trim();
  return raw.replace(/^[\s"']+|[\s"']+$/g, "");
}

async function analyseCall(typeLabel, transcript) {
  const system = "You are TLPI’s call analysis bot. Output JSON only.";
  const base = `Call Type: ${typeLabel}\n\nTranscript:\n${transcript}\n\nReturn JSON keys…`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0.2, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: base }]
    }),
  });
  const j = await r.json();
  try { return JSON.parse(j?.choices?.[0]?.message?.content || "{}"); }
  catch { return {}; }
}

async function ensureMetricsIfNeeded(typeLabel, transcript, analysis) {
  if (typeLabel !== "Initial Consultation" && typeLabel !== "Follow up call") return analysis;
  const missingIC = typeLabel === "Initial Consultation" && !analysis.consult_metrics;
  const missingFU = typeLabel === "Follow up call" && !analysis.followup_metrics;
  if (!missingIC && !missingFU) return analysis;

  const ask = typeLabel === "Initial Consultation"
    ? `From the transcript, return ONLY JSON with {"consult_metrics":{…20 keys…},"consult_score_final":1..10}`
    : `From the transcript, return ONLY JSON with {"followup_metrics":{…10 keys…},"followup_score_final":1..10}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
      messages: [{ role: "system", content: "Return ONLY valid JSON for the requested keys." }, { role: "user", content: `Transcript:\n${transcript}\n\n${ask}` }],
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
const normaliseSeverity = (v) => ({ low:"Low", medium:"Medium", high:"High" }[String(v||"").trim().toLowerCase()] || "");
const normaliseSentiment = (v) => ({ positive:"Positive", neutral:"Neutral", negative:"Negative" }[String(v||"").trim().toLowerCase()] || "");
const normaliseYesNoUnclear = (v) => ({ yes:"Yes", no:"No", unclear:"Unclear" }[String(v||"").trim().toLowerCase()] || "");
const normaliseEscalation = (v) => ({ yes:"Yes", no:"No", monitor:"Monitor" }[String(v||"").trim().toLowerCase()] || "");

// -------------------------------------------------------------
// HubSpot helpers (Call updates + Scorecard creation & association)
// -------------------------------------------------------------
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
      console.warn(`[retry] removing unknown Call properties and retrying once: ${bad.join(", ")}`);
      const pruned = { ...properties };
      for (const b of bad) delete pruned[b];
      const r2 = await patch(pruned);
      if (r2.ok) return;
      const text2 = await r2.text();
      if (r2.status === 400 && text2.includes("PROPERTY_DOESNT_EXIST")) {
        console.warn(`[skip] still unknown after prune; continuing. Response: ${text2}`);
        return;
      }
      throw new Error(`HubSpot Call update failed after retry: ${r2.status} ${text2}`);
    }
  }
  throw new Error(`HubSpot Call update failed: ${r.status} ${text1}`);
}

const assocCache = new Map();
async function findAssocType(from, to) {
  const key = `${from}::${to}`;
  if (assocCache.has(key)) return assocCache.get(key);
  const headers = { Authorization: `Bearer ${HUBSPOT_TOKEN}` };

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

  return null;
}

async function createSalesScorecardCallFirst(fields, { callId, effectiveType, callTimestampMs } = {}) {
  const activityName = `${callId} — ${effectiveType} — ${ymd(callTimestampMs || Date.now())}`;

  let props = {
    [SCORECARD_TYPE_KEY]: effectiveType,
    [SCORECARD_NAME_KEY]: activityName, // will be pruned if not present in portal
    ...fields,
  };

  const baseBody = {};
  const assoc = await findAssocType(SCORECARD_TYPE, "calls");
  if (callId && assoc) {
    baseBody.associations = [{
      to: { id: String(callId) },
      types: [{ associationCategory: assoc.category, associationTypeId: assoc.typeId }],
    }];
  } else if (callId) {
    console.warn(`[assoc] no scorecard→call association type; creating scorecard without call link`);
  }

  async function post(propsObj) {
    return fetch(`https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(SCORECARD_TYPE)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, properties: propsObj }),
    });
  }

  for (let pass = 1; pass <= 3; pass++) {
    const r = await post(props);
    if (r.ok) {
      const j = await r.json();
      console.log(`[scorecard] created ${j?.id} (pass ${pass})`);
      return j?.id;
    }
    const text = await r.text();
    if (r.status === 400 && text.includes("PROPERTY_DOESNT_EXIST")) {
      const bad = Array.from(text.matchAll(/"name":"([^"]+)"/g)).map(m => m[1]);
      const unique = Array.from(new Set(bad));
      if (unique.length) {
        console.warn(`[scorecard] pass ${pass} pruning unknown properties: ${unique.join(", ")}`);
        const next = { ...props };
        for (const b of unique) delete next[b];
        const changed = Object.keys(props).length !== Object.keys(next).length;
        props = next;
        if (changed) continue;
      }
    }
    if (pass === 3) {
      console.warn(`[scorecard] final fallback: attempting minimal properties only`);
      props = {
        [SCORECARD_TYPE_KEY]: effectiveType,
        [SCORECARD_RATING_KEY]: fields[SCORECARD_RATING_KEY],
        [SCORECARD_SUMMARY_KEY]: fields[SCORECARD_SUMMARY_KEY],
      };
      continue;
    }
  }
  throw new Error(`scorecard create failed after retries`);
}

// -------------------------------------------------------------
// Mapping helpers: analysis -> your portal property names
// -------------------------------------------------------------
function mapQualMetricsToPortal(m) {
  return {
    qual_intro:                         String(m.q1_need_clearly_stated ?? 0),
    qual_rapport:                       String(m.q2_budget_discussed ?? 0),
    qual_open_question:                 String(m.q3_decision_maker_present ?? 0),
    qual_relevant_pain_identified:      String(m.q4_authority_confirmed ?? 0),
    qual_services_explained_clearly:    String(m.q5_timeline_identified ?? 0),
    qual_benefits_linked_to_needs:      String(m.q6_pain_depth_understood ?? 0),
    qual_active_listening:              String(m.q7_current_solution_understood ?? 0),
    qual_clear_responses_or_followup:   String(m.q8_competition_identified ?? 0),
    qual_next_steps_confirmed:          String(m.q9_next_step_clearly_agreed ?? 0),
    qual_commitment_requested:          String(m.q10_fit_assessed ?? 0),
  };
}

function mapConsultMetricsToPortal(c) {
  const s = (v) => String(v ?? 0);
  return {
    consult_rapport_open:                 s(c.c1_goal_alignment),
    consult_purpose_clearly_stated:       s(c.c2_current_state_captured),
    consult_confirm_reason_for_zoom:      s(c.c3_risk_tolerance_explored),
    consult_demo_tax_saving:              s(c.c4_tax_context_understood),
    consult_specific_tax_estimate_given:  s(c.c5_pension_context_understood),
    consult_no_assumptions_evidence_gathered: s(c.c6_cashflow_model_discussed),
    consult_needs_pain_uncovered:         s(c.c7_ssas_fic_fit_discussed),
    consult_quantified_value_roi:         s(c.c8_fees_explained),
    consult_fees_tax_deductible_explained:s(c.c9_regulatory_disclosures_made),
    consult_fees_annualised:              s(c.c10_key_risks_explained),
    consult_fee_phrasing_three_seven_five:s(c.c11_questions_addressed),
    consult_closing_question_asked:       s(c.c12_next_steps_agreed),
    consult_collected_dob_nin_when_agreed:s(c.c13_materials_promised),
    consult_overcame_objection_and_closed:s(c.c14_decision_criteria_logged),
    consult_customer_agreed_to_set_up:    s(c.c15_objections_summarised),
    consult_next_step_specific_date_time: s(c.c16_stakeholders_identified),
    consult_next_contact_within_5_days:   s(c.c17_urgency_established),
    consult_strong_buying_signals_detected:s(c.c18_buyer_journey_stage),
    consult_prospect_asked_next_steps:    s(c.c19_application_readiness),
    consult_interactive_throughout:       s(c.c20_close_plan_started),
  };
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
    const callTimestampMs = Number(props.hs_timestamp?.value || props.hs_timestamp || Date.now());

    if (!callId || !recordingUrl) return res.status(400).send("Missing recordingUrl or callId");
    console.log("resolved recordingUrl:", recordingUrl);
    console.log("resolved callId:", callId);

    res.status(200).send("Processing");

    setImmediate(async () => {
      try {
        const overallStart = Date.now();

        // 1) Audio -> Transcript
        const dlStart = Date.now();
        const srcPath = await downloadRecording(recordingUrl, callId);
        console.log(`[timing] download done in ${Math.round((Date.now()-dlStart)/1000)}s`);

        const trStart = Date.now();
        const transcript = await transcribeAudioSmart(srcPath, callId);
        console.log(`[timing] transcription total ${Math.round((Date.now()-trStart)/1000)}s`);

        // 2) Call type
        const typeStart = Date.now();
        const effectiveType = await resolveCallTypeWithGrace(callId, transcript, recordingUrl, GRACE_MS);
        console.log(`[type] effectiveType: ${effectiveType} (in ${Math.round((Date.now()-typeStart)/1000)}s)`);

        // 3) Analysis (+ ensure metrics if missing)
        const anStart = Date.now();
        let analysis = await analyseCall(effectiveType, transcript);
        analysis = await ensureMetricsIfNeeded(effectiveType, transcript, analysis);
        console.log(`[timing] analysis total ${Math.round((Date.now()-anStart)/1000)}s`);

        // 4) Coaching
        const coachStart = Date.now();
        const [salesPerfScore, salesPerfSummary] = await Promise.all([
          scoreSalesPerformance(transcript),
          summariseSalesPerformance(transcript),
        ]);
        console.log(`[timing] coaching total ${Math.round((Date.now()-coachStart)/1000)}s`);

        // 5) Call-level updates
        const objections = analysis.objections || {};
        const callUpdates = {
          ai_objections_bullets: (objections.bullets || []).join(" • "),
          ai_primary_objection: objections.primary || "",
          ai_objection_severity: normaliseSeverity(objections.severity),
        };

        if (effectiveType === "Existing customer call") {
          callUpdates.ai_customer_sentiment  = normaliseSentiment(analysis.customer_sentiment);
          callUpdates.ai_complaint_detected  = normaliseYesNoUnclear(analysis.complaint_detected);
          callUpdates.ai_escalation_required = normaliseEscalation(analysis.escalation_required);
          callUpdates.ai_escalation_notes    = analysis.escalation_notes || "";
        }

        if (effectiveType === "Initial Consultation") {
          if (Array.isArray(analysis.product_interest) && analysis.product_interest.length) {
            callUpdates.ai_product_interest = analysis.product_interest.includes("Both") ? "Both" : (analysis.product_interest[0] || "");
          }
          if (Array.isArray(analysis.application_data_points) && analysis.application_data_points.length) {
            callUpdates[IC_DATA_POINTS_KEY] = analysis.application_data_points.join(" • ");
          }
          if (Array.isArray(analysis.missing_information) && analysis.missing_information.length) {
            callUpdates[IC_MISSING_INFO_KEY] = analysis.missing_information.join(" • ");
          }
        }

        await updateHubSpotCall(callId, callUpdates);

        // 6) Scorecards — create for Qual/IC/Follow-up (or metrics present)
        const createQual    = (effectiveType === "Qualification call")    || (SCORECARD_BY_METRICS && analysis.qual_metrics);
        const createConsult = (effectiveType === "Initial Consultation")  || (SCORECARD_BY_METRICS && analysis.consult_metrics);
        const createFollow  = (effectiveType === "Follow up call")        || (SCORECARD_BY_METRICS && analysis.followup_metrics);

        const coaching = {
          [SCORECARD_RATING_KEY]: salesPerfScore,
          [SCORECARD_SUMMARY_KEY]: salesPerfSummary,
        };

        if (createQual && analysis.qual_metrics) {
          const m = analysis.qual_metrics || {};
          const fields = {
            ...coaching,
            ...mapQualMetricsToPortal(m),          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
            qual_score_final: String(analysis.qual_score_final ?? 0),
          };
          try { await createSalesScorecardCallFirst(fields, { callId, effectiveType, callTimestampMs }); }
          catch (e) { console.error(`[scorecard] creation failed (Qualification) but continuing: ${e.message}`); }
        } else if (createConsult && analysis.consult_metrics) {
          const c = analysis.consult_metrics || {};
          const fields = {
            ...coaching,
            ...mapConsultMetricsToPortal(c),       // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
            consult_score_final: String(analysis.consult_score_final ?? 0),
          };
          try { await createSalesScorecardCallFirst(fields, { callId, effectiveType, callTimestampMs }); }
          catch (e) { console.error(`[scorecard] creation failed (Initial Consultation) but continuing: ${e.message}`); }
        } else if (createFollow && analysis.followup_metrics) {
          const f = analysis.followup_metrics || {};
          const fields = {
            ...coaching,
            // NOTE: your portal currently lacks follow-up metric fields; prune loop will handle.
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
            followup_score_final: String(analysis.followup_score_final ?? 0),
          };
          try { await createSalesScorecardCallFirst(fields, { callId, effectiveType, callTimestampMs }); }
          catch (e) { console.error(`[scorecard] creation failed (Follow up) but continuing: ${e.message}`); }
        } else {
          console.log(`[scorecard] not created (type=${effectiveType}, metrics present? qual=${!!analysis.qual_metrics}, consult=${!!analysis.consult_metrics}, follow=${!!analysis.followup_metrics})`);
        }

        console.log(`✅ [bg] Done ${callId} in ${Math.round((Date.now()-overallStart)/1000)}s`);
      } catch (e) {
        console.error("❗ [bg] Error", e);
      }
    });
  } catch (err) {
    console.error("Error in /process-call:", err);
    res.status(500).send("Internal error");
  }
});

// Keep 404s quiet
app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
