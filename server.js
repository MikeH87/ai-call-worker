// server.js (ESM, Node 20+)
// AI Call Worker: HubSpot webhook -> download recording (HubSpot or Zoom) -> Whisper transcription -> GPT analysis -> update 5 Call fields
// Features: fast 200 OK, background processing, idempotency, retry logic, Zoom auth support.

import express from "express";

// ====== Config ======
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// Optional for Zoom downloads (use ONE of these if your Zoom links aren’t public)
const ZOOM_ACCESS_TOKEN = process.env.ZOOM_ACCESS_TOKEN;   // appended as ?access_token=...
const ZOOM_BEARER_TOKEN = process.env.ZOOM_BEARER_TOKEN;   // Authorization: Bearer ...

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
        try { text = await resp.text(); } catch {}
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

  // 200 immediately to stop HubSpot retries
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
  // HubSpot auth retriever -> ensure /engagement/{id}
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("hubspot.com") && u.pathname.includes("/getAuthRecording/") && !u.pathname.includes("/engagement/")) {
      if (!u.pathname.endsWith("/")) u.pathname += "/";
      u.pathname += `engagement/${callId}`;
      return u.toString();
    }
  } catch {}
  return url;
}

function isZoomUrl(url) {
  try { return new URL(url).hostname.includes("zoom.us"); } catch { return false; }
}

function withZoomAuth(url) {
  // If you have ZOOM_ACCESS_TOKEN, add ?access_token=...
  // Else if you have ZOOM_BEARER_TOKEN, we’ll send Authorization header separately.
  try {
    const u = new URL(url);
    if (ZOOM_ACCESS_TOKEN && !u.searchParams.has("access_token")) {
      u.searchParams.set("access_token", ZOOM_ACCESS_TOKEN);
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function downloadRecording(url) {
  // HubSpot downloads always require HubSpot token; Zoom may require Zoom auth.
  const u = new URL(url);
  let headers = {};

  if (u.hostname.endsWith("hubspot.com")) {
    headers = { Authorization: `Bearer ${HUBSPOT_TOKEN}` };
  } else if (isZoomUrl(url)) {
    // If the Zoom link is public, no auth is needed. If it's not public:
    // - Prefer ?access_token=... via ZOOM_ACCESS_TOKEN
    // - Or send Authorization: Bearer <token> via ZOOM_BEARER_TOKEN
    url = withZoomAuth(url);
    if (ZOOM_BEARER_TOKEN) {
      headers = { Authorization: `Bearer ${ZOOM_BEARER_TOKEN}` };
    }
  }

  const resp = await fetchWithRetry(() => fetch(url, { headers }));
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// Whisper transcription (OpenAI)
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

  const PROMPT_SALES_PERF_SUMMARY =
    'You are evaluating a sales call transcript against this scorecard:\n\n' +
    'Opening & Rapport\n' +
    '1. Clear, professional intro?\n' +
    '2. Early rapport/trust attempt?\n\n' +
    'Discovery & Qualification\n' +
    '3. Open-ended question to understand needs?\n' +
    '4. Identified pain/opportunity re: corp/business tax/inheritance tax or loaning money to prospect’s business?\n\n' +
    'Value Positioning\n' +
    '5. Explained firm’s services clearly and simply?\n' +
    '6. Connected benefits to client’s specific needs?\n\n' +
    'Handling Concerns\n' +
    '7. Active listening and acknowledged concerns/questions?\n' +
    '8. Clear, confident responses (follow-up if needed)?\n\n' +
    'Closing & Next Steps\n' +
    '9. Asked for a commitment (next meeting/docs/proposal)?\n' +
    '10. Confirmed clear next steps\n\n' +
    'Return a short plain text summary in bullet points.\n\n' +
    'Rules:\n' +
    '- Maximum of 4 bullets total.\n' +
    '- Prioritise "Areas to improve" if more important.\n' +
    '- Each bullet ≤10 words.\n' +
    '- Use this exact format (plain text, no JSON, no arrays):\n\n' +
    'What went well:\n' +
    '- [bullet(s)]\n\n' +
    'Areas to improve:\n' +
    '- [bullet(s)]\n';

  const PROMPT_SALES_PERF_RATING =
    'EVALUATE THE CONSULTANT USING THIS DETERMINISTIC RUBRIC:\n\n' +
    'For each of the 10 criteria below, assign:\n' +
    '- 1 = clearly met (explicit evidence in transcript)\n' +
    '- 0.5 = partially met (some evidence but incomplete)\n' +
    '- 0 = not met / absent / ambiguous\n\n' +
    'Criteria (same order):\n' +
    '1) Clear, professional intro\n' +
    '2) Early rapport/trust attempt\n' +
    '3) At least one open-ended question for needs\n' +
    '4) Pain/opportunity relevant to corp/business tax/IHT/funding identified\n' +
    '5) Services explained clearly, simply\n' +
    '6) Benefits connected to client’s specific needs\n' +
    '7) Active listening & acknowledgment of concerns\n' +
    '8) Clear, confident responses (or committed follow-up)\n' +
    '9) Asked for a commitment (next meeting/docs/proposal)\n' +
    '10) Confirmed clear next steps\n\n' +
    'SCORE = sum of the 10 items (0..10 in 0.5 increments), then round to nearest integer (0.5 rounds up). If final <1, output 1.\n\n' +
    'Output ONLY the integer 1..10 (no words).\n';

  const PROMPT_LIKELIHOOD_SCORE =
    'EVALUATE LIKELIHOOD TO PROCEED USING THIS DETERMINISTIC RUBRIC (0..10):\n\n' +
    'Signals and weights:\n' +
    'A) Explicit interest in TLPI services (0..3)\n' +
    'B) Pain/urgency/motivation (0..3)\n' +
    'C) Engagement/detail & responsiveness (0..2)\n' +
    'D) Next-step commitment (0..2)\n\n' +
    'SCORE = A+B+C+D. Clamp to 1..10 (if 0, output 1). Output ONLY the integer (no words).\n' +
    'Consider only transcript evidence.\n';

  const PROMPT_SCORE_REASONING =
    'Apply the same likelihood rubric you just used and explain WHY the chosen score fits the transcript.\n\n' +
    'Output RULES:\n' +
    '- 3–5 short bullets (≤12 words each)\n' +
    '- Mention both positive and negative signals where relevant\n' +
    '- Each bullet must reference concrete transcript evidence (no generic language)\n';

  const PROMPT_SUGGESTIONS =
    'Provide transcript-specific suggestions to increase conversion at the Zoom stage.\n\n' +
    'STRICT RULES:\n' +
    '- EXACTLY 3 bullets\n' +
    '- Each bullet ≤12 words\n' +
    '- Start with an imperative verb (e.g., "Quantify", "Confirm", "Show", "Send", "Prepare")\n' +
    '- Tie each bullet to specific statements/concerns in the transcript\n' +
    '- No generic coaching unless explicitly indicated by transcript\n' +
    '- Plain text bullets only (no sub-bullets, no numbering)\n';

  const systemMsg =
    'You are TLPI’s transcript analysis bot. Follow rubrics exactly. ' +
    'Use the following glossary strictly: "SSAS" refers to Small Self-Administered Scheme. ' +
    'Never write "saas" (software as a service). Always use "SSAS". ' +
    'Return ONLY valid JSON. No extra text.';

  const userMsg =
    'You will analyze ONE transcript and produce FIVE outputs as if each prompt were run separately.\n' +
    'Base everything ONLY on the transcript. Keep outputs concise. Follow the rubrics exactly for consistent scoring.\n' +
    'Glossary: Always use "SSAS" (Small Self-Administered Scheme); never "saas".\n\n' +
    'Transcript:\n' + enforceSSAS(transcript) + '\n\n' +
    'Return ONLY valid JSON with EXACT keys:\n' +
    '{\n' +
    '  "likeliness_to_proceed_score": <integer 1-10>,\n' +
    '  "score_reasoning": ["<bullet>", "<bullet>", "<bullet>"],\n' +
    '  "increase_likelihood_of_sale_suggestions": ["<bullet>", "<bullet>", "<bullet>"],\n' +
    '  "sales_performance": <integer 1-10>,\n' +
    '  "sales_performance_summary": "<plain text with \'What went well\' and \'Areas to improve\' bullets; no JSON>"\n' +
    '}\n\n' +
    '- likeliness_to_proceed_score:\n' + PROMPT_LIKELIHOOD_SCORE + '\n\n' +
    '- score_reasoning:\n' + PROMPT_SCORE_REASONING + '\n\n' +
    '- increase_likelihood_of_sale_suggestions:\n' + PROMPT_SUGGESTIONS + '\n\n' +
    '- sales_performance:\n' + PROMPT_SALES_PERF_RATING + '\n\n' +
    '- sales_performance_summary:\n' + PROMPT_SALES_PERF_SUMMARY + '\n\n' +
    'Rules:\n' +
    '- "likeliness_to_proceed_score" and "sales_performance" MUST be integers 1..10 (no words).\n' +
    '- "score_reasoning" MUST be 3–5 short bullets (list/array).\n' +
    '- "increase_likelihood_of_sale_suggestions" MUST be EXACTLY 3 bullets (list/array).\n' +
    '- "sales_performance_summary" MUST be plain text in the specified format (no JSON).\n' +
    '- Do not invent details; use only transcript evidence.\n';

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
  const content = data?.choices?.[0]?.message?.content || "{}";

  let out; try { out = JSON.parse(content); } catch { out = {}; }
  const clean = (x) => String(x || "").trim();
  const toBullets = (v) => Array.isArray(v) ? v.join(" • ") : clean(v);

  return {
    chat_gpt___likeliness_to_proceed_score: clean(out.likeliness_to_proceed_score || 5),
    chat_gpt___score_reasoning: toBullets(out.score_reasoning),
    chat_gpt___increase_likelihood_of_sale_suggestions: toBullets(out.increase_likelihood_of_sale_suggestions),
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

// ====== Small text helpers ======
function enforceSSAS(text) { return String(text || "").replace(/\bsaas\b/gi, "SSAS"); }

// ====== Start ======
app.listen(PORT, () => console.log(`AI Call Worker listening on :${PORT}`));
