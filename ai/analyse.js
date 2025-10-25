// ai/analyse.js
// Whisper transcription + GPT analysis using editable prompt files
// Exports getCombinedPrompt() so you can debug what is sent to OpenAI.

import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Read prompt from files (company context + meeting-specific) ---
export function getCombinedPrompt(callType, transcript) {
  const folder = path.resolve("./prompts");
  const contextFile = path.join(folder, "company_context.txt");

  const files = {
    Qualification: "qualification.txt",
    "Initial Consultation": "consultation.txt",
    "Follow up call": "followup.txt",       // match your hs_activity_type
    "Follow-up": "followup.txt",            // tolerate this label too
    "Application meeting": "application.txt",
    Application: "application.txt",
  };

  const specificFile = path.join(folder, files[callType] || "consultation.txt");

  // Read both files (empty string if missing)
  const baseContext = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, "utf8") : "";
  const specificPrompt = fs.existsSync(specificFile) ? fs.readFileSync(specificFile, "utf8") : "";

  // Combine both: company context first, then meeting prompt
  const combined = `${baseContext.trim()}\n\n---\n\n${specificPrompt.trim()}`;
  return combined.replace("<<<TRANSCRIPT>>>", transcript || "");
}

// --- Transcribe using Whisper ---
export async function transcribeFile(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) throw new Error(`Whisper failed: ${res.status}`);
  const json = await res.json();
  return json.text || "";
}

// --- Analyse transcript with the correct prompt ---
export async function aiAnalyse(transcript, callType = "Initial Consultation") {
  const prompt = getCombinedPrompt(callType, transcript);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const j = await res.json();
  try {
    return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
  } catch {
    return {};
  }
}
