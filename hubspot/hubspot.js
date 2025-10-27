// hubspot/hubspot.js — v1.12c (qualification call -> ai_qualification_*; scorecard + forced assoc unchanged)
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

console.log("hubspot.js — v1.10 (expected)");
if (!HUBSPOT_TOKEN) {
  console.warn("[warn] HubSpot token missing: set HUBSPOT_PRIVATE_APP_TOKEN (preferred) or HUBSPOT_TOKEN");
}
console.log("hubspot.js — v1.10");

const HS = {
  base: "https://api.hubapi.com",
  jsonHeaders: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  },
};

async function hsFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), ...HS.jsonHeaders },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${url} -> ${res.status} ${text}`);
  }
  try { return await res.json(); } catch { return {}; }
}

// ---------- Normalisers ----------
const toText = (v, fb = "") => {
  if (v == null) return fb;
  if (Array.isArray(v)) return v.map((x) => toText(x, "")).filter(Boolean).join("; ");
  if (typeof v === "object") return String(v?.text ?? v?.content ?? v?.value ?? JSON.stringify(v));
  const s = String(v).trim();
  return s || fb;
};
const toLines = (v) => Array.isArray(v) ? v.map(x => toText(x, "")).filter(Boolean).join("\n") : toText(v, "");
const toNumberOrNull = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

// ---------- READ HELPERS ----------
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

// ---------- ASSOCIATION DISCOVERY/ATTEMPTS (unchanged) ----------
async function discoverAssocMeta(fromType, toType) {
  try {
    const url = `${HS.base}/crm/v4/associations/${fromType}/${toType}/labels`;
    const data = await hsFetch(url);
    const list = data?.results || [];
    const preferred = list.find((x) => x?.category === "HUBSPOT_DEFINED") || list[0] || null;
    return { list, preferred };
  } catch (e) {
    console.warn(`[warn] labels discovery failed for ${fromType} -> ${toType}:`, e.message);
    return { list: [], preferred: null };
  }
}
async function assocTryV4Single(fromType, fromId, toType, toId, typeId) {
  const url = `${HS.base}/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}/${typeId}`;
  await hsFetch(url, { method: "PUT" });
  return "v4-single";
}
async function assocTryV4BatchTypeId(fromType, fromId, toType, toId, typeId) {
  const url = `${HS.base}/crm/v4/associations/${fromType}/${toType}/batch/create`;
  const body = { inputs: [{ from: { id: String(fromId) }, to: { id: String(toId) },
    types: [{ associationCategory: "USER_DEFINED", associationTypeId: Number(typeId) }], }] };
  await hsFetch(url, { method: "POST", body: JSON.stringify(body) });
  return "v4-batch-typeId";
}
async function assocTryV3BatchLabel(fromType, fromId, toType, toId, label) {
  const url = `${HS.base}/crm/v3/associations/${fromType}/${toType}/batch/create`;
  const body = { inputs: [{ from: { id: String(fromId) }, to: { id: String(toId) }, type: String(label) }] };
  await hsFetch(url, { method: "POST", body: JSON.stringify(body) });
  return "v3-batch-label";
}
async function associateSmart(fromType, fromId, toType, toId) {
  const { list, preferred } = await discoverAssocMeta(fromType, toType);
  if (!preferred) { console.warn(`[warn] No association types returned for ${fromType} -> ${toType}`); return false; }
  const candidates = [preferred, ...list.filter((x) => x !== preferred)];
  for (const c of candidates) {
    const typeId = c.typeId || c.id;
    const label = c.label || String(typeId);
    try { console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId} via ${await assocTryV4Single(fromType,fromId,toType,toId,typeId)} (typeId=${typeId}, label=${label})`); return true; } catch {}
    try { console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId} via ${await assocTryV4BatchTypeId(fromType,fromId,toType,toId,typeId)} (typeId=${typeId}, label=${label})`); return true; } catch {}
    try { console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId} via ${await assocTryV3BatchLabel(fromType,fromId,toType,toId,label)} (typeId=${typeId}, label=${label})`); return true; } catch {}
  }
  console.warn(`[warn] Association attempts exhausted for ${fromType}:${fromId} -> ${toType}:${toId}`);
  return false;
}

// ---------- HARDENED types[] CALLS↔SCORECARDS + CONTACTS/DEALS (unchanged) ----------
export async function associateScorecardAllViaTypes({ scorecardId, callId, contactIds = [], dealIds = [] }) {
  console.log(`[assoc] FORCED entry scorecardId=${scorecardId}, callId=${callId}, contacts=${contactIds.join(",")}, deals=${dealIds.join(",")}`);
  const TYPE_SCORECARDS_TO_CALLS = 395, TYPE_CALLS_TO_SCORECARDS = 396, TYPE_SCORECARDS_TO_CONTACTS = 421, TYPE_SCORECARDS_TO_DEALS = 423;
  if (!scorecardId || !callId) { console.warn("[assoc] missing scorecardId or callId; skipping assoc."); return; }
  async function verifyAssoc(fromType, fromId, toType) {
    const url = `${HS.base}/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=100`;
    try { const data = await hsFetch(url); const count = (data?.results || []).length; console.log(`[assoc] verify ${fromType}:${fromId} -> ${toType}: ${count} linked`); return count; }
    catch (e) { console.warn(`[assoc] verify error for ${fromType}:${fromId} -> ${toType}:`, e.message); return 0; }
  }
  try {
    await hsFetch(`${HS.base}/crm/v4/associations/calls/p49487487_sales_scorecards/batch/create`, { method:"POST",
      body: JSON.stringify({ inputs: [{ from:{id:String(callId)}, to:{id:String(scorecardId)},
        types:[{ associationCategory:"USER_DEFINED", associationTypeId: TYPE_CALLS_TO_SCORECARDS }] }] }) });
    console.log(`[assoc] FORCED calls:${callId} -> scorecards:${scorecardId} (typeId=${TYPE_CALLS_TO_SCORECARDS})`);
    await verifyAssoc("calls", String(callId), "p49487487_sales_scorecards");

    await hsFetch(`${HS.base}/crm/v4/associations/p49487487_sales_scorecards/calls/batch/create`, { method:"POST",
      body: JSON.stringify({ inputs: [{ from:{id:String(scorecardId)}, to:{id:String(callId)},
        types:[{ associationCategory:"USER_DEFINED", associationTypeId: TYPE_SCORECARDS_TO_CALLS }] }] }) });
    console.log(`[assoc] FORCED scorecards:${scorecardId} -> calls:${callId} (typeId=${TYPE_SCORECARDS_TO_CALLS})`);
    await verifyAssoc("p49487487_sales_scorecards", String(scorecardId), "calls");

    if (contactIds.length) {
      const inputs = contactIds.map((cid) => ({ from:{id:String(scorecardId)}, to:{id:String(cid)},
        types:[{ associationCategory:"USER_DEFINED", associationTypeId: TYPE_SCORECARDS_TO_CONTACTS }] }));
      await hsFetch(`${HS.base}/crm/v4/associations/p49487487_sales_scorecards/contacts/batch/create`, { method:"POST", body: JSON.stringify({ inputs }) });
      console.log(`[assoc] FORCED scorecards:${scorecardId} -> contacts:${contactIds.join(",")} (typeId=${TYPE_SCORECARDS_TO_CONTACTS})`);
      await verifyAssoc("p49487487_sales_scorecards", String(scorecardId), "contacts");
    }
    if (dealIds.length) {
      const inputs = dealIds.map((did) => ({ from:{id:String(scorecardId)}, to:{id:String(did)},
        types:[{ associationCategory:"USER_DEFINED", associationTypeId: TYPE_SCORECARDS_TO_DEALS }] }));
      await hsFetch(`${HS.base}/crm/v4/associations/p49487487_sales_scorecards/deals/batch/create`, { method:"POST", body: JSON.stringify({ inputs }) });
      console.log(`[assoc] FORCED scorecards:${scorecardId} -> deals:${dealIds.join(",")} (typeId=${TYPE_SCORECARDS_TO_DEALS})`);
      await verifyAssoc("p49487487_sales_scorecards", String(scorecardId), "deals");
    }
  } catch (err) { console.warn("[assoc] association error:", err.message); }
}

// ---------- CALL UPDATE (Initial Consultation path) ----------
export async function updateCall(callId, analysis) {
  const callType = analysis?.call_type || "Initial Consultation";
  const conf = typeof analysis?.ai_call_type_confidence === "number" ? String(analysis.ai_call_type_confidence) : "90";
  const decisionCriteria = Array.isArray(analysis?.ai_decision_criteria) ? analysis.ai_decision_criteria : [];
  const materials = Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length ? analysis.materials_to_send : [];
  const nextSteps = Array.isArray(analysis?.next_actions) && analysis.next_actions.length ? analysis.next_actions : [];
  const objections = Array.isArray(analysis?.objections) ? analysis.objections : [];
  const dataPointsText = typeof analysis?.__data_points_captured_text === "string" && analysis.__data_points_captured_text.trim().length
    ? analysis.__data_points_captured_text : "No personal data captured.";
  let productInterest = ""; const pd = analysis?.key_details?.products_discussed || [];
  if (pd.length === 2) productInterest = "Both"; else if (pd.length === 1) productInterest = pd[0] || "";
  if (!productInterest) productInterest = "Not mentioned";
  const likeToClose = typeof analysis?.likelihood_to_close === "number" ? Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10))) : 1;

  const allowed = new Set(["Price","Timing","Risk","Complexity","Authority","Clarity"]);
  let aiCat = "Clarity";
  if (objections.some((o)=>/price|fee|cost/i.test(o))) aiCat = "Price";
  else if (objections.some((o)=>/time|timeline|delay/i.test(o))) aiCat = "Timing";
  else if (objections.some((o)=>/risk/i.test(o))) aiCat = "Risk";
  else if (objections.some((o)=>/complex/i.test(o))) aiCat = "Complexity";
  else if (objections.some((o)=>/authority|sign off|decision/i.test(o))) aiCat = "Authority";
  if (!allowed.has(aiCat)) aiCat = "Clarity";

  const increaseLikely = Array.isArray(analysis?.increase_likelihood) ? analysis.increase_likelihood.join("; ") : (analysis?.increase_likelihood || "No suggestions.");
  const perfSummary = analysis?.sales_performance_summary || "No specific coaching available.";
  const perfScore = typeof analysis?.sales_performance_rating === "number" ? String(analysis.sales_performance_rating) : "";
  const scoreReason = analysis?.score_reasoning || "No reasoning provided.";
  const missingInfo = typeof analysis?.ai_missing_information === "string" && analysis.ai_missing_information.trim()
    ? analysis.ai_missing_information : "Nothing requested or all information provided.";
  const requestedMaterials = materials.length > 0 ? materials.join("; ") : "Nothing requested";

  const props = {
    ai_inferred_call_type: callType,
    ai_call_type_confidence: conf,
    ai_consultation_outcome: analysis?.outcome || "Unclear",
    ai_consultation_likelihood_to_close: String(likeToClose),
    ai_product_interest: productInterest,
    ai_decision_criteria: decisionCriteria.join("; "),
    ai_data_points_captured: dataPointsText,
    ai_missing_information: missingInfo,
    ai_consultation_required_materials: requestedMaterials,
    ai_next_steps: nextSteps.length ? nextSteps.join("; ") : "No next steps mentioned.",
    ai_key_objections: objections.length ? objections.join("; ") : "No objections",
    ai_objections_bullets: objections.length ? objections.join(" • ") : "No objections",
    ai_primary_objection: objections[0] || "No objection",
    ai_objection_severity: analysis?.ai_objection_severity || "Medium",
    ai_objection_categories: aiCat,
    chat_gpt___increase_likelihood_of_sale_suggestions: increaseLikely,
    chat_gpt___sales_performance: perfScore,
    chat_gpt___score_reasoning: scoreReason,
    sales_performance_summary: perfSummary,
  };

  const url = `${HS.base}/crm/v3/objects/calls/${callId}`;
  try { await hsFetch(url, { method: "PATCH", body: JSON.stringify({ properties: props }) }); }
  catch (e) { console.warn("[HubSpot] PATCH", url, "failed:", e.message); }

  try {
    const after = await getHubSpotObject("calls", callId, Object.keys(props));
    console.log("[debug] Call updated:", after?.properties || after);
  } catch {}
}

// ---------- Qualification Call updater (WRITE ai_qualification_* on Call) ----------
export async function updateQualificationCall(callId, data) {
  const token = HUBSPOT_TOKEN;
  if (!callId || !token) { console.warn("[qual] Missing callId or HubSpot token"); return; }

  const url = `${HS.base}/crm/v3/objects/calls/${callId}`;

  // Map outputs to the *qualification* fields on the Call record
  const props = {
    ai_inferred_call_type: "Qualification call",
    ai_call_type_confidence: 90,

    // *** Qualification-specific call properties ***
    ai_qualification_likelihood_to_proceed: toNumberOrNull(
      data?.ai_consultation_likelihood_to_close ?? data?.ai_qualification_likelihood_to_proceed
    ),
    ai_qualification_outcome: toText(
      data?.ai_qualification_outcome ?? data?.outcome ?? "Unclear"
    ),
    ai_qualification_required_materials: toLines(
      data?.ai_consultation_required_materials ?? data?.ai_qualification_required_materials
    ),
    ai_qualification_decision_criteria: toLines(
      data?.ai_decision_criteria ?? data?.ai_qualification_decision_criteria
    ),
    ai_qualification_key_objections: toLines(
      data?.ai_key_objections ?? data?.ai_qualification_key_objections
    ),
    ai_qualification_next_steps: toLines(
      data?.ai_next_steps ?? data?.ai_qualification_next_steps
    ),

    // keep these generic analysis/coaching fields too (harmless if you don’t use them)
    sales_performance_summary: toLines(data?.sales_performance_summary),
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

// ---------- Qualification Scorecard creator (unchanged from v1.12b) ----------
export async function createQualificationScorecard({ callId, contactIds = [], data }) {
  const token = HUBSPOT_TOKEN;
  if (!token) { console.error("Missing HubSpot token"); return null; }

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

  const props = {
    activity_type: "Qualification call",
    activity_name: `${callId} — Qualification call — ${today}`,

    sales_scorecard___what_you_can_improve_on: toLines(data?.sales_performance_summary),
    sales_performance_rating_: toNumberOrNull(data?.chat_gpt_sales_performance),

    ai_next_steps: toLines(data?.ai_qualification_next_steps ?? data?.ai_next_steps),
    ai_consultation_required_materials: toLines(data?.ai_qualification_required_materials ?? data?.ai_consultation_required_materials),
    ai_decision_criteria: toLines(data?.ai_qualification_decision_criteria ?? data?.ai_decision_criteria),
    ai_key_objections: toLines(data?.ai_qualification_key_objections ?? data?.ai_key_objections),
    ai_consultation_outcome: toText(data?.ai_qualification_outcome ?? data?.outcome ?? "Unclear"),
    ai_consultation_likelihood_to_close: toNumberOrNull(data?.ai_qualification_likelihood_to_proceed ?? data?.ai_consultation_likelihood_to_close),

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

  // assoc is handled by index.js
  return scorecardId;
}

// ---------- SCORECARD CREATE + ASSOC (Initial Consultation) ----------
export async function createScorecard(analysis, ctx) {
  const { callId, contactIds = [], dealIds = [], ownerId } = ctx || {};
  const objectType = "p49487487_sales_scorecards";

  const ce = analysis?.consult_eval || {};
  const fv = (v) => (v === 1 ? 1 : 0);
  const tenScale = typeof analysis?.likelihood_to_close === "number" ? Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10))) : 1;

  const props = {
    activity_type: "Initial Consultation",
    activity_name: `${callId} — Initial Consultation — ${new Date().toISOString().slice(0, 10)}`,
    hubspot_owner_id: ownerId || undefined,

    sales_performance_rating_: Number(analysis?.sales_performance_rating || 1),
    sales_scorecard___what_you_can_improve_on:
      analysis?.sales_performance_summary || "What went well:\n- \n\nAreas to improve:\n- ",

    ai_next_steps: (analysis?.next_actions || []).join("; "),
    ai_consultation_required_materials:
      (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length
        ? analysis.materials_to_send.join("; ")
        : "Nothing requested"),
    ai_decision_criteria: (analysis?.ai_decision_criteria || []).join("; "),
    ai_key_objections: (analysis?.objections || []).join("; ") || "No objections",
    ai_consultation_outcome: analysis?.outcome || "Unclear",
    ai_consultation_likelihood_to_close: String(tenScale),

    consult_closing_question_asked: fv(ce.commitment_requested),
    consult_collected_dob_nin_when_agreed: fv(ce.specific_tax_estimate_given),
    consult_confirm_reason_for_zoom: fv(ce.intro),
    consult_customer_agreed_to_set_up: fv(analysis?.outcome === "Proceed now" ? 1 : ce.commitment_requested),
    consult_demo_tax_saving: fv(ce.quantified_value_roi),
    consult_fee_phrasing_three_seven_five: fv(ce.fees_tax_deductible_explained),
    consult_fees_annualised: fv(ce.fees_tax_deductible_explained),
    consult_fees_tax_deductible_explained: fv(ce.fees_tax_deductible_explained),
    consult_interactive_throughout: fv(ce.interactive_throughout),
    consult_needs_pain_uncovered: fv(ce.needs_pain_uncovered),
    consult_next_contact_within_5_days: fv(ce.next_step_specific_date_time),
    consult_next_step_specific_date_time: fv(ce.next_step_specific_date_time),
    consult_no_assumptions_evidence_gathered: fv(ce.clear_responses_or_followup),
    consult_overcame_objection_and_closed: fv(ce.commitment_requested),
    consult_prospect_asked_next_steps: fv(ce.next_steps_confirmed),
    consult_purpose_clearly_stated: fv(ce.services_explained_clearly),
    consult_quantified_value_roi: fv(ce.quantified_value_roi),
    consult_rapport_open: fv(ce.rapport_open),
    consult_specific_tax_estimate_given: fv(ce.specific_tax_estimate_given),
    consult_strong_buying_signals_detected: fv(ce.benefits_linked_to_needs),
  };

  const weights = {
    consult_customer_agreed_to_set_up: 2,
    consult_overcame_objection_and_closed: 1,
    consult_next_step_specific_date_time: 0.7,
    consult_closing_question_asked: 0.6,
    consult_prospect_asked_next_steps: 0.4,
    consult_strong_buying_signals_detected: 0.6,
    consult_needs_pain_uncovered: 0.6,
    consult_purpose_clearly_stated: 0.4,
    consult_quantified_value_roi: 0.7,
    consult_demo_tax_saving: 0.3,
    consult_fees_tax_deductible_explained: 0.4,
    consult_fees_annualised: 0.3,
    consult_fee_phrasing_three_seven_five: 0.2,
    consult_specific_tax_estimate_given: 0.5,
    consult_confirm_reason_for_zoom: 0.2,
    consult_rapport_open: 0.2,
    consult_interactive_throughout: 0.2,
    consult_next_contact_within_5_days: 0.3,
    consult_no_assumptions_evidence_gathered: 0.2,
    consult_collected_dob_nin_when_agreed: 0.2,
  };
  let weighted = 0;
  for (const [k, w] of Object.entries(weights)) weighted += (Number(props[k]) || 0) * w;
  props["consult_score_final"] = Math.max(1, Math.min(10, Math.round(weighted * 10) / 10));

  // Create scorecard
  const createUrl = `${HS.base}/crm/v3/objects/${objectType}`;
  let scorecardId = null;
  try {
    const created = await hsFetch(createUrl, { method: "POST", body: JSON.stringify({ properties: props }) });
    scorecardId = created?.id;
    console.log("[scorecard] created id:", scorecardId);
  } catch (e) {
    console.warn("[HubSpot] create scorecard failed:", e.message);
    return null;
  }
  if (!scorecardId) return null;

  await associateSmart(objectType, scorecardId, "calls", String(callId));
  for (const cid of contactIds || []) await associateSmart(objectType, scorecardId, "contacts", String(cid));
  for (const did of dealIds || []) await associateSmart(objectType, scorecardId, "deals", String(did));
  await associateScorecardAllViaTypes({ scorecardId, callId, contactIds, dealIds });
  return scorecardId;
}
