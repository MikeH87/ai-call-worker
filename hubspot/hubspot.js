// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY;
const HS_BASE = "https://api.hubapi.com";
const SCORECARD_OBJECT = process.env.HUBSPOT_SCORECARD_OBJECT || "p49487487_sales_scorecards";

if (!HUBSPOT_TOKEN) console.warn("[cfg] HUBSPOT_TOKEN missing — HubSpot updates will fail.");

function hsHeaders() {
  return { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" };
}

/* =========================================
   Property discovery & filtering (memoised)
   ========================================= */
const KNOWN_PROPS = new Map(); // objectType -> Set(props)

async function getKnownPropsSet(objectType) {
  if (KNOWN_PROPS.has(objectType)) return KNOWN_PROPS.get(objectType);
  try {
    const url = `${HS_BASE}/crm/v3/properties/${encodeURIComponent(objectType)}?archived=false`;
    const res = await fetch(url, { headers: hsHeaders() });
    if (!res.ok) throw new Error(`prop list ${objectType} ${res.status}`);
    const js = await res.json();
    const set = new Set((js?.results || []).map(p => p?.name).filter(Boolean));
    KNOWN_PROPS.set(objectType, set);
    return set;
  } catch (e) {
    console.warn(`[HubSpot] Could not fetch properties for ${objectType}: ${e.message}`);
    const set = new Set();
    KNOWN_PROPS.set(objectType, set);
    return set;
  }
}

async function filterPropsFor(objectType, props) {
  const known = await getKnownPropsSet(objectType);
  if (!known || known.size === 0) return props; // nothing known, don't filter
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (known.has(k)) out[k] = v;
    else console.warn(`[filter] dropping unknown ${objectType}.${k}`);
  }
  return out;
}

/* ====================== Reads ====================== */
export async function getHubSpotObject(objectType, id, properties = []) {
  const params = new URLSearchParams();
  if (properties?.length) params.set("properties", properties.join(","));
  const url = `${HS_BASE}/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(id)}?${params.toString()}`;
  const res = await fetch(url, { headers: hsHeaders() });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HubSpot get ${objectType}/${id} failed: ${res.status} ${t?.slice(0, 200)}`);
  }
  return await res.json();
}

export async function getAssociations(fromId, toType) {
  const url = `${HS_BASE}/crm/v4/objects/calls/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toType)}?limit=100`;
  const res = await fetch(url, { headers: hsHeaders() });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn(`assoc fetch failed: ${res.status} ${t?.slice(0, 200)}`);
    return [];
  }
  const js = await res.json();
  return js?.results?.map(r => r?.toObjectId).filter(Boolean) || [];
}

/* =========================================================
   CALL UPDATE (Initial Consultation — exactly the fields you listed)
   ========================================================= */
export async function updateCall(callId, analysis) {
  const props = {};

  // 1) Ai inferred call type / confidence (force IC path)
  props.ai_inferred_call_type = "Initial Consultation";
  props.ai_call_type_confidence = clamp(
    numberOrNull(analysis?.ai_call_type_confidence ?? analysis?.call_type_confidence) ?? 90,
    0, 100
  );

  // 2) ai consultation outcome (allowed options)
  const outcomeHS = mapConsultationOutcomeHS(analysis?.outcome, analysis?.likelihood_to_close, analysis);
  props.ai_consultation_outcome = outcomeHS;

  // 3) ai product of interest
  const productInterest = mapProductInterest(analysis?.key_details?.products_discussed);
  if (productInterest) props.ai_product_interest = productInterest;

  // 4) ai decision criteria
  props.ai_decision_criteria = toShortList(
    analysis?.ai_decision_criteria,
    inferDecisionCriteriaFromSummary(analysis?.summary || []),
    "Not mentioned."
  );

  // 5) ai data point capture (DOB, address, NI, etc.)
  props.ai_data_points_captured = buildDataPointsCaptured(analysis?.key_details) || "No personal data captured.";

  // 6) ai missing information
  props.ai_missing_information = toMultiline(analysis?.ai_missing_information) || "None requested or all provided.";

  // 7) ai next steps
  props.ai_next_steps = toShortList(analysis?.next_actions, [], "No next steps captured.");

  // 8) Objections (primary/bullets/category/severity)
  const objections = ensureArray(analysis?.objections);
  if (objections.length) {
    props.ai_key_objections = objections.join("; ").slice(0, 1000);
    props.ai_objections_bullets = objections.join(" • ").slice(0, 5000);
    props.ai_primary_objection = objections[0].slice(0, 300);
    const mappedCat = mapObjectionCategoryToAllowed(objections);
    if (mappedCat) props.ai_objection_categories = mappedCat; // single allowed option only
    props.ai_objection_severity = normaliseSeverity(analysis?.ai_objection_severity || "Medium");
  } else {
    props.ai_key_objections = "No objections";
    props.ai_objections_bullets = "No objections";
    props.ai_primary_objection = "No objections";
    // Do NOT set ai_objection_categories at all when none; avoids INVALID_OPTION
    props.ai_objection_severity = "Low";
  }

  // 9) ai client engagement level (NUMBER 3/2/1)
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome);
  props.ai_client_engagement_level = engagementNumberFromSentiment(sentiment);

  // 10) ChatGPT helper fields (careful: internal name is **likeliness** with an 'e')
  const likeScore10 = adjustedLikelihood10(analysis, outcomeHS);
  props["chat_gpt___likeliness_to_proceed_score"] = likeScore10;
  props["chat_gpt___increase_likelihood_of_sale_suggestions"] = buildIncreaseLikelihood(analysis);
  props["chat_gpt___score_reasoning"] = buildScoreReasoning(analysis, likeScore10);

  // Filter & patch
  const safeProps = await filterPropsFor("calls", props);
  const patchResp = await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: safeProps });

  // Optional echo to logs
  try {
    const echo = await getHubSpotObject("calls", callId, [
      "ai_inferred_call_type","ai_call_type_confidence","ai_consultation_outcome",
      "ai_product_interest","ai_decision_criteria","chat_gpt___likeliness_to_proceed_score"
    ]);
    console.log("[debug] Call updated:", echo?.properties);
  } catch {}

  return patchResp;
}

/* ====================================================================
   SCORECARD CREATE (Initial Consultation — 20 consult_* metrics + weighted 10/10)
   ==================================================================== */
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  await getKnownPropsSet(SCORECARD_OBJECT);
  const has = (n) => KNOWN_PROPS.get(SCORECARD_OBJECT)?.has(n);

  const activityName = `${callId} — Initial Consultation — ${new Date().toISOString().slice(0, 10)}`;

  // Build 20 consult_* flags (0/1) using consult_eval + heuristics
  const consult = buildConsultFlags(analysis);

  // Weighted score (sums to 10.0), round to nearest integer, clamp 1..10
  const weights = CONSULT_WEIGHTS_10;
  let raw = 0;
  for (const [k, w] of Object.entries(weights)) raw += (consult[k] ? 1 : 0) * w;
  const consultScore10 = clamp(Math.round(raw), 1, 10);

  // Sales performance rating (prompt) with sanity floor if Proceed now
  let perf10 = clamp(Math.round(numberOrNull(analysis?.sales_performance_rating) ?? 0), 1, 10);
  const outcomeHS = mapConsultationOutcomeHS(analysis?.outcome, analysis?.likelihood_to_close, analysis);
  if (outcomeHS === "Proceed now" && perf10 < 8) perf10 = 8;

  const summary = buildCoachingSummary(analysis);
  const likeScore10 = adjustedLikelihood10(analysis, outcomeHS);

  const props = {
    activity_type: "Initial Consultation",
    activity_name: activityName,
    hubspot_owner_id: ownerId || undefined,

    // 20 consult_* flags (0/1)
    ...(has("consult_closing_question_asked") ? { consult_closing_question_asked: consult.consult_closing_question_asked } : {}),
    ...(has("consult_collected_dob_nin_when_agreed") ? { consult_collected_dob_nin_when_agreed: consult.consult_collected_dob_nin_when_agreed } : {}),
    ...(has("consult_confirm_reason_for_zoom") ? { consult_confirm_reason_for_zoom: consult.consult_confirm_reason_for_zoom } : {}),
    ...(has("consult_customer_agreed_to_set_up") ? { consult_customer_agreed_to_set_up: consult.consult_customer_agreed_to_set_up } : {}),
    ...(has("consult_demo_tax_saving") ? { consult_demo_tax_saving: consult.consult_demo_tax_saving } : {}),
    ...(has("consult_fee_phrasing_three_seven_five") ? { consult_fee_phrasing_three_seven_five: consult.consult_fee_phrasing_three_seven_five } : {}),
    ...(has("consult_fees_annualised") ? { consult_fees_annualised: consult.consult_fees_annualised } : {}),
    ...(has("consult_fees_tax_deductible_explained") ? { consult_fees_tax_deductible_explained: consult.consult_fees_tax_deductible_explained } : {}),
    ...(has("consult_interactive_throughout") ? { consult_interactive_throughout: consult.consult_interactive_throughout } : {}),
    ...(has("consult_needs_pain_uncovered") ? { consult_needs_pain_uncovered: consult.consult_needs_pain_uncovered } : {}),
    ...(has("consult_next_contact_within_5_days") ? { consult_next_contact_within_5_days: consult.consult_next_contact_within_5_days } : {}),
    ...(has("consult_next_step_specific_date_time") ? { consult_next_step_specific_date_time: consult.consult_next_step_specific_date_time } : {}),
    ...(has("consult_no_assumptions_evidence_gathered") ? { consult_no_assumptions_evidence_gathered: consult.consult_no_assumptions_evidence_gathered } : {}),
    ...(has("consult_overcame_objection_and_closed") ? { consult_overcame_objection_and_closed: consult.consult_overcame_objection_and_closed } : {}),
    ...(has("consult_prospect_asked_next_steps") ? { consult_prospect_asked_next_steps: consult.consult_prospect_asked_next_steps } : {}),
    ...(has("consult_purpose_clearly_stated") ? { consult_purpose_clearly_stated: consult.consult_purpose_clearly_stated } : {}),
    ...(has("consult_quantified_value_roi") ? { consult_quantified_value_roi: consult.consult_quantified_value_roi } : {}),
    ...(has("consult_rapport_open") ? { consult_rapport_open: consult.consult_rapport_open } : {}),
    ...(has("consult_specific_tax_estimate_given") ? { consult_specific_tax_estimate_given: consult.consult_specific_tax_estimate_given } : {}),
    ...(has("consult_strong_buying_signals_detected") ? { consult_strong_buying_signals_detected: consult.consult_strong_buying_signals_detected } : {}),

    // Consultation Score (1–10)
    ...(has("consult_score_final") ? { consult_score_final: consultScore10 } : {}),

    // Sales performance rating (prompt) + coaching summary
    ...(has("sales_performance_rating") ? { sales_performance_rating: String(perf10) } : {}),
    ...(has("sales_scorecard___what_you_can_improve_on") ? { sales_scorecard___what_you_can_improve_on: summary } : {}),

    // Mirrors from the Call
    ...(has("ai_consultation_likelihood_to_close") ? { ai_consultation_likelihood_to_close: likeScore10 } : {}),
    ...(has("ai_consultation_outcome") ? { ai_consultation_outcome: outcomeHS } : {}),
    ...(has("ai_consultation_required_materials") ? { ai_consultation_required_materials: toShortList(analysis?.materials_to_send, [], "No materials requested.") } : {}),
    ...(has("ai_decision_criteria") ? { ai_decision_criteria: toShortList(analysis?.ai_decision_criteria, inferDecisionCriteriaFromSummary(analysis?.summary || []), "Not mentioned.") } : {}),
    ...(has("ai_key_objections") ? { ai_key_objections: ensureArray(analysis?.objections).length ? ensureArray(analysis?.objections).join("; ").slice(0, 1000) : "No objections" } : {}),
    ...(has("ai_next_steps") ? { ai_next_steps: toShortList(analysis?.next_actions, [], "No next steps captured.") } : {}),
  };

  const safeProps = await filterPropsFor(SCORECARD_OBJECT, props);
  const created = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, { properties: safeProps });
  const scoreId = created?.id;
  if (!scoreId) {
    console.warn("[HubSpot] Scorecard creation returned no id");
    return { type: SCORECARD_OBJECT, id: null };
  }

  // Associate to call + any contact/deal
  await associateV4UsingLabels(SCORECARD_OBJECT, scoreId, "calls", callId);
  for (const cId of contactIds) await associateV4UsingLabels(SCORECARD_OBJECT, scoreId, "contacts", cId);
  for (const dId of dealIds) await associateV4UsingLabels(SCORECARD_OBJECT, scoreId, "deals", dId);

  return { type: SCORECARD_OBJECT, id: scoreId };
}

/* =================== HTTP helpers =================== */
async function hubspotPost(path, body) {
  const url = `${HS_BASE}/${path}`;
  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (txt.includes("PROPERTY_DOESNT_EXIST")) console.warn(`[HubSpot] Missing property creating ${url}:`, txt.slice(0, 300));
    else console.warn(`[HubSpot] POST ${url} failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  try { return await res.json(); } catch { return null; }
}

async function hubspotPatch(path, body) {
  const url = `${HS_BASE}/${path}`;
  const res = await fetch(url, { method: "PATCH", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (txt.includes("PROPERTY_DOESNT_EXIST")) console.warn(`[HubSpot] Some properties missing while updating ${url}:`, txt.slice(0, 300));
    else console.warn(`[HubSpot] PATCH ${url} failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  try { return await res.json(); } catch { return null; }
}

/* ================== Associations ================== */
async function associateV4UsingLabels(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;
  const labelsUrl = `${HS_BASE}/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/labels`;
  const labelsRes = await fetch(labelsUrl, { headers: hsHeaders() });
  if (!labelsRes.ok) {
    const txt = await labelsRes.text().catch(() => "");
    console.warn(`[HubSpot] association labels fetch failed for ${fromType}->${toType}: ${labelsRes.status} ${txt.slice(0, 300)}`);
    return;
  }
  const labels = await labelsRes.json();
  const labelList = labels?.results || [];
  if (!labelList.length) {
    console.warn(`[HubSpot] No association labels available for ${fromType} -> ${toType}`);
    return;
  }

  for (const lab of labelList) {
    const typeId = lab?.typeId;
    const category = lab?.category || lab?.associationCategory || "USER_DEFINED";
    if (!typeId) continue;

    const url = `${HS_BASE}/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
    const body = {
      inputs: [
        {
          from: { id: String(fromId) },
          to: { id: String(toId) },
          types: [{ associationCategory: String(category), associationTypeId: typeId }],
        },
      ],
    };

    const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
    if (res.ok) return;
    const txt = await res.text().catch(() => "");
    console.warn(`[HubSpot] v4 associate ${fromType}:${fromId} -> ${toType}:${toId} failed for label(typeId=${typeId}, category=${category}): ${res.status} ${txt.slice(0, 300)}`);
  }

  console.warn(`[HubSpot] v4 association failed for all labels: ${fromType} -> ${toType}`);
}

/* ================== Weights & Inference ================== */
/** Weights that sum to 10.0, per your approval. */
const CONSULT_WEIGHTS_10 = {
  consult_customer_agreed_to_set_up:       2.0,
  consult_overcame_objection_and_closed:   1.0,
  consult_next_step_specific_date_time:    0.7,
  consult_closing_question_asked:          0.6,
  consult_prospect_asked_next_steps:       0.4,
  consult_strong_buying_signals_detected:  0.6,
  consult_needs_pain_uncovered:            0.6,
  consult_purpose_clearly_stated:          0.4,
  consult_quantified_value_roi:            0.7,
  consult_demo_tax_saving:                 0.3,
  consult_fees_tax_deductible_explained:   0.4,
  consult_fees_annualised:                 0.3,
  consult_fee_phrasing_three_seven_five:   0.2,
  consult_specific_tax_estimate_given:     0.5,
  consult_confirm_reason_for_zoom:         0.2,
  consult_rapport_open:                    0.2,
  consult_interactive_throughout:          0.2,
  consult_next_contact_within_5_days:      0.3,
  consult_no_assumptions_evidence_gathered:0.2,
  consult_collected_dob_nin_when_agreed:   0.2,
};

function ensureArray(v){ if(Array.isArray(v)) return v.filter(Boolean).map(String); if(v==null) return []; return [String(v)].filter(Boolean); }
function toMultiline(v){ if(Array.isArray(v)) return v.join("\n"); if(v==null) return undefined; return String(v); }
function toShortList(primary, inferred=[], fallback=""){ const a=ensureArray(primary); if(a.length) return a.join("; ").slice(0, 1000); const b=ensureArray(inferred); return (b.length ? b.join("; ") : fallback).slice(0, 1000); }
function numberOrNull(v){ if(v==null) return null; const n=Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

function normaliseSentiment(v){ if(!v) return "Neutral"; const s=String(v).toLowerCase();
  if (s.includes("pos")) return "Positive";
  if (s.includes("neg")) return "Negative";
  return "Neutral";
}
function engagementNumberFromSentiment(sent){ return sent==="Positive" ? 3 : sent==="Negative" ? 1 : 2; }

/** Map analysis outcome/likelihood to your allowed set with close-detection guardrails. */
function mapConsultationOutcomeHS(outcomeText, likelihoodPct, analysis){
  const s = String(outcomeText || "").toLowerCase();
  const transcriptHints = [
    ...(ensureArray(analysis?.summary)),
    ...(ensureArray(analysis?.next_actions)),
    ...(ensureArray(analysis?.materials_to_send)),
  ].join(" ").toLowerCase();

  // If transcript clearly indicates they agreed/bought/booked -> Proceed now
  if (/\bproceed|signed|sign|go(-|\s*)ahead|commit|purchase|bought|agree(d)?|paid|payment|onboard|set[-\s]?up|application submitted/.test(transcriptHints)) {
    return "Proceed now";
  }

  if (/\bproceed now|signed|commit|purchase|buy|agreed/.test(s)) return "Proceed now";
  if (/\blikely|positive|good chance|favourable|favorable/.test(s)) return "Likely";
  if (/\bnot now|later|follow[-\s]?up|defer|wait/.test(s)) return "Not now";
  if (/\bno fit|not proceeding|won'?t proceed|decline|reject/.test(s)) return "No fit";
  if (/\bunclear|unsure|tbd|unknown/.test(s)) return "Unclear";

  const n = numberOrNull(likelihoodPct);
  if (n != null) {
    if (n >= 90) return "Proceed now";
    if (n >= 60) return "Likely";
    if (n >= 40) return "Unclear";
    if (n >= 20) return "Not now";
    return "No fit";
  }
  return "Unclear";
}

function adjustedLikelihood10(analysis, outcomeHS){
  const fromPct = toOneToTenFromPct(analysis?.likelihood_to_close);
  let score = fromPct ?? 5;
  if (outcomeHS === "Proceed now") score = Math.max(score, 10);
  return clamp(Math.round(score), 1, 10);
}

function toOneToTenFromPct(pct){
  const n = numberOrNull(pct);
  if (n==null) return null;
  return clamp(Math.max(1, Math.round(n/10)), 1, 10);
}

function mapProductInterest(products){
  const arr=ensureArray(products).map(p=>p.toLowerCase());
  const hasSSAS=arr.some(p=>p.includes("ssas")), hasFIC=arr.some(p=>p.includes("fic"));
  if (hasSSAS && hasFIC) return "Both"; if (hasSSAS) return "SSAS"; if (hasFIC) return "FIC"; return undefined;
}

/** Map our free-form categories to your **allowed single-select**: [Price, Timing, Risk, Complexity, Authority, Clarity]. */
function mapObjectionCategoryToAllowed(objs){
  const text = ensureArray(objs).join(" ").toLowerCase();
  if (/fee|cost|price/.test(text)) return "Price";
  if (/time|timeline|delay|month|week|schedule/.test(text)) return "Timing";
  if (/risk|volatile|uncertain|concern/.test(text)) return "Risk";
  if (/hmrc|compliance|tax|rules?|paperwork|process|admin|complex/.test(text)) return "Complexity";
  if (/authority|director|decision[-\s]?maker|trust|provider|sign[-\s]?off|approval/.test(text)) return "Authority";
  if (/confus|unclear|don.?t understand|clarif/.test(text)) return "Clarity";
  return null; // IMPORTANT: return null rather than an invalid value
}

function normaliseSeverity(v){
  const s = String(v || "").toLowerCase();
  if (s.startsWith("h")) return "High";
  if (s.startsWith("m")) return "Medium";
  return "Low";
}

function inferDecisionCriteriaFromSummary(summaryArr){
  const s = ensureArray(summaryArr).join(" ").toLowerCase();
  const crit = [];
  if (/fee|cost|price|charges?/.test(s)) crit.push("Fees/Cost");
  if (/timeline|speed|quick|delay|month|week/.test(s)) crit.push("Timeline");
  if (/hmrc|compliance|tax|rules?/.test(s)) crit.push("Compliance/Tax");
  if (/property|investment|platform|trading/.test(s)) crit.push("Investment/Platform fit");
  if (/loan|bridge|finance|cashflow/.test(s)) crit.push("Funding/Cashflow");
  if (/trust|provider|previous/.test(s)) crit.push("Provider reliability");
  return Array.from(new Set(crit));
}

function buildScoreReasoning(analysis, score10){
  const parts = [];
  if (score10 != null) parts.push(`Score chosen: ${score10}/10`);
  const obs = ensureArray(analysis?.objections);
  if (obs.length) parts.push(`Objections: ${obs.join("; ")}`);
  const na = ensureArray(analysis?.next_actions);
  if (na.length) parts.push(`Next steps: ${na.join("; ")}`);
  const kd = analysis?.key_details || {};
  if (kd.timeline) parts.push(`Timeline: ${kd.timeline}`);
  return parts.join("\n").slice(0, 3000) || "No specific rationale found in transcript.";
}

function buildIncreaseLikelihood(analysis){
  const hints = [
    ...(ensureArray(analysis?.next_actions).slice(0,2)),
    ...(ensureArray(analysis?.materials_to_send).slice(0,1))
  ];
  const out = [];
  for (const h of hints) out.push(`• ${h}`);
  while (out.length < 3) out.push("• Confirm clear next step & date.");
  return out.slice(0,3).join("\n");
}

function buildDataPointsCaptured(kd){
  if (!kd) return "";
  const items = [];
  if (kd.client_name) items.push(`Name: ${kd.client_name}`);
  if (kd.company_name) items.push(`Company: ${kd.company_name}`);
  if (kd.address) items.push(`Address: ${kd.address}`);
  if (kd.dob) items.push(`DOB: ${kd.dob}`);
  if (kd.ni || kd.nino) items.push(`NI: ${kd.ni || kd.nino}`);
  if (kd.timeline) items.push(`Timeline: ${kd.timeline}`);
  return items.join("\n").slice(0, 5000);
}

function buildCoachingSummary(analysis){
  const s = String(analysis?.sales_performance_summary || "").trim();
  if (s) return s.slice(0, 9000);
  const ww = ensureArray(analysis?.summary).slice(0,2).map(x=>`- ${x}`).join("\n") || "- Rapport established.";
  const imp = ["- Ask for a specific commitment.","- Confirm next step & date."].join("\n");
  return `What went well:\n${ww}\n\nAreas to improve:\n${imp}`;
}

/** Build 20 consult_* flags from consult_eval (0/0.5/1) + light inference from analysis text. */
function buildConsultFlags(analysis){
  const ev = analysis?.consult_eval || {};
  const yes01 = (v)=> Number(v) >= 0.75 ? 1 : (Number(v) > 0 ? 1 : 0);
  const text = [
    ...(ensureArray(analysis?.summary)),
    ...(ensureArray(analysis?.next_actions)),
    ...(ensureArray(analysis?.materials_to_send))
  ].join(" ").toLowerCase();

  const outcomeHS = mapConsultationOutcomeHS(analysis?.outcome, analysis?.likelihood_to_close, analysis);
  const like10 = adjustedLikelihood10(analysis, outcomeHS);

  const specificDateRegex = /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\bmon|tue|wed|thu|fri|sat|sun\b|\btomorrow\b|\bnext (mon|tue|wed|thu|fri|week)\b|\b\d{1,2}:\d{2}\b|\b(am|pm)\b)/i;
  const feePhraseRegex = /\b(375|three[-\s]?seven[-\s]?five|£?375)\b/;
  const buySignalRegex = /\b(ready|keen|let'?s proceed|go ahead|how do we|what next|timeline|when can we|send (the )?agreement|invoice|payment)\b/i;

  return {
    consult_closing_question_asked:           yes01(ev.commitment_requested ?? 0),
    consult_collected_dob_nin_when_agreed:    analysis?.key_details?.dob || analysis?.key_details?.ni || analysis?.key_details?.nino ? 1 : 0,
    consult_confirm_reason_for_zoom:          yes01(ev.intro ?? 0) || /reason|purpose/.test(text) ? 1 : 0,
    consult_customer_agreed_to_set_up:        outcomeHS === "Proceed now" || /\b(agree|agreed|sign|signed|purchase|bought|payment|onboard|set[-\s]?up)\b/i.test(text) ? 1 : 0,
    consult_demo_tax_saving:                  /tax saving|save.*tax|tax-efficient/.test(text) ? 1 : 0,
    consult_fee_phrasing_three_seven_five:    feePhraseRegex.test(text) ? 1 : 0,
    consult_fees_annualised:                  yes01(ev.fees_annualised ?? 0) || /annualis|per year|per annum|p\.a\./i.test(text) ? 1 : 0,
    consult_fees_tax_deductible_explained:    yes01(ev.fees_tax_deductible_explained ?? 0) || /tax[-\s]?deductible/.test(text) ? 1 : 0,
    consult_interactive_throughout:           yes01(ev.interactive_throughout ?? 0.5),
    consult_needs_pain_uncovered:             yes01(ev.needs_pain_uncovered ?? 0),
    consult_next_contact_within_5_days:       /\b(1|2|3|4|5)\s*(day|days)\b/i.test(text) || /\btomorrow\b/i.test(text) ? 1 : 0,
    consult_next_step_specific_date_time:     yes01(ev.next_step_specific_date_time ?? 0) || specificDateRegex.test(text) ? 1 : 0,
    consult_no_assumptions_evidence_gathered: yes01(ev.clear_responses_or_followup ?? 0) || yes01(ev.active_listening ?? 0),
    consult_overcame_objection_and_closed:    (ensureArray(analysis?.objections).length > 0 && (outcomeHS === "Proceed now" || like10 >= 8)) ? 1 : 0,
    consult_prospect_asked_next_steps:        /\bwhat (are|’re|'re) (the )?next steps\b/i.test(text) ? 1 : 0,
    consult_purpose_clearly_stated:           /purpose|agenda|we’ll cover|we will cover|today we’ll/i.test(text) ? 1 : 0,
    consult_quantified_value_roi:             yes01(ev.quantified_value_roi ?? 0) || /\b(roi|return|save £?\d+|£\d+)/i.test(text) ? 1 : 0,
    consult_rapport_open:                     yes01(ev.rapport_open ?? 0.5),
    consult_specific_tax_estimate_given:      yes01(ev.specific_tax_estimate_given ?? 0) || /\b£\s*\d{2,}(,\d{3})*\b.*tax/i.test(text) ? 1 : 0,
    consult_strong_buying_signals_detected:   buySignalRegex.test(text) || like10 >= 7 ? 1 : 0,
  };
}
