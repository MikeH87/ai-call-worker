// ai/analyse.js
// Whisper transcription + GPT analysis using editable prompt files
// Adds: TRANSCRIBE_MODEL env switch, OpenAI-Organization header, refined retry.
// Exports getCombinedPrompt(), transcribeFile(), aiAnalyse().

import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORG_ID = process.env.OPENAI_ORG_ID || "";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1"; 
// You may set TRANSCRIBE_MODEL=gpt-4o-mini-transcribe if enabled on your account.

// -----------------------------
// Helpers
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jittered(ms) {
  const delta = ms * 0.2;
  return Math.round(ms - delta + Math.random() * (2 * delta));
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...(OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {}),
    ...extra,
  };
}

// -----------------------------
// Combine prompts from files
// -----------------------------
export function getCombinedPrompt(callType, transcript) {
  const folder = path.resolve("./prompts");
  const contextFile = path.join(folder, "company_context.txt");

  const files = {
    Qualification: "qualification.txt",
    "Qualification call": "qualification.txt",
    "Initial Consultation": "consultation.txt",
    "Follow up call": "followup.txt",
    "Follow-up": "followup.txt",
    "Application meeting": "application.txt",
    Application: "application.txt",
  };

  const specificFile = path.join(folder, files[callType] || "consultation.txt");

  const baseContext = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, "utf8") : "";
  const specificPrompt = fs.existsSync(specificFile) ? fs.readFileSync(specificFile, "utf8") : "";

  const combined = `${baseContext.trim()}\n\n---\n\n${specificPrompt.trim()}`;
  return combined.replace("<<<TRANSCRIPT>>>", transcript || "");
}

// -----------------------------
// Whisper (or 4o-mini-transcribe) with robust retry
// -----------------------------
export async function transcribeFile(filePath) {
  const maxAttempts = 5;
  let attempt = 0;

  while (true) {
    attempt += 1;

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    form.append("model", TRANSCRIBE_MODEL);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      console.log(`[whisper] attempt ${attempt}/${maxAttempts} using model=${TRANSCRIBE_MODEL}…`);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: authHeaders(),
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const json = await res.json();
        return json.text || "";
      }

      const text = await res.text();
      // Identify error flavour
      const is429 = res.status === 429;
      const is5xx = res.status >= 500;
      const insufficientQuota = is429 && /insufficient_quota/i.test(text);
      const rateLimited = is429 && !insufficientQuota; // typical "rate_limit_exceeded"

      console.warn(`[whisper] HTTP ${res.status} on attempt ${attempt}: ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`);

      // If it's a billing cap (insufficient_quota) → do not retry further; fail fast
      if (insufficientQuota) {
        throw new Error(`Whisper failed permanently: ${res.status} ${text}`);
      }

      // If it's a retryable server or rate limit error, back off
      if ((rateLimited || is5xx) && attempt < maxAttempts) {
        const backoff = jittered(800 * Math.pow(2, attempt - 1));
        console.log(`[whisper] retrying after ${backoff}ms…`);
        await sleep(backoff);
        continue;
      }

      throw new Error(`Whisper failed permanently: ${res.status} ${text}`);
    } catch (err) {
      clearTimeout(timeout);
      const isAbort = err.name === "AbortError";
      const isNetwork = /network|fetch|socket|timeout|abort/i.test(String(err));

      if ((isAbort || isNetwork) && attempt < maxAttempts) {
        const backoff = jittered(800 * Math.pow(2, attempt - 1));
        console.warn(`[whisper] network/timeout on attempt ${attempt}: ${err.message}. Retrying in ${backoff}ms…`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

// -----------------------------
// Analyse transcript with GPT-4o-mini
// -----------------------------
export async function aiAnalyse(transcript, callType = "Initial Consultation") {
  const prompt = getCombinedPrompt(callType, transcript);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
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
