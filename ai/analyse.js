// ai/analyse.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import { getCombinedPrompt } from "./getCombinedPrompt.js";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_TOKEN;
const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function headers() {
  return { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" };
}

export async function analyseTranscript(callType, transcript) {
  const cleanTranscript = String(transcript || "").trim();

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

  // Strict JSON schema + IC rules
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
    "address": <string|null>,
    "utr": <string|null>,
    "nationality": <string|null>,
    "pension_refs": <string|null>,
    "company_details": <string|null>
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

STRICT ACCURACY
- Never invent. If not stated, use empty arrays or short “Not mentioned.” style text.
- Keep lists concise (≤ 12 words per item).

PROCEED NOW
- ONLY when the prospect agrees to sign the TLPI Client Agreement during/after the call (explicit or unambiguous wording about signing the client agreement).
- Ignore payment/card/DocuSign phrasing (not used by TLPI).
- Consider sentiment to raise likelihood_to_close, but do not mark “Proceed now” without the agreement-to-sign language.

DECISION CRITERIA (canonical)
- Fees/Cost, Timeline/Speed, Compliance/Tax/HMRC, ROI/Cashflow/Savings, Provider/Platform/Trust

MATERIALS (examples)
- “Client Agreement”, “Fee Schedule”, “SSAS Setup Pack”, “KYC – ID & Address”

NEXT STEPS
- Concrete actions with actor + action + when if stated.

SALES PERFORMANCE
- The summary must follow TLPI’s 2-section bullet format, ≤4 bullets total, ≤10 words each.

`.trim();

  // 1) Gather context messages safely from getCombinedPrompt
  let combined = await getCombinedPrompt(callType || "Initial Consultation", cleanTranscript);
  let ctxMessages = [];
  if (Array.isArray(combined)) {
    ctxMessages = combined;
  } else if (combined && typeof combined === "object" && Array.isArray(combined.messages)) {
    ctxMessages = combined.messages;
  } else if (typeof combined === "string") {
    ctxMessages = [{ role: "system", content: combined }, { role: "user", content: cleanTranscript }];
  } else {
    ctxMessages = [{ role: "system", content: "TLPI Initial Consultation analysis." }, { role: "user", content: cleanTranscript }];
  }

  // 2) Call model with strict JSON response_format
  const body = {
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: icJsonSystem },
      ...ctxMessages
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

  // 3) Merge with robust heuristics/fallbacks so we never leave critical fields blank
  const merged = applyHeuristics(cleanTranscript, ai || {});

  // 4) Final: “Proceed now” detection strictly on client-agreement wording
  const agreedToSign = detectClientAgreementSign(cleanTranscript);
  if (agreedToSign) {
    merged.outcome = "Proceed now";
    merged.likelihood_to_close = Math.max(merged.likelihood_to_close || 0, 100);
    merged.sales_performance_rating = Math.max(merged.sales_performance_rating || 1, 8); // floor 8/10
  } else {
    // Positive sentiment can push likelihood but not mark “Proceed now”
    if (detectPositiveSentiment(cleanTranscript)) {
      merged.likelihood_to_close = Math.max(merged.likelihood_to_close, 70);
    }
  }

  return merged;
}

/* ============================== heuristics ============================== */

function hasMeaningfulContent(t) {
  if (!t) return false;
  const words = t.replace(/\s+/g, " ").trim().split(" ");
  return words.length > 8;
}
function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function clampInt(n, lo, hi) { const v=Number(n); if(!Number.isFinite(v)) return lo; return Math.max(lo, Math.min(hi, Math.round(v))); }
function numberOrNull(v){ if(v==null) return null; const n=Number(v); return Number.isFinite(n) ? n : null; }

/** Strict “Proceed now”: agreement to sign the TLPI Client Agreement */
function detectClientAgreementSign(text) {
  const s = text.toLowerCase();
  // phrases around signing the client agreement
  const patterns = [
    /sign(ing)? (the )?client agreement/,
    /\bi('ll| will)? sign (the )?client agreement\b/,
    /\bagree(d)? to sign (the )?client agreement\b/,
    /\b(happy|keen|ready)\s+to\s+sign (the )?client agreement\b/,
    /\bi('m| am)\s+going\s+to\s+sign (the )?client agreement\b/,
  ];
  return patterns.some(rx => rx.test(s));
}

/** Positive but not decisive sentiment — used to bump likelihood only */
function detectPositiveSentiment(text) {
  const s = text.toLowerCase();
  return /\b(keen|happy|confident|comfortable|makes sense|sounds good|let's proceed|let us proceed|go ahead)\b/.test(s);
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
    if (/\b(next step|we will|we'll|i will|i'll|you will|send|book|schedule|arrange|follow up|set up|sign|agree)\b/i.test(ln)) {
      picks.push(normaliseLine(ln));
    }
    if (picks.length >= 5) break;
  }
  return uniqueShort(picks);
}

function extractMaterials(text) {
  const s = text.toLowerCase();
  const picks = [];
  // Normalise to preferred labels
  if (/\b(client|agreement)\b/.test(s)) picks.push("Client Agreement");
  if (/\bfee(s)?\b/.test(s)) picks.push("Fee Schedule");
  if (/\bsetup pack|setup info|pack\b/.test(s)) picks.push("SSAS Setup Pack");
  if (/\bkyc|id\b/.test(s) || /proof of (id|address)/.test(s)) picks.push("KYC – ID & Address");
  // Also capture general “send/share/forward … document/info/pack” phrases
  const m = s.match(/\b(send|email|share|forward)\b.+?(document|pack|agreement|proposal|brochure|info|information|forms?|paperwork)/g);
  if (m) for (const mm of m) picks.push(capitalise(normaliseLine(mm)));
  return uniqueShort(picks);
}

function extractDecisionCriteria(text) {
  const crit = [];
  const s = text.toLowerCase();
  if (/fee|cost|price|charges?/.test(s)) crit.push("Fees/Cost");
  if (/timeline|speed|quick|delay|month|week/.test(s)) crit.push("Timeline/Speed");
  if (/hmrc|compliance|tax|rules?/.test(s)) crit.push("Compliance/Tax/HMRC");
  if (/return|roi|cashflow|saving/i.test(s)) crit.push("ROI/Cashflow/Savings");
  if (/platform|provider|trust|previous/.test(s)) crit.push("Provider/Platform/Trust");
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

/** Expanded personal data & identifiers */
function extractDataPoints(text) {
  const s = text;
  const items = [];

  // DOB: 12/09/1983 or 12-09-83
  const dob = s.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
  if (dob) items.push(`DOB: ${dob[1]}`);

  // NI/NINO (best-effort)
  const nino = s.match(/\b([A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]?)\b/i);
  if (nino) items.push(`NI: ${nino[1]}`);

  // UTR / personal tax reference
  const utrLine = s.match(/\b(utr|personal tax reference|tax reference)\b[:\-\s]*([A-Za-z0-9]{6,12})/i);
  if (utrLine) items.push(`UTR: ${utrLine[2]}`);

  // Nationality (simple grab if mentioned like "I'm British", "Nationality British")
  const nationality = s.match(/\bnationality\b[:\-\s]*([A-Za-z ]{4,30})/i);
  if (nationality) items.push(`Nationality: ${nationality[1].trim()}`);

  // Address line (rough UK-ish)
  const addr = s.match(/\b(\d+\s+[A-Za-z0-9\.\- ]+ (road|rd|street|st|avenue|ave|lane|ln|close|cl|drive|dr|way|place|pl|court|ct))\b/i);
  if (addr) items.push(`Address: ${addr[1]}`);

  // Pension reference / plan numbers
  const pens = s.match(/\b(pension|plan|policy|scheme)\s*(ref(erence)?|number|no\.?)?\b[:\-\s]*([A-Za-z0-9\-]{5,})/i);
  if (pens) items.push(`Pension ref: ${pens[4]}`);

  // Company details (basic)
  const ltd = s.match(/\b([A-Z][A-Za-z0-9&\',\. ]+ (ltd|limited))\b/i);
  if (ltd) items.push(`Company: ${ltd[1]}`);

  return uniqueShort(items, 8);
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

  // Product interest fallback
  if (!out.key_details?.products_discussed || out.key_details.products_discussed.length === 0) {
    const pi = guessProductInterest(text);
    out.key_details.products_discussed = pi;
  }

  // Lists: next actions / materials / decision criteria / objections
  if (out.next_actions.length === 0) out.next_actions = extractNextActions(text);
  if (out.materials_to_send.length === 0) out.materials_to_send = extractMaterials(text);
  if (out.ai_decision_criteria.length === 0) out.ai_decision_criteria = extractDecisionCriteria(text);
  if (out.objections.length === 0) out.objections = extractObjections(text);

  // Personal data points: merge explicit from AI plus regex
  const kd = out.key_details || {};
  const dp = extractDataPoints(text);
  const dpLines = [];

  if (kd.client_name) dpLines.push(`Name: ${kd.client_name}`);
  if (kd.company_name) dpLines.push(`Company: ${kd.company_name}`);
  if (kd.address) dpLines.push(`Address: ${kd.address}`);
  if (kd.dob) dpLines.push(`DOB: ${kd.dob}`);
  if (kd.ni || kd.nino) dpLines.push(`NI: ${kd.ni || kd.nino}`);
  if (kd.utr) dpLines.push(`UTR: ${kd.utr}`);
  if (kd.nationality) dpLines.push(`Nationality: ${kd.nationality}`);
  if (kd.pension_refs) dpLines.push(`Pension refs: ${kd.pension_refs}`);
  if (kd.company_details) dpLines.push(`Company details: ${kd.company_details}`);

  dpLines.push(...dp);
  out.__data_points_captured_text = uniqueShort(dpLines, 12).join("\n");

  // Likelihood boost if clear, concrete next step with date/time is present
  if (/\b(mon|tue|wed|thu|fri|sat|sun|tomorrow|next (mon|tue|wed|thu|fri|week)|\d{1,2}:\d{2}|am|pm|\d{1,2}\/\d{1,2}(\/\d{2,4})?)\b/i.test(text)) {
    out.likelihood_to_close = Math.max(out.likelihood_to_close, 60);
  }

  // Ensure we have a tiny coaching summary if model returned blank
  if (!out.sales_performance_summary) {
    out.sales_performance_summary = "What went well:\n- Clear rapport.\n\nAreas to improve:\n- Ask for a commitment.\n- Confirm next step & date.";
  }

  return out;
}

/* -------------- small util helpers -------------- */
function normaliseLine(s){ return s.replace(/^[\-\*\d\.\)]\s*/, "").trim().slice(0, 200); }
function uniqueShort(arr, max=5){ const set=new Set(); const out=[]; for(const x of arr){ const y=String(x).trim(); if(!y) continue; if(!set.has(y)){ set.add(y); out.push(y.slice(0,200)); if(out.length>=max) break; }} return out; }
function capitalise(s){ return s.replace(/\b\w/g, m=>m.toUpperCase()); }
