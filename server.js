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

app.use(express.json({ limit: "5mb" }));

// ---------- Small helpers ----------
function unwrapHubSpotValue(maybe) {
  // HubSpot "Include all properties" often sends objects like { value: "..." }
  if (maybe && typeof maybe === "object") {
    if (typeof maybe.value !== "undefined") return maybe.value;
    if (typeof maybe.link !== "undefined") return maybe.link;
    // If it’s some other shape, return empty to avoid "[object Object]"
    return "";
  }
  return maybe;
}

function resolveFirst(...candidates) {
  for (const c of candidates) {
    const v = unwrapHubSpotValue(c);
    if (v !== undefined && v !== null && String(v).trim().length > 0) {
      return String(v).trim();
    }
  }
  return null;
}

// Download the recording audio file from a URL and save to temp file
async function downloadRecording(url) {
  // Basic guard
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid recording URL format: ${url}`);
  }

  // Try a simple download first (many public/Zoom links work directly)
  const response = await fetch(url);
  if (!response.ok) {
    // If the link is auth-gated (401/403), note it in the error
    throw new Error(`Failed to download recording: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  const filePath = path.join(__dirname, "temp_audio.mp3");
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
}

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
  return data?.choices?.[0]?.message?.content ?? "";
}

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/process-call", async (req, res) => {
  try {
    const body = req.body || {};
    const keys = Object.keys(body);
    console.log("Incoming webhook keys:", keys);

    const props = body.properties || {};
    if (body.properties) {
      console.log("properties keys:", Object.keys(props));
    }

    // Raw (possibly object) values
    const rawRecordingUrl =
      body.recordingUrl ??
      body.hs_call_recording_url ??
      body.recording_url ??
      props.hs_call_recording_url ??
      props.recording_url ??
      props.recordingUrl ??
      null;

    const rawCallId =
      body.callId ??
      body.hs_object_id ??
      body.call_id ??
      props.hs_object_id ??
      props.call_id ??
      props.callId ??
      body.objectId ?? // fallback from the top-level wrapper
      null;

    // Log the raw types/lengths (before unwrapping)
    const urlType = typeof rawRecordingUrl;
    const urlLen = rawRecordingUrl ? String(rawRecordingUrl).length : 0;
    const callIdType = typeof rawCallId;
    const callIdLen = rawCallId ? String(rawCallId).length : 0;
    console.log(`raw recordingUrl -> type: ${urlType}, length: ${urlLen}`);
    console.log(`raw callId       -> type: ${callIdType}, length: ${callIdLen}`);

    // Resolve to usable strings
    const recordingUrl = resolveFirst(rawRecordingUrl);
    const callId = resolveFirst(rawCallId);

    console.log(`resolved recordingUrl: ${recordingUrl ? recordingUrl.slice(0, 120) : "(null)"}`);
    console.log(`resolved callId: ${callId ?? "(null)"}`);

    if (!recordingUrl) {
      return res.status(400).json({
        error: "Missing recordingUrl",
        receivedKeys: keys,
        hasProperties: !!body.properties,
        propertiesKeys: Object.keys(props || {}),
        debug: { urlType, urlLen, callIdType, callIdLen }
      });
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

    try { fs.unlinkSync(filePath); } catch {}
    res.json({ status: "success", callId: callId ?? null });
  } catch (err) {
    console.error("❗ Error in /process-call:", err);
    res.status(500).send(err?.message ?? "Internal error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ AI Call Worker listening on port ${PORT}`));
