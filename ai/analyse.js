// ai/analyse.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import { getCombinedPrompt } from "./getCombinedPrompt.js";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_TOKEN;
const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // small + cheap; change if you want

function headers() {
  return { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" };
}

/**
 * Public API:
 * analyseTranscript(callType, transcript) -> analysis object
 *   Guaranteed keys (even if heuristics are used):
 *   - call_type: "Initial Consultation"
 *   - likelihood_to_close: 0..100
 *   - outcome: Proceed now | Likely | Unclear | Not now | No fit
 *   - objections: string[]
 *   - next_actions: string[]
 *   - materials_to_send: string[]
 *   - key_details: { client_name?, company_name?, products_discussed?: string[], timeline?, dob?, ni?, nino?, address? }
 *   - ai_decision_criteria?: string[]
 *   - sales_performance_rating?: 1..10 (integer)
 *   - sales_performance_summary?: string (bullets)
 *   - consult_eval: { 20 named booleans or 0/1-ish numbers for the `consult_*` mapping }
 */
export async function analyseTranscript(callType, transcript) {
  const cleanTranscript = String(transcript || "").trim();

  // Hard guard for blank/muted calls
  if (!hasMeaningfulContent(cleanTranscript)) {
    return {
      call_type: "Initial Consultation",
      likelihood_to_close: 0,
      outcome: "Unclear",
      objections: [],
      next_actions: [],
      materials_to_send: [],
      key_details: {},
      ai_decision_criteria: [],
      sales_performance_rating: 1,
      sales_performance_summary: "What went well:\n- N/A\n\nAreas to improve:\n- Call contained no meaningful audio.",
      consult_eval: {},
      uncertainty_reason: "Transcript contains no meaningful content."
    };
  }

  const sysAndUser = await getCombinedPrompt(callType || "Initial Consultation", cleanTranscript);

  // Strict JSON schema request to force the exact fields we need for IC
  const icJsonSystem = `
You are TLPI’s AI Call Analyst. Return a STRICT JSON object compliant with this schema (no prose outside JSON):

{
  "call_type": "Initial Consultation",
  "likelihood_to_close": <integer 0-100>,
  "outcome": "Proceed now"|"Likely"|"Unclear"|"Not now"|"No fit",
  "objections": [<short strings>],
  "next_actions": [<short actionable steps>],
  "materials_to_send": [<documents/information promised>],
  "key_details": {
    "client_name": <string|null>,
    "company_name": <string|null>,
    "products_discussed": ["SSAS"|"FIC"|"Both"|<other>],
    "timeline": <string|null>,
    "dob": <string|null>,
    "ni": <string|null>,
    "nino": <string|null>,
    "address": <string|null>
  },
  "ai_decision_criteria": [<short strings>],
  "sales_performance_rating": <integer 1..10>,
  "sales_performance_summary": <string>,
  "consult_eval": {
    "intro": 0|0.5|1,
    "rapport_open": 0|0.5|1,
    "open_question": 0|0.5|1,
    "needs_pain_uncovered": 0|0.5|1,
    "services_explained_clearly": 0|0.5|1,
    "benefits_linked_to_needs": 0|0.5|1,
    "active_listening": 0|0.5|1,
    "clear_responses_or_followup": 0|0.5|1,
    "commitment_requested": 0|0.5|1,
    "next_steps_confirmed": 0|0.5|1,
    "specific_tax_estimate_given": 0|0.5|1,
    "fees_tax_deductible_explained": 0|0.5|1,
    "next_step_specific_date_time": 0|0.5|1,
    "interactive_throughout": 0|0.5|1,
    "quantified_value_roi": 0|0.5|1
  }
}
Important:
- If the client agrees/buys/books/signs, set outcome="Proceed now" and likelihood_to_close close to 100.
- If no objections, return [] for "objections".
- "sales_performance_summary" must follow the bullet format already provided in TLPI prompt files.
`;

  const body = {
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: icJsonSystem },
      ...sysAndUser // company + call-type context from your md files, then transcript
    ],
    response_format: { type: "json_object" }
  };

  let ai = null;
  try {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const js = await res.json();
    const content = js?.choices?.[0]?.message?.content;
    ai = safeParseJSON(content);
  } catch (e) {
    console.warn("[ai] model request failed, falling back to heuristics:", e.message);
  }

  // Merge with fallbacks from transcript, so we never leave key areas blank
  const merged = applyHeuristics(cleanTranscript, ai || {});

  // Final outcome guard-rail: explicit proceed/bought mentions => Proceed now + 100
  if (detectProceedNow(cleanTranscript)) {
    merged.outcome = "Proceed now";
    merged.likelihood_to_close = Math.max(merged.likelihood_to_close || 0, 100);
    merged.sales_performance_rating = Math.max(merged.sales_performance_rating || 1, 8); // sensible floor if closed now
  }

  return merged;
}

/* ============================== heuristics ============================== */

function hasMeaningfulContent(t) {
  if (!t) return false;
  const words = t.replace(/\s+/g, " ").trim().split(" ");
  return words.length > 8; // tiny threshold
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function detectProceedNow(text) {
  const s = text.toLowerCase();
  return /\b(agree|agreed|go ahead|proceed|sign|signed|purchase|bought|payment|paid|onboard|set[-\s]?up|application submitted|book(ed)?( in)?|deposit)\b/.test(s);
}

function guessProductInterest(text) {
  const s = text.toLowerCase();
  const ssas = /ssas|small self(-|\s)administered/i.test(s);
  const fic = /\bfic\b|family investment compan(y|ies)/i.test(s);
  if (ssas && fic) return ["Both"];
  if (ssas) return ["SSAS"];
  if (fic) return ["FIC"];
  return [];
}

function extractNextActions(text) {
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const picks = [];
  for (const ln of lines) {
    if (/next step|we will|we'll|i will|i'll|you will|send|book|schedule|arrange|follow up/i.test(ln)) {
      picks.push(ln.replace(/^[\-\*\d\.\)]\s*/, "").slice(0, 200));
    }
    if (picks.length >= 5) break;
  }
  return picks;
}

function extractMaterials(text) {
  const picks = [];
  const m = text.toLowerCase().match(/\b(send|email|share|forward)\b.+?(document|pack|agreement|proposal|brochure|info|information|forms?|paperwork)/g);
  if (m) for (const mm of m) picks.push(mm.slice(0, 200));
  return picks;
}

function extractDecisionCriteria(text) {
  const crit = [];
  const s = text.toLowerCase();
  if (/fee|cost|price|charges?/.test(s)) crit.push("Fees/Cost");
  if (/timeline|speed|quick|delay|month|week/.test(s)) crit.push("Timeline");
  if (/hmrc|compliance|tax|rules?/.test(s)) crit.push("Compliance/Tax");
  if (/return|roi|cashflow|saving/i.test(s)) crit.push("ROI/Cashflow");
  if (/platform|provider|trust|previous/.test(s)) crit.push("Provider/Platform");
  return Array.from(new Set(crit));
}

function extractObjections(text) {
  const out = [];
  const s = text.toLowerCase();
  if (/fee|cost|price/.test(s)) out.push("Fees/cost");
  if (/time|timeline|delay|month|week/.test(s)) out.push("Timeline");
  if (/hmrc|compliance|tax|rules?/.test(s)) out.push("Compliance/Tax");
  if (/risk|volatile|uncertain/.test(s)) out.push("Risk");
  if (/trust|provider|previous/.test(s)) out.push("Provider/Trust");
  return out;
}

function extractDataPoints(text) {
  const items = [];
  const dob = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/i);
  const nino = text.match(/\b([A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]?)\b/i); // UK NI-ish
  const addr = text.match(/\b(\d+\s+.+(road|rd|street|st|avenue|ave|lane|ln|close|cl|drive|dr|way|place|pl|court|ct))\b/i);
  if (dob) items.push(`DOB: ${dob[1]}`);
  if (nino) items.push(`NI: ${nino[1]}`);
  if (addr) items.push(`Address: ${addr[1]}`);
  return items;
}

function applyHeuristics(text, ai) {
  const out = {
    call_type: "Initial Consultation",
    likelihood_to_close: clampInt(ai?.likelihood_to_close ?? 50, 0, 100),
    outcome: ai?.outcome || "Unclear",
    objections: Array.isArray(ai?.objections) ? ai.objections : [],
    next_actions: Array.isArray(ai?.next_actions) ? ai.next_actions : [],
    materials_to_send: Array.isArray(ai?.materials_to_send) ? ai.materials_to_send : [],
    key_details: ai?.key_details || {},
    ai_decision_criteria: Array.isArray(ai?.ai_decision_criteria) ? ai.ai_decision_criteria : [],
    sales_performance_rating: clampInt(ai?.sales_performance_rating ?? 5, 1, 10),
    sales_performance_summary: String(ai?.sales_performance_summary || "").trim(),
    consult_eval: ai?.consult_eval || {}
  };

  // product interest, if missing
  if (!out.key_details?.products_discussed || out.key_details.products_discussed.length === 0) {
    const pi = guessProductInterest(text);
    out.key_details.products_discussed = pi;
  }

  // next actions/materials/decision criteria fallbacks
  if (out.next_actions.length === 0) out.next_actions = extractNextActions(text);
  if (out.materials_to_send.length === 0) out.materials_to_send = extractMaterials(text);
  if (out.ai_decision_criteria.length === 0) out.ai_decision_criteria = extractDecisionCriteria(text);

  // objections fallback
  if (out.objections.length === 0) out.objections = extractObjections(text);

  // data points captured
  const dataPoints = [];
  const kd = out.key_details || {};
  if (kd.client_name) dataPoints.push(`Name: ${kd.client_name}`);
  if (kd.company_name) dataPoints.push(`Company: ${kd.company_name}`);
  const dp = extractDataPoints(text);
  dataPoints.push(...dp);
  out.key_details = { ...kd }; // keep structure
  out.__data_points_captured_text = dataPoints.join("\n");

  // If the model didn’t provide a performance summary, build a tiny one
  if (!out.sales_performance_summary) {
    out.sales_performance_summary = "What went well:\n- Clear rapport.\n\nAreas to improve:\n- Ask for a commitment.\n- Confirm next step & date.";
  }

  // Likelihood sanity: if next action + specific date/time or proceed-like language => push up
  if (detectProceedNow(text)) {
    out.likelihood_to_close = Math.max(out.likelihood_to_close, 95);
    out.outcome = "Proceed now";
  }

  return out;
}

function clampInt(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
