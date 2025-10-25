// ai/analyse.js
// Core analysis + transcription logic for AI Call Worker
// ------------------------------------------------------
// Handles transcription via OpenAI Whisper with robust retry & timeout logic
// Then returns structured text for downstream analysis in HubSpot flow.

import fs from "fs";
import FormData from "form-data";

const TRANSCRIBE_MODEL = process.env.WHISPER_MODEL || "whisper-1";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  };
}

/**
 * Transcribe a local audio file using OpenAI Whisper.
 * Automatically retries on transient network or 429/5xx errors.
 * Each attempt has a 300-second timeout to handle slow uploads.
 */
export async function transcribeFile(filePath) {
  const maxAttempts = 5;
  let attempt = 0;

  while (true) {
    attempt += 1;

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    form.append("model", TRANSCRIBE_MODEL);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 300s per attempt

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
      const is429 = res.status === 429;
      const is5xx = res.status >= 500;
      const insufficientQuota = is429 && /insufficient_quota/i.test(text);
      const rateLimited = is429 && !insufficientQuota;

      console.warn(`[whisper] HTTP ${res.status} on attempt ${attempt}: ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`);

      if (insufficientQuota) {
        throw new Error(`Whisper failed permanently: ${res.status} ${text}`);
      }

      if ((rateLimited || is5xx) && attempt < maxAttempts) {
        const backoff = Math.round(800 * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4));
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
        const backoff = Math.round(800 * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4));
        console.warn(`[whisper] network/timeout on attempt ${attempt}: ${err.message}. Retrying in ${backoff}ms…`);
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }
}

/**
 * Perform structured AI analysis on transcript text.
 * (Your downstream logic can call this after transcribeFile.)
 */
export async function analyseTranscript(callType, transcript) {
  return {
    callType,
    transcript,
    // Placeholder for now – replaced with AI analysis logic in your pipeline
  };
}
