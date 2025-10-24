// Load environment variables from .env
import 'dotenv/config';

import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Increase body size just in case HubSpot sends large payloads
app.use(express.json({ limit: "5mb" }));

// ---- Helpers ---------------------------------------------------------------

// Download the recording audio file from a URL and save to temp file
async function downloadRecording(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download recording: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  const filePath = path.join(__dirname, "temp_audio.mp3");
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(filePath) {
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Transcription failed: ${response.status} ${response.statusText} ${errText}`);
  }
  const data = await response.json();
  return data.text;
}

// Analyse transcript with GPT-4o-mini and return JSON-ish string
async function analyseTranscript(transcript) {
  const prompt = `
You are an AI call analyst. Summarise the call, identify next actions, and sentiment.
Return JSON with keys: summary, actions, sentiment.
  `.trim();

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: `${prompt}\n\nTranscript:\n${transcript}` },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Analysis failed: ${response.status} ${response.statusText} ${errText}`);
  }
  const data = await response.json();
  const message = data?.choices?.[0]?.message?.content ?? "";
  return message;
}

// ---- Routes ----------------------------------------------------------------

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Webhook entry point
app.post("/process-call", async (req, res) => {
  try {
    const body = req.body || {};
    // Log the keys we received to make debugging easy
    console.log("Incoming webhook keys:", Object.keys(body));

    // Accept multiple possible field names for compatibility with HubSpot
    const recordingUrl =
      body.recordingUrl ||              // our custom key (recommended)
      body.hs_call_recording_url ||     // HubSpot Call property (internal name)
      body.recording_url ||             // sometimes appears without the "hs_" prefix
      null;

    const callId =
      body.callId ||                    // our custom key
      body.hs_object_id ||              // HubSpot Call record ID
      body.call_id ||                   // alternate
      null;

    if (!recordingUrl) {
      return res.status(400).send("Missing recordingUrl");
    }

    console.log("Downloading recording:", recordingUrl);
    const filePath = await downloadRecording(recordingUrl);

    console.log("Transcribing...");
    const transcript = await transcribeAudio(filePath);

    console.log("Analysing...");
    const analysis = await analyseTranscript(transcript);

    console.log("Uploading to HubSpot...");
    if (!callId) {
      console.warn("No callId provided; skipping HubSpot update");
    } else {
      const hsResp = await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
        },
        body: JSON.stringify({
          properties: {
            ai_transcript: transcript,
            ai_analysis: analysis,
          },
        }),
      });
      if (!hsResp.ok) {
        const t = await hsResp.text().catch(() => "");
        throw new Error(`HubSpot update failed: ${hsResp.status} ${hsResp.statusText} ${t}`);
      }
    }

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch {}

    res.json({ status: "success", callId: callId ?? null, analysis });
  } catch (err) {
    console.error("❗ Error in /process-call:", err);
    res.status(500).send(err?.message ?? "Internal error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ AI Call Worker listening on port ${PORT}`));
