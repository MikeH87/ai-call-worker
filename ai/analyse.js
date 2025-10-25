// ai/analyse.js
import dotenv from "dotenv";
import fs from "fs";
import FormData from "form-data";
import fetch from "node-fetch";
import { getCombinedPrompt } from "./getCombinedPrompt.js";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("[cfg] OPENAI_API_KEY missing — transcription/analysis will fail.");
}

const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const TRANSCRIPTION_MODEL = process.env.WHISPER_MODEL || "whisper-1";
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "gpt-4o-mini";

/**
 * Transcribe a single audio file with Whisper.
 * @param {string} audioPath
 * @returns {Promise<string>} transcript text
 */
export async function transcribeFile(audioPath) {
  const form = new FormData();
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "text");
  form.append("file", fs.createReadStream(audioPath));

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Whisper failed ${res.status} ${res.statusText} — ${text?.slice(0, 300)}`);
  }
  return await res.text();
}

/**
 * Analyse the transcript using TLPI prompts.
 * Returns a structured object for HubSpot update + scorecard.
 */
export async function analyseTranscript(callTypeLabel, transcript) {
  const systemAndUser = await getCombinedPrompt(callTypeLabel, transcript);

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemAndUser.system },
        { role: "user", content: systemAndUser.user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Analysis failed ${res.status} ${res.statusText} — ${text?.slice(0, 400)}`);
  }

  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(raw);
  } catch {
    // if model returns non-JSON, fallback to plain object with a field
    return { notes: raw, parsing_error: true };
  }
}
