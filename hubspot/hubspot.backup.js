/* hubspot/hubspot.js — v1.19 (CT fallback + parser improvements) */
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

if (!HUBSPOT_TOKEN) {
  console.warn("[warn] HubSpot token missing: set HUBSPOT_PRIVATE_APP_TOKEN (preferred) or HUBSPOT_TOKEN");
}

const HS = {
  base: "https://api.hubapi.com",
  jsonHeaders: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  },
};

async function hsFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...HS.jsonHeaders } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${url} -> ${res.status} ${text}`);
  }
  try { return await res.json(); } catch { return {}; }
}

// ---------- helpers ----------
const toText = (v, fb = "") => {
  if (v == null) return fb;
  if (Array.isArray(v)) return v.map((x) => toText(x, "")).filter(Boolean).join("; ");
  if (typeof v === "object") return String(v?.text ?? v?.content ?? v?.value ?? JSON.stringify(v));
  const s = String(v).trim();
  return s || fb;
};
const toLines = (v) => Array.isArray(v) ? v.map(x => toText(x, "")).filter(Boolean).join("\n") : toText(v, "");
const toNumberOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const toEnum = (value, allowed = [], fallback) => {
  const s = String(value ?? "").trim();
  return allowed.includes(s) ? s : (fallback ?? (allowed[0] ?? ""));
};

// IMPROVED: handles k / m / grand / g / commas / £
const parseApproxNumber = (x) => {
  const s = toText(x, "");
  if (!s) return null;
  const cleaned = s.toLowerCase().replace(/£|,|\s/g, "");

  // 300k
  let m = cleaned.match(/^(\d+(\.\d+)?)k$/);
  if (m) return Math.round(Number(m[1]) * 1_000);

  // 0.3m or 0.3million or 3000000
  m = cleaned.match(/^(\d+(\.\d+)?)(m|million)$/);
  if (m) return Math.round(Number(m[1]) * 1_000_000);

  // 300grand or 300g
  m = cleaned.match(/^(\d+(\.\d+)?)(grand|g)$/);
  if (m) return Math.round(Number(m[1]) * 1_000);

  // plain number (with optional decimals)
  const only = cleaned.replace(/[^0-9.]/g, "");
  const n = Number(only);
  return Number.isFinite(n) ? Math.round(n) : null;
};

// NEW: pull CT amount from free text around "corporation tax"
function extractCorporationTaxFromText(text = "") {
  const s = String(text || "");
  if (!s) return null;

  // find phrases containing "corporation tax" +/- a short window and capture the nearest money-like token
  const windowRe = /(?:^|.{0,80})(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)(?=[^a-zA-Z]{0,15}(?:corp(?:oration)?\s*tax|ct\b))|(?:corp(?:oration)?\s*tax|ct\b)[^a-zA-Z]{0,15}(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)/ig;

  let best = null;
  for (const m of s.matchAll(windowRe)) {
    const candidate = m[1] || m[2];
    const parsed = parseApproxNumber(candidate);
    if (parsed && (!best || parsed > best)) best = parsed; // keep the largest found (defensive)
  }
  return best;
}

// Map objection text to ONE allowed enum:
function categorizeObjections(text = "") {
  const s = String(text || "").toLowerCase();
  if (/(price|fee|cost|expens|cheaper|quote)/i.test(s)) return "Price";
  if (/(time|timing|delay|later|not.*good.*time|busy|next month)/i.test(s)) return "Timing";
  if (/(complex|confus|complicated|too much effort)/i.test(s)) return "Complexity";
  if (/(risk|trust|security|safe|regulated|scam|reputation)/i.test(s)) return "Risk";
  if (/(partner|accountant|director|board|co[- ]?director|wife|husband|spouse|need.*approval|sign.?off|decision[- ]?maker)/i.test(s)) return "Authority";
  return "Clarity";
}

// ---------- READ ----------
export async function getHubSpotObject(objectType, objectId, properties = []) {
  const qs = properties.length ? `?properties=${encodeURIComponent(properties.join(","))}` : "";
  const url = `${HS.base}/crm/v3/objects/${objectType}/${objectId}${qs}`;
  try { return await hsFetch(url); }
  catch (err) { throw new Error(`HubSpot get ${objectType}/${objectId} failed: ${err.message}`); }
}

export async function getAssociations(callId, toType) {
  const url = `${HS.base}/crm/v4/objects/calls/${callId}/associations/${toType}`;
  try {
    const data = await hsFetch(url);
    const ids =
      data?.results?.map((r) => String(r.toObjectId)).filter(Boolean) ||
      data?.results?.map((r) => String(r.id)).filter(Boolean) ||
      [];
    return ids.map((x) => (/\d+/.test(x) ? Number(x) : x));
  } catch (e) {
    console.warn(`[warn] getAssociations calls/${callId} -> ${toType} failed:`, e.message);
    return [];
  }
}

// ---------- Qualification Call updater ----------
export async function updateQualificationCall(callId, data) {
  const token = HUBSPOT_TOKEN;
  if (!callId || !token) { console.warn("[qual] Missing callId or HubSpot token"); return; }
  const url = `${HS.base}/crm/v3/objects/calls/${callId}`;

  // Normalise inputs from analysis
  const decisionCriteria = toLines(data?.ai_qualification_decision_criteria ?? data?.ai_decision_criteria);
  const nextSteps = toLines(data?.ai_qualification_next_steps ?? data?.ai_next_steps);
  const objectionsText = toLines(data?.ai_qualification_key_objections ?? data?.ai_key_objections);
  const materials = toLines(data?.ai_qualification_required_materials ?? data?.ai_consultation_required_materials ?? data?.materials_to_send);

  const likelihoodProceed = toNumberOrNull(
    data?.ai_qualification_likelihood_to_proceed ?? data?.ai_consultation_likelihood_to_close
  );

  const likelihoodBookIC = toEnum(
    data?.ai_qualification_likelihood_to_book_ic,
    ["Booked", "Very Likely", "Likely", "Unclear", "Unlikely", "No"],
    "Unclear"
  );

  const director = toEnum(
    data?.ai_is_company_director,
    ["Yes", "No", "Unsure"],
    "Unsure"
  );

  const productInterest = toEnum(
    data?.ai_product_interest,
    ["SSAS", "FIC", "Both", "Unclear"],
    "Unclear"
  );

  // Build short coaching bullets (max 4)
  const bullets = buildQualificationBullets(data);
  const summaryShort = bullets.length
    ? "• " + bullets.join("\n• ")
    : "• Ask for commitment to book the IC\n• Confirm next steps explicitly";

  // Derive objection category + primary, clamp to allowed enums
  const derivedCategory = categorizeObjections(objectionsText);
  const allowedObjectionEnums = new Set(["Price", "Timing", "Risk", "Complexity", "Authority", "Clarity"]);
  const safeObjectionCategory = allowedObjectionEnums.has(derivedCategory) ? derivedCategory : "Clarity";

  const primaryObjection = (() => {
    if (!objectionsText) return "No objection";
    const parts = objectionsText.split(/[\n;•]+/).map(s => s.trim()).filter(Boolean);
    return parts[0] || "No objection";
  })();

  // Defaults for qual context
  const dataPoints = (() => {
    if (Array.isArray(data?.ai_data_points_captured) && data.ai_data_points_captured.length) {
      return data.ai_data_points_captured.join("; ");
    }
    const t = toText(data?.ai_data_points_captured, "");
    return t ? t : "No data points captured";
  })();

  const missingInfo = (() => {
    if (Array.isArray(data?.ai_missing_information) && data.ai_missing_information.length) {
      return data.ai_missing_information.join("; ");
    }
    const t = toText(data?.ai_missing_information, "");
    return t ? t : "Not mentioned";
  })();

  // ---- CT bill: AI field first, then fallback from data-points text ----
  const ctFromAI = parseApproxNumber(data?.ai_approx_corporation_tax_bill);
  const ctFromText = ctFromAI == null ? extractCorporationTaxFromText(dataPoints) : null;
  const ctBill = ctFromAI ?? ctFromText ?? null;

  const props = {
    // Core “qualification” signal fields on CALL
    ai_inferred_call_type: "Qualification call",
    ai_call_type_confidence: 90,

    ai_product_interest: productInterest,

    ai_decision_criteria: decisionCriteria,
    ai_next_steps: nextSteps || "No next steps mentioned.",
    ai_key_objections: objectionsText || "No objections",
    ai_objections_bullets: objectionsText ? objectionsText.replace(/; /g, " • ") : "No objections",
    ai_primary_objection: primaryObjection,
    ai_objection_categories: safeObjectionCategory,

    ai_data_points_captured: dataPoints,
    ai_missing_information: missingInfo,
    ai_consultation_required_materials: materials || "Nothing requested",

    // Eligibility/marketing and the fixed fields you called out
    ai_how_heard_about_tlpi: toText(data?.ai_how_heard_about_tlpi, ""),
    ai_problem_to_solve: toText(data?.ai_problem_to_solve, ""),
    ai_approx_corporation_tax_bill: ctBill,                   // <— now robust
    ai_is_company_director: director,
    ai_qualification_likelihood_to_book_ic: likelihoodBookIC, // clamped
    ai_qualification_likelihood_to_proceed: likelihoodProceed ?? 1,

    // Coaching (short)
    sales_performance_summary: summaryShort,
    chat_gpt___sales_performance: toNumberOrNull(data?.chat_gpt_sales_performance),
    chat_gpt___score_reasoning: toText(data?.chat_gpt_score_reasoning, ""),
    chat_gpt___increase_likelihood_of_sale_suggestions: toLines(data?.chat_gpt_increase_likelihood_of_sale),
  };

  try {
    await hsFetch(url, { method: "PATCH", body: JSON.stringify({ properties: props }) });
    console.log(`[qual] Qualification Call ${callId} updated.`);
  } catch (err) {
    console.error("[qual] HubSpot Qualification update failed:", err?.message || err);
  }
}

// ---------- Scorecard creation (unchanged apart from file context; kept for completeness) ----------
function limitBullets(bullets = [], max = 4) {
  const clean = (s) => String(s || "").replace(/^[-•\s]+/, "").replace(/\.$/, "").trim();
  return bullets.map(clean).filter(Boolean).slice(0, max);
}
function buildQualificationBullets(data = {}) {
  const provided = Array.isArray(data?.sales_performance_summary_bullets) ? data.sales_performance_summary_bullets : [];
  if (provided.length) return limitBullets(provided, 4);
  const q = data?.qualification_eval || {};
  const improvemap = [
    ["qual_intro", "Tighten your intro and purpose."],
    ["qual_open_question", "Ask more open questions."],
    ["qual_benefits_linked_to_needs", "Link benefits to stated needs."],
    ["qual_relevant_pain_identified", "Surface a specific pain point earlier."],
    ["qual_clear_responses_or_followup", "Give clearer, complete responses."],
    ["qual_services_explained_clearly", "Explain TLPI services more clearly."],
    ["qual_rapport", "Build rapport more intentionally."],
    ["qual_next_steps_confirmed", "Confirm next steps explicitly."],
    ["qual_commitment_requested", "Ask for commitment to book the IC."],
    ["qual_active_listening", "Demonstrate active listening cues."],
  ];
  const improvements = improvemap.filter(([k]) => q?.[k] !== 1).map(([, msg]) => msg);
  const positives = improvemap.filter(([k]) => q?.[k] === 1).map(([, msg]) => msg.replace("more ", ""));
  let out = [];
  if (improvements.length >= 4) out = improvements.slice(0, 4);
  else out = [...improvements, ...positives].slice(0, 4);
  return limitBullets(out, 4);
}

export async function createQualificationScorecard({ callId, contactIds = [], ownerId, data }) {
  const url = `${HS.base}/crm/v3/objects/p49487487_sales_scorecards`;
  const today = new Date().toISOString().slice(0, 10);
  const fv = (v) => (v === 1 ? 1 : 0);
  const weights = {
    qual_commitment_requested: 2.0,
    qual_relevant_pain_identified: 1.5,
    qual_benefits_linked_to_needs: 1.5,
    qual_open_question: 1.0,
    qual_clear_responses_or_followup: 1.0,
    qual_next_steps_confirmed: 1.0,
    qual_services_explained_clearly: 0.75,
    qual_intro: 0.5,
    qual_rapport: 0.5,
    qual_active_listening: 0.25,
  };
  const q = data?.qualification_eval || {};
  let weighted = 0;
  for (const [k, w] of Object.entries(weights)) weighted += fv(q?.[k]) * w;
  const qualScore = Math.max(0, Math.min(10, Math.round(weighted * 10) / 10));

  const qualNext = toLines(data?.ai_qualification_next_steps ?? data?.ai_next_steps);
  const qualMaterials = toLines(data?.ai_qualification_required_materials ?? data?.ai_consultation_required_materials);
  const qualCriteria = toLines(data?.ai_qualification_decision_criteria ?? data?.ai_decision_criteria);
  const qualObjections = toLines(data?.ai_qualification_key_objections ?? data?.ai_key_objections);
  const qualOutcome = toText(data?.ai_qualification_outcome ?? data?.outcome ?? "Unclear");
  const qualLikelihood = toNumberOrNull(
    data?.ai_qualification_likelihood_to_proceed ?? data?.ai_consultation_likelihood_to_close
  );

  const props = {
    activity_type: "Qualification call",
    activity_name: `${callId} — Qualification call — ${today}`,
    hubspot_owner_id: ownerId || undefined,

    sales_scorecard___what_you_can_improve_on:
      toText(data?.sales_scorecard_summary, "") || "What went well:\n- \n\nAreas to improve:\n- ",
    sales_performance_rating_: toNumberOrNull(data?.chat_gpt_sales_performance),

    ai_qualification_next_steps: qualNext,
    ai_qualification_required_materials: qualMaterials,
    ai_qualification_decision_criteria: qualCriteria,
    ai_qualification_key_objections: qualObjections,
    ai_qualification_outcome: qualOutcome,
    ai_qualification_likelihood_to_proceed: qualLikelihood,

    // Behaviours + final score
    qual_active_listening: toNumberOrNull(q?.qual_active_listening) ?? 0,
    qual_benefits_linked_to_needs: toNumberOrNull(q?.qual_benefits_linked_to_needs) ?? 0,
    qual_clear_responses_or_followup: toNumberOrNull(q?.qual_clear_responses_or_followup) ?? 0,
    qual_commitment_requested: toNumberOrNull(q?.qual_commitment_requested) ?? 0,
    qual_intro: toNumberOrNull(q?.qual_intro) ?? 0,
    qual_next_steps_confirmed: toNumberOrNull(q?.qual_next_steps_confirmed) ?? 0,
    qual_open_question: toNumberOrNull(q?.qual_open_question) ?? 0,
    qual_rapport: toNumberOrNull(q?.qual_rapport) ?? 0,
    qual_relevant_pain_identified: toNumberOrNull(q?.qual_relevant_pain_identified) ?? 0,
    qual_services_explained_clearly: toNumberOrNull(q?.qual_services_explained_clearly) ?? 0,
    qual_score_final: qualScore,
  };

  let scorecardId = null;
  try {
    const created = await hsFetch(url, { method: "POST", body: JSON.stringify({ properties: props }) });
    scorecardId = created?.id || null;
    console.log("Created Qualification Scorecard:", scorecardId);
  } catch (err) {
    console.error("Failed to create Qualification Scorecard:", err?.message || err);
    return null;
  }
  return scorecardId;
}

// ---------- association helpers (unchanged) ----------
async function discoverAssocMeta(fromType, toType) { /* ... keep original content ... */ }
async function assocTryV4Single(fromType, fromId, toType, toId, typeId) { /* ... keep original content ... */ }
async function assocTryV4BatchTypeId(fromType, fromId, toType, toId, typeId) { /* ... keep original content ... */ }
async function assocTryV3BatchLabel(fromType, fromId, toType, toId, label) { /* ... keep original content ... */ }
export async function associateScorecardAllViaTypes({ scorecardId, callId, contactIds = [], dealIds = [] }) { /* ... keep original content ... */ }
export async function updateCall(callId, analysis) { /* ... keep original content ... */ }
export async function getHubSpotObject(objectType, objectId, properties = []) { /* already defined above */ }
export async function getAssociations(callId, toType) { /* already defined above */ }
