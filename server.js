// =============================================================
// TLPI – AI Call Worker (v2.6-patched for portal field names)
// - Uses ai_customer_sentiment / ai_complaint_detected / ai_escalation_required / ai_escalation_notes
// - Safe retry-on-unknown properties (works without calls-read)
// - Qualification & Consultation Scorecards + associations
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
const HUBSPOT_TOKEN  = process.env.HUBSPOT_TOKEN;
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN || process.env.ZOOM_ACCESS_TOKEN;
const GRACE_MS = Number(process.env.GRACE_MS ?? 0);

const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
const TMP_DIR = os.tmpdir();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: "50mb" }));

// -------------------------------------------------------------
// Utilities
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
// Audio Download & Prepare
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
    console.log(`[bg] Chunk ${i+1}/${prep.files.length}`);
    pieces.push(await transcribeFileWithOpenAI(prep.files[i]));
  }
  return pieces.join("\n");
}

// -------------------------------------------------------------
// Helpers
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
// Safe HubSpot updater (retry on unknown properties)
// -------------------------------------------------------------
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
    res.status(200).send("Processing");

    setImmediate(async () => {
      try {
        const srcPath = await downloadRecording(recordingUrl, callId);
        const transcript = await transcribeAudioSmart(srcPath, callId);

        // (keep your inference / analysis sections here unchanged)
        // ...
        // [for brevity – they remain exactly as in v2.6]

        // Example only: show correct mapping snippet
        const effectiveType = "Existing customer call"; // placeholder – use your actual resolved type
        const analysis = {}; // placeholder

        const updates = {};
        if (effectiveType === "Existing customer call") {
          updates.ai_customer_sentiment  = normaliseSentiment(analysis.customer_sentiment);
          updates.ai_complaint_detected  = normaliseYesNoUnclear(analysis.complaint_detected);
          updates.ai_escalation_required = normaliseEscalation(analysis.escalation_required);
          updates.ai_escalation_notes    = analysis.escalation_notes || "";
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
