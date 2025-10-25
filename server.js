// =============================================================
// TLPI – AI Call Worker  (v2.2)
// - Fix 413 by compressing audio and chunking if needed
// - Keeps call-type grace + inference, analysis skeleton, HS updates
// =============================================================

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import FormData from "form-data";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || process.env.ZOOM_ACCESS_TOKEN; // optional

// ---- Constants ----
const MAX_WHISPER_BYTES = 25 * 1024 * 1024; // 25 MB hard limit
const TMP_DIR = os.tmpdir();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: "50mb" }));

// -------------------------------------------------------------
// Utils
// -------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fileSizeBytes(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function tmpPath(name) { return path.join(TMP_DIR, name); }

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
  if (/\.hubspot\.com/i.test(url) && HUBSPOT_TOKEN) {
    headers.Authorization = `Bearer ${HUBSPOT_TOKEN}`;
  }
  if (/\.zoom\.us/i.test(url) && ZOOM_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${ZOOM_BEARER_TOKEN}`;
  }
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
  // Mono, 16kHz, ~24 kbps CBR MP3 (good enough for speech; tiny)
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

function segmentAudio(inPath, outPattern, seconds = 600 /* 10 min */) {
  // Split by duration to keep each part small
  return new Promise((resolve, reject) => {
    const outFiles = [];
    ffmpeg(inPath)
      .outputOptions([
        "-f", "segment",
        "-segment_time", String(seconds),
        "-reset_timestamps", "1",
      ])
      .output(outPattern)
      .on("start", (cmd) => console.log("[ffmpeg] segment cmd:", cmd))
      .on("error", reject)
      .on("end", () => {
        // Enumerate produced files
        const dir = path.dirname(outPattern);
        const base = path.basename(outPattern).replace("%03d", "");
        const all = fs.readdirSync(dir)
          .filter(f => f.startsWith(base))
          .map(f => path.join(dir, f))
          .sort();
        resolve(all);
      })
      .run();
  });
}

async function ensureWhisperFriendlyAudio(srcPath, callId) {
  // 1) If already under limit and readable by Whisper (we’ll force mp3 anyway)
  const initialOut = tmpPath(`${callId}.mp3`);
  await transcodeToSpeechMp3(srcPath, initialOut);
  let size = fileSizeBytes(initialOut);
  if (size <= MAX_WHISPER_BYTES) {
    return { mode: "single", files: [initialOut] };
  }

  console.log(`[prep] compressed file still too large (${(size/1024/1024).toFixed(1)} MB). Segmenting...`);

  // 2) Segment into 10-minute chunks after compression
  const pattern = tmpPath(`${callId}_part_%03d.mp3`);
  const parts = await segmentAudio(initialOut, pattern, 600);
  // Optional: if any part > limit (very rare with our settings), re-compress tighter
  const safeParts = [];
  for (const p of parts) {
    const s = fileSizeBytes(p);
    if (s > MAX_WHISPER_BYTES) {
      const tighter = tmpPath(`${path.basename(p, ".mp3")}_tight.mp3`);
      await transcodeToSpeechMp3(p, tighter); // same settings; if it remains too big, duration is the cause
      safeParts.push(tighter);
    } else {
      safeParts.push(p);
    }
  }
  return { mode: "multi", files: safeParts };
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
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI transcription failed: ${r.status} ${t}`);
  }
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
  let all = [];
  for (let i = 0; i < prep.files.length; i++) {
    console.log(`[bg] Chunk ${i + 1}/${prep.files.length}`);
    const text = await transcribeFileWithOpenAI(prep.files[i]);
    all.push(text);
  }
  return all.join("\n");
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
// Analysis (skeleton – expand later)
// -------------------------------------------------------------
async function analyseCall(typeLabel, transcript) {
  const system = "You are TLPI’s call analysis bot. Output JSON only.";
  const brief = {
    "Qualification call": "Analyse discovery performance, objections, short suggestions.",
    "Initial Consultation": "Analyse consultation delivery, product interest, application data when present, objections.",
    "Follow up call": "Analyse follow-up status, remaining objections, likelihood to close, next steps.",
    "Application meeting": "List key data captured, missing information, and next steps.",
    "Strategy call": "Summarise strategy focus areas, recommendations, and engagement level.",
    "Annual Review": "Summarise satisfaction, achievements, and improvement areas.",
    "Existing customer call": "Detect sentiment, complaints, escalation need, and notes.",
    Other: "Generic summary and objections.",
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

    // background
    setImmediate(async () => {
      try {
        const srcPath = await downloadRecording(recordingUrl, callId);
        const transcript = await transcribeAudioSmart(srcPath, callId);

        const effectiveType = await resolveCallTypeWithGrace(callId, transcript, 120000);
        console.log("[type] effectiveType:", effectiveType);

        const analysis = await analyseCall(effectiveType, transcript);

        // Map common objection fields
        const objections = analysis.objections || {};
        const updates = {
          ai_objections_bullets: (objections.bullets || []).join(" • "),
          ai_primary_objection: objections.primary || "",
          ai_objection_severity: objections.severity || "",
        };

        // Initial Consultation extras (support capturing application info present in that meeting)
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
