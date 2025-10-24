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

app.use(express.json());

// Helper to download the recording
async function downloadRecording(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download recording: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const filePath = path.join(__dirname, "temp_audio.mp3");
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return filePath;
}

// Helper to transcribe audio using OpenAI Whisper
async function transcribeAudio(filePath) {
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!response.ok) throw new Error(`Transcription failed: ${response.status}`);
  const data = await response.json();
  return data.text;
}

// Helper to analyse transcript
async function analyseTranscript(transcript) {
  const prompt = `
You are an AI call analyst. Summarise the call, identify next actions, and sentiment.
Return JSON with keys: summary, actions, sentiment.
`;

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

  if (!response.ok) throw new Error(`Analysis failed: ${response.status}`);
  const data = await response.json();
  const message = data.choices[0].message.content;
  return message;
}

// Endpoint for handling HubSpot or Zoom webhook events
app.post("/process-call", async (req, res) => {
  try {
    const { recordingUrl, callId } = req.body;
    if (!recordingUrl) return res.status(400).send("Missing recordingUrl");

    console.log("Downloading recording:", recordingUrl);
    const filePath = await downloadRecording(recordingUrl);

    console.log("Transcribing...");
    const transcript = await transcribeAudio(filePath);

    console.log("Analysing...");
    const analysis = await analyseTranscript(transcript);

    console.log("Uploading to HubSpot...");
    await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}`, {
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

    fs.unlinkSync(filePath); // Clean up
    res.json({ status: "success", analysis });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ AI Call Worker listening on port ${PORT}`));
