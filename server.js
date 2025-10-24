// server.js (ESM, Node 20+)
// AI Call Worker: HubSpot webhook -> download recording -> Whisper transcription -> GPT analysis -> update 5 Call fields
// Includes: async background work, idempotency guard, retry logic for OpenAI calls.

import express from "express";

// ====== Config ======
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!OPENAI_API_KEY) console.warn("[BOOT] Missing OPENAI_API_KEY");
if (!HUBSPOT_TOKEN) console.warn("[BOOT] Missing HUBSPOT_TOKEN");

// Target HubSpot fields
const TARGET_PROPS = [
  "chat_gpt___likeliness_to_proceed_score",
  "chat_gpt___score_reasoning",
  "chat_gpt___increase_likelihood_of_sale_suggestions",
  "chat_gpt___sales_performance",
  "sales_performance_summary",
];

// Prevent concurrent duplicates
const processingNow = new Set();

// ====== Helper: fetch with retry ======
async function fetchWithRetry(makeRequest, { retries = 3, baseDelayMs = 600 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await makeRequest();
      if (resp.ok) return resp;

      const retriable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
      if (!retriable || attempt === retries) {
        let text = "";
        try {
          text = await resp.text();
        } catch {}
        throw new Error(`HTTP ${resp.status} ${text}`);
      }
    } catch (err) {
      if (attempt === retries) throw err;
    }
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
    console.log(`[retry] attempt ${attempt + 1}/${retries} — waiting ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error("fetchWithRetry exhausted");
}

// ====== Express app ======
const app = express();
app.use(express.json({ limit: "25mb" }));
app.get("/", (_req, res) => res.status(200).send("AI Call Worker up"));

// ====== Webhook ======
app.post("/process-call", async (req, res) => {
  const body = req.body || {};
  const props = body.properties || {};
  const valueOf = (c) => (c && typeof c === "object" && "value" in c ? c.value : c);
  const firstDefined = (...arr) => arr.find((v) => v != null && v !== "");

  const rawRecordingUrl = firstDefined(body.recordingUrl, props.hs_call_recording_url);
  const rawCallId = firstDefined(body.callId, props.hs_object_id, body.objectId);

  const recordingUrl = String(valueOf(rawRecordingUrl) || "").trim();
  const callId = String(valueOf(rawCallId) || "").trim();
  console.log("resolved recordingUrl:", recordingUrl);
  console.log("resolved callId:", callId);

  res.status(200).json({ ok: true, accepted: Boolean(recordingUrl && callId) });
  if (!recordingUrl || !callId) return;

  if (processingNow.has(callId)) {
    console.log(`[bg] Call ${callId} already in-flight`);
    return;
  }
  processingNow.add(callId);

  setImmediate(async () => {
    try {
      if (await isAlreadyProcessed(callId)) {
        console.log(`[bg] Call ${callId} already processed`);
        processingNow.delete(callId);
        return;
      }

      const url = normaliseRecordingUrl(recordingUrl, callId);
      console.log("[bg] Downloading recording:", url);
      const audio = await downloadRecording(url);

      console.log("[bg] Transcribing...");
      const transcript = await transcribeAudioWithOpenAI(audio, `call_${callId}.mp3`);

      console.log("[bg] Analysing...");
      const outputs = await analyseTranscriptWithOpenAI(transcript);

      console.log("[bg] Uploading to HubSpot...");
      await updateHubSpotCall(callId, outputs);

      console.log("✅ [bg] Done", callId);
    } catch (err) {
      console.error("❗ [bg] Error", callId, err);
    } finally {
      processingNow.delete(callId);
    }
  });
});

// ====== Core helpers ======
function normaliseRecordingUrl(url, callId) {
  try {
    const u = new URL(url);
    if (u.pathname.includes("/getAuthRecording/") && !u.pathname.includes("/engagement/")) {
      if (!u.pathname.endsWith("/")) u.pathname += "/";
      u.pathname += `engagement/${callId}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function downloadRecording(url) {
  const resp = await fetchWithRetry(() => fetch(url, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }));
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function transcribeAudioWithOpenAI(buffer, filename) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: "audio/mpeg" });
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  form.append("response_format", "text");

  const resp = await fetchWithRetry(() =>
    fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    })
  );
  return await resp.text();
}

// ====== GPT analysis ======
async function analyseTranscriptWithOpenAI(transcript) {
  const enforceSSAS = (t) => String(t || "").replace(/\bsaas\b/gi, "SSAS");
  const systemMsg =
    'You are TLPI’s transcript analysis bot. Follow rubrics exactly. Use glossary: "SSAS"=Small Self-Administered Scheme.';
  const userMsg =
    `Analyse the following transcript and produce JSON with:\n` +
    `likeliness_to_proceed_score (1–10), score_reasoning (3–5 bullets), increase_likelihood_of_sale_suggestions (3 bullets), ` +
    `sales_performance (1–10), sales_performance_summary (plain text). Transcript:\n` +
    enforceSSAS(transcript);

  const resp = await fetchWithRetry(() =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [{ role: "system", content: systemMsg }, { role: "user", content: userMsg }],
      }),
    })
  );

  const data = await resp.json();
  const out = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  const clean = (x) => String(x || "").trim();

  return {
    chat_gpt___likeliness_to_proceed_score: clean(out.likeliness_to_proceed_score || 5),
    chat_gpt___score_reasoning: Array.isArray(out.score_reasoning)
      ? out.score_reasoning.join(" • ")
      : clean(out.score_reasoning),
    chat_gpt___increase_likelihood_of_sale_suggestions: Array.isArray(out.increase_likelihood_of_sale_suggestions)
      ? out.increase_likelihood_of_sale_suggestions.join(" • ")
      : clean(out.increase_likelihood_of_sale_suggestions),
    chat_gpt___sales_performance: clean(out.sales_performance || 5),
    sales_performance_summary: clean(out.sales_performance_summary),
  };
}

async function updateHubSpotCall(callId, propertiesMap) {
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`;
  await fetchWithRetry(() =>
    fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: propertiesMap }),
    })
  );
}

async function isAlreadyProcessed(callId) {
  try {
    const params = new URLSearchParams({ properties: TARGET_PROPS.join(",") });
    const resp = await fetch(`https://api.hubapi.com/crm/v3/objects/calls/${callId}?${params}`, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    if (!resp.ok) return false;
    const json = await resp.json();
    const p = json?.properties || {};
    return TARGET_PROPS.some((k) => {
      const v = p[k];
      return v != null && String(v).trim() !== "";
    });
  } catch {
    return false;
  }
}

// ====== Start ======
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
