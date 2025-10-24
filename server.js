// server.js (ESM, Node 20+)
// AI Call Worker: HubSpot webhook -> download recording -> Whisper transcription -> GPT analysis -> update 5 Call fields
// Now with: fast 200 response, background processing, and idempotency.

import express from 'express';

// ============ Config ============
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

if (!OPENAI_API_KEY) console.warn('[BOOT] Missing OPENAI_API_KEY');
if (!HUBSPOT_TOKEN) console.warn('[BOOT] Missing HUBSPOT_TOKEN');

// Target HubSpot properties (Call object)
const TARGET_PROPS = [
  'chat_gpt___likeliness_to_proceed_score',
  'chat_gpt___score_reasoning',
  'chat_gpt___increase_likelihood_of_sale_suggestions',
  'chat_gpt___sales_performance',
  'sales_performance_summary',
];

// In-memory guard to prevent concurrent double-processing
const processingNow = new Set();

// ============ App ============
const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/', (_req, res) => res.status(200).send('AI Call Worker up'));

// Main webhook — respond fast, then process async
app.post('/process-call', async (req, res) => {
  // 1) Extract what we need ASAP
  const body = req.body || {};
  const keys = Object.keys(body || {});
  console.log('Incoming webhook keys:', JSON.stringify(keys, null, 2));

  const props = body.properties || {};
  console.log('properties keys:', JSON.stringify(Object.keys(props || {}), null, 2));

  const valueOf = (candidate) =>
    (candidate && typeof candidate === 'object' && 'value' in candidate) ? candidate.value : candidate;
  const firstDefined = (...arr) => arr.find((v) => v !== undefined && v !== null && v !== '');

  const rawRecordingUrl = firstDefined(body.recordingUrl, props.hs_call_recording_url, props.recordingUrl);
  const rawCallId      = firstDefined(body.callId,        props.hs_object_id,           body.objectId);

  console.log('raw recordingUrl -> type:', typeof rawRecordingUrl, ', length:', String(JSON.stringify(rawRecordingUrl) || '').length);
  console.log('raw callId       -> type:', typeof rawCallId, ', length:', String(JSON.stringify(rawCallId) || '').length);

  const recordingUrl = String(valueOf(rawRecordingUrl) || '').trim();
  const callId = String(valueOf(rawCallId) || '').trim();

  console.log('resolved recordingUrl:', recordingUrl);
  console.log('resolved callId:', callId);

  // 2) Return 200 immediately so HubSpot doesn't retry
  res.status(200).json({ ok: true, accepted: Boolean(recordingUrl && callId) });

  // 3) Continue work in the background
  if (!recordingUrl || !callId) {
    console.warn('[bg] Missing recordingUrl or callId — skipping');
    return;
  }

  // Do not process same call concurrently
  if (processingNow.has(callId)) {
    console.log(`[bg] Call ${callId} already in-flight — skipping this trigger`);
    return;
  }
  processingNow.add(callId);

  // Kick off on next tick
  setImmediate(async () => {
    try {
      // ---- Idempotency: skip if already processed (any of the target fields non-empty)
      const already = await isAlreadyProcessed(callId);
      if (already) {
        console.log(`[bg] Call ${callId} already has outputs — skipping`);
        processingNow.delete(callId);
        return;
      }

      const downloadUrl = normaliseRecordingUrl(recordingUrl, callId);
      console.log('[bg] Downloading recording:', downloadUrl);
      const audioBuffer = await downloadRecording(downloadUrl);

      console.log('[bg] Transcribing...');
      const transcriptText = await transcribeAudioWithOpenAI(audioBuffer, `call_${callId}.mp3`);

      console.log('[bg] Analysing...');
      const analysisOutputs = await analyseTranscriptWithOpenAI(transcriptText);

      console.log('[bg] Uploading to HubSpot...');
      await updateHubSpotCall(callId, analysisOutputs);

      console.log('✅ [bg] Done. Updated properties for Call', callId);
    } catch (err) {
      console.error('❗ [bg] Error processing Call', callId, err);
    } finally {
      processingNow.delete(callId);
    }
  });
});

// ============ HubSpot helpers ============

// Build the downloadable URL if HubSpot uses the auth retriever pattern
function normaliseRecordingUrl(url, callId) {
  try {
    const u = new URL(url);
    const needsEngagement =
      u.pathname.includes('/getAuthRecording/') && !u.pathname.includes('/engagement/');
    if (needsEngagement && callId) {
      if (!u.pathname.endsWith('/')) u.pathname += '/';
      u.pathname += `engagement/${callId}`;
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// Auth download from HubSpot
async function downloadRecording(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.text();
    throw new Error(`Failed to download recording: ${resp.status} ${text}`);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to download recording: ${resp.status} ${text}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// Whisper transcription (OpenAI) — multipart/form-data
async function transcribeAudioWithOpenAI(buffer, filename = 'audio.mp3') {
  const form = new FormData();
  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'text'); // plain text back

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI transcription failed: ${resp.status} ${text}`);
  }
  return await resp.text();
}

// ==== ANALYSIS: build five outputs for Call properties ====
async function analyseTranscriptWithOpenAI(transcript) {
  const enforceSSAS = (text) => String(text || '').replace(/\bsaas\b/gi, 'SSAS');
  const splitBullets = (v) =>
    Array.isArray(v) ? v : String(v || '').split(/\r?\n|•|- |\u2022/).map(s => s.trim()).filter(Boolean);
  const normalizeBullets = (arr, { min = 3, max = 5, maxWords = 12 } = {}) => {
    const trimmed = arr
      .map(s => s.replace(/^[•\-\s]+/, '').trim())
      .filter(Boolean)
      .map(s => {
        const words = s.split(/\s+/);
        return words.length > maxWords ? words.slice(0, maxWords).join(' ') : s;
      });
    return trimmed.length < min ? trimmed : trimmed.slice(0, max);
  };
  const normalizeSuggestions = (arr) =>
    normalizeBullets(arr, { min: 3, max: 3, maxWords: 12 }).map(s => {
      const parts = s.split(/\s+/);
      if (!parts[0]) return s;
      parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      return parts.join(' ');
    });
  const clampScore = (val) => {
    if (typeof val === 'number' && isFinite(val)) return Math.max(1, Math.min(10, Math.round(val)));
    const m = String(val || '').match(/\b(10|[1-9])\b/);
    return m ? Math.max(1, Math.min(10, parseInt(m[1], 10))) : 5;
  };
  const cleanSummary = (txt) => String(txt || '').replace(/^[\s"']+|[\s"']+$/g, '');

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

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.1,
      top_p: 0.9,
      presence_penalty: 0,
      frequency_penalty: 0,
      messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI analysis failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '{}';

  let out;
  try { out = JSON.parse(content); } catch { out = {}; }

  // Normalise
  const likeScore = clampScore(out.likeliness_to_proceed_score);
  const perfScore = clampScore(out.sales_performance);
  const reasoning = normalizeBullets(splitBullets(out.score_reasoning), { min: 3, max: 5, maxWords: 12 });
  const suggestions = normalizeSuggestions(splitBullets(out.increase_likelihood_of_sale_suggestions));
  const summaryText = enforceSSAS(cleanSummary(out.sales_performance_summary));

  return {
    chat_gpt___likeliness_to_proceed_score: String(likeScore),
    chat_gpt___score_reasoning: reasoning.join(' • '),
    chat_gpt___increase_likelihood_of_sale_suggestions: suggestions.join(' • '),
    chat_gpt___sales_performance: String(perfScore),
    sales_performance_summary: summaryText
  };
}

// Patch Call properties via HubSpot CRM v3
async function updateHubSpotCall(callId, propertiesMap) {
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: propertiesMap })
  });

  if (resp.status === 404) {
    const text = await resp.text();
    throw new Error(`HubSpot update failed: 404 Not Found ${text}`);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HubSpot update failed: ${resp.status} ${text}`);
  }
}

// Check if already processed (any of the five fields non-empty)
async function isAlreadyProcessed(callId) {
  try {
    const params = new URLSearchParams({
      properties: TARGET_PROPS.join(',')
    });
    const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}?${params.toString()}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    if (!resp.ok) {
      console.warn(`[idempotency] GET call ${callId} failed: ${resp.status}`);
      return false; // don’t block processing if we can’t read
    }
    const json = await resp.json();
    const p = json?.properties || {};
    return TARGET_PROPS.some((k) => {
      const v = p[k];
      return v != null && String(v).trim() !== '';
    });
  } catch (e) {
    console.warn('[idempotency] error', e);
    return false;
  }
}

// ============ small prompt helpers used above ============
function enforceSSAS(text) { return String(text || '').replace(/\bsaas\b/gi, 'SSAS'); }
function splitBullets(v) { return Array.isArray(v) ? v : String(v || '').split(/\r?\n|•|- |\u2022/).map(s=>s.trim()).filter(Boolean); }
function normalizeBullets(arr, { min = 3, max = 5, maxWords = 12 } = {}) {
  const trimmed = arr
    .map(s => s.replace(/^[•\-\s]+/, '').trim())
    .filter(Boolean)
    .map(s => {
      const words = s.split(/\s+/);
      return words.length > maxWords ? words.slice(0, maxWords).join(' ') : s;
    });
  return trimmed.length < min ? trimmed : trimmed.slice(0, max);
}
function normalizeSuggestions(arr) {
  return normalizeBullets(arr, { min: 3, max: 3, maxWords: 12 }).map(s => {
    const parts = s.split(/\s+/);
    if (!parts[0]) return s;
    parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    return parts.join(' ');
  });
}
function clampScore(val) {
  if (typeof val === 'number' && isFinite(val)) return Math.max(1, Math.min(10, Math.round(val)));
  const m = String(val || '').match(/\b(10|[1-9])\b/);
  return m ? Math.max(1, Math.min(10, parseInt(m[1], 10))) : 5;
}
function cleanSummary(txt) { return String(txt || '').replace(/^[\s"']+|[\s"']+$/g, ''); }

// ============ Start ============
app.listen(PORT, () => {
  console.log(`AI Call Worker listening on :${PORT}`);
});
