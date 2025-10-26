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
- Never invent. If not stated, use empty arrays or short “Not mentioned.” text.
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

  // Gather context messages
  let combined = await getCombinedPrompt(callType || "Initial Consultation", cleanTranscript);
  let ctxMessages = Array.isArray(combined)
    ? combined
    : (combined && typeof combined === "object" && Array.isArray(combined.messages))
      ? combined.messages
      : (typeof combined === "string")
        ? [{ role: "system", content: combined }, { role: "user", content: cleanTranscript }]
        : [{ role: "system", content: "TLPI Initial Consultation analysis." }, { role: "user", content: cleanTranscript }];

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
    ai = safeParseJSON(js?.choices?.[0]?.message?.content);
  } catch (e) {
    console.warn("[ai] model request failed, falling back to heuristics:", e.message);
  }

  const merged = applyHeuristics(cleanTranscript, ai || {});

  // Strict “Proceed now”
  const agreedToSign = detectClientAgreementSign(cleanTranscript);
  if (agreedToSign) {
    merged.outcome = "Proceed now";
    merged.likelihood_to_close = Math.max(merged.likelihood_to_close || 0, 100);
    merged.sales_performance_rating = Math.max(merged.sales_performance_rating || 1, 8);
  } else if (detectPositiveSentiment(cleanTranscript)) {
    merged.likelihood_to_close = Math.max(merged.likelihood_to_close, 70);
  }

  // Final PII sanitisation pass for data_points + key_details
  sanitisePII(merged);

  return merged;
}

/* ============================== heuristics & sanitisation ============================== */

function hasMeaningfulContent(t) {
  if (!t) return false;
  const words = t.replace(/\s+/g, " ").trim().split(" ");
  return words.length > 8;
}
function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function clampInt(n, lo, hi) { const v=Number(n); if(!Number.isFinite(v)) return lo; return Math.max(lo, Math.min(hi, Math.round(v))); }

function detectClientAgreementSign(text) {
  const s = text.toLowerCase();
  const patterns = [
    /sign(ing)? (the )?client agreement/,
    /\bi('ll| will)? sign (the )?client agreement\b/,
    /\bagree(d)? to sign (the )?client agreement\b/,
    /\b(happy|keen|ready)\s+to\s+sign (the )?client agreement\b/,
    /\bi('m| am)\s+going\s+to\s+sign (the )?client agreement\b/,
  ];
  return patterns.some(rx => rx.test(s));
}

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
  if (/\b(client|agreement)\b/.test(s)) picks.push("Client Agreement");
  if (/\bfee(s)?\b/.test(s)) picks.push("Fee Schedule");
  if (/\bsetup pack|setup info|pack\b/.test(s)) picks.push("SSAS Setup Pack");
  if (/\bkyc|id\b/.test(s) || /proof of (id|address)/.test(s)) picks.push("KYC – ID & Address");
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

/** Extract raw PII hints for later sanitisation */
function extractDataPoints(text) {
  const s = text;
  const items = [];

  const dob = s.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
  if (dob) items.push({ k: "DOB", v: dob[1] });

  const nino = s.match(/\b([A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]?)\b/i);
  if (nino) items.push({ k: "NI", v: nino[1] });

  const utrLine = s.match(/\b(utr|personal tax reference|tax reference)\b[:\-\s]*([A-Za-z0-9\-]{6,14})/i);
  if (utrLine) items.push({ k: "UTR", v: utrLine[2] });

  const nationality = s.match(/\bnationality\b[:\-\s]*([A-Za-z \-]{4,40})/i);
  if (nationality) items.push({ k: "Nationality", v: nationality[1] });

  const addr = s.match(/\b(\d+\s+[A-Za-z0-9\.\- ]+ (road|rd|street|st|avenue|ave|lane|ln|close|cl|drive|dr|way|place|pl|court|ct))\b/i);
  if (addr) items.push({ k: "Address", v: addr[1] });

  const pens = s.match(/\b(pension|plan|policy|scheme)\s*(ref(erence)?|number|no\.?)?\b[:\-\s]*([A-Za-z0-9\-]{5,})/i);
  if (pens) items.push({ k: "Pension ref", v: pens[4] });

  const ltd = s.match(/\b([A-Z][A-Za-z0-9&\',\. ]+ (ltd|limited))\b/i);
  if (ltd) items.push({ k: "Company", v: ltd[1] });

  return items;
}

function applyHeuristics(text, ai) {
  const out = {
    call_type: "Initial Consultation",
    likelihood_to_close: clampInt(ai?.likelihood_to_close ?? 50, 0, 100),
    outcome: ai?.outcome || "Likely",
    objections: Array.isArray(ai?.objections) ? ai.objections : [],
    next_actions: Array.isArray(ai?.next_actions) ? ai.next_actions : [],
    materials_to_send: Array.isArray(ai?.materials_to_send) ? ai.materials_to_send : [],
    key_details: ai?.key_details || {},
    ai_decision_criteria: Array.isArray(ai?.ai_decision_criteria) ? ai.ai_decision_criteria : [],
    sales_performance_rating: clampInt(ai?.sales_performance_rating ?? 6, 1, 10),
    sales_performance_summary: String(ai?.sales_performance_summary || "").trim(),
    consult_eval: ai?.consult_eval || {}
  };

  if (!out.key_details?.products_discussed || out.key_details.products_discussed.length === 0) {
    const pi = guessProductInterest(text);
    out.key_details.products_discussed = pi;
  }
  if (out.next_actions.length === 0) out.next_actions = extractNextActions(text);
  if (out.materials_to_send.length === 0) out.materials_to_send = extractMaterials(text);
  if (out.ai_decision_criteria.length === 0) out.ai_decision_criteria = extractDecisionCriteria(text);
  if (out.objections.length === 0) out.objections = extractObjections(text);

  const kd = out.key_details || {};
  const dpRaw = extractDataPoints(text);

  const dp = [];
  if (kd.client_name) dp.push({ k: "Name", v: kd.client_name });
  if (kd.company_name) dp.push({ k: "Company", v: kd.company_name });
  if (kd.address) dp.push({ k: "Address", v: kd.address });
  if (kd.dob) dp.push({ k: "DOB", v: kd.dob });
  if (kd.ni || kd.nino) dp.push({ k: "NI", v: kd.ni || kd.nino });
  if (kd.utr) dp.push({ k: "UTR", v: kd.utr });
  if (kd.nationality) dp.push({ k: "Nationality", v: kd.nationality });
  if (kd.pension_refs) dp.push({ k: "Pension refs", v: kd.pension_refs });
  if (kd.company_details) dp.push({ k: "Company details", v: kd.company_details });

  out.__data_points_raw = [...dp, ...dpRaw];

  // tiny default summary if empty
  if (!out.sales_performance_summary) {
    out.sales_performance_summary = "What went well:\n- Clear rapport.\n\nAreas to improve:\n- Ask for a commitment.\n- Confirm next step & date.";
  }

  return out;
}

/* -------------------- PII sanitisation -------------------- */

function sanitisePII(analysis) {
  const cleaned = [];
  const seen = new Set();

  // NI rules
  const badNiPrefixes = new Set(["DQ","IJ","ZZ"]);

  function validDOB(v) {
    // dd/mm/yyyy or dd-mm-yyyy, 1900..2099
    const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (!m) return null;
    let [_, d, mo, y] = m;
    d = +d; mo = +mo; y = +y;
    if (y < 100) y += 1900;
    if (y < 1900 || y > 2099) return null;
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > 31) return null;
    return `${String(d).padStart(2,"0")}/${String(mo).padStart(2,"0")}/${String(y)}`;
  }

  function validNI(v) {
    const m = v.toUpperCase().match(/^([A-Z]{2})(\d{6})([A-D]?)$/);
    if (!m) return null;
    const prefix = m[1];
    if (badNiPrefixes.has(prefix)) return null;
    return `${prefix}${m[2]}${m[3]}`;
  }

  function validUTR(v) {
    const digits = (v || "").replace(/\D+/g, "");
    if (digits.length === 10) return digits;
    return null;
  }

  const natWhitelist = new Set([
    "UK","United Kingdom","British","England","Scotland","Wales","Northern Ireland",
    "Irish","Irish Republic","Ireland","Polish","Poland","French","France","Spanish","Spain","Italian","Italy",
    "German","Germany","Indian","India","Pakistani","Pakistan","Bangladeshi","Bangladesh","Chinese","China",
    "Nigerian","Nigeria","South African","South Africa","Australian","Australia","New Zealander","New Zealand"
  ]);

  function validNationality(v) {
    const t = String(v || "").trim();
    if (!t) return null;
    // Keep simple words/phrases only
    if (t.length > 30) return null;
    // Title-case quick clean
    const tc = t.replace(/\s+/g," ").trim().replace(/\b\w/g, m => m.toUpperCase());
    if (natWhitelist.has(tc) || natWhitelist.has(t)) return tc;
    // Allow “UK”, “British” etc even if not in list due to case
    if (/^(UK|British)$/i.test(t)) return t.toUpperCase() === "UK" ? "UK" : "British";
    return null;
  }

  function normaliseCompanyNumber(v) {
    const digits = (v || "").replace(/\D+/g, "");
    if (digits.length >= 6 && digits.length <= 10) return digits;
    return null;
  }

  function pushKV(k, v) {
    const key = `${k}:${v}`;
    if (!v) return;
    if (seen.has(key)) return;
    seen.add(key);
    cleaned.push(`${k}: ${v}`);
  }

  const raw = Array.isArray(analysis.__data_points_raw) ? analysis.__data_points_raw : [];

  for (const item of raw) {
    const k = item?.k; let v = String(item?.v || "").trim();
    if (!k || !v) continue;

    if (k === "DOB") {
      const ok = validDOB(v);
      if (ok) pushKV("DOB", ok);
      continue;
    }
    if (k === "NI") {
      const ok = validNI(v);
      if (ok) pushKV("NI", ok);
      continue;
    }
    if (k === "UTR") {
      const ok = validUTR(v);
      if (ok) pushKV("UTR", ok);
      continue;
    }
    if (k === "Nationality") {
      const ok = validNationality(v);
      if (ok) pushKV("Nationality", ok);
      continue;
    }
    if (k === "Company details") {
      const cno = normaliseCompanyNumber(v);
      if (cno) pushKV("Company number", cno);
      continue;
    }
    // Safe defaults for other keys
    if (k === "Address" && v.length > 6) { pushKV("Address", v); continue; }
    if (k === "Pension ref" && v.length >= 5) { pushKV("Pension ref", v); continue; }
    if (k === "Company" && v.length >= 3) { pushKV("Company", v); continue; }
    if (k === "Name" && v.length >= 2) { pushKV("Name", v); continue; }
  }

  analysis.__data_points_captured_text = cleaned.slice(0, 12).join("\n");
}

// -------------- utils --------------
function normaliseLine(s){ return s.replace(/^[\-\*\d\.\)]\s*/, "").trim().slice(0, 200); }
function uniqueShort(arr, max=5){ const set=new Set(); const out=[]; for(const x of arr){ const y=String(x).trim(); if(!y) continue; if(!set.has(y)){ set.add(y); out.push(y.slice(0,200)); if(out.length>=max) break; }} return out; }
function capitalise(s){ return s.replace(/\b\w/g, m=>m.toUpperCase()); }
