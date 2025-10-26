// hubspot/hubspot.js
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

if (!HUBSPOT_TOKEN) {
  console.warn(
    "[warn] HubSpot token missing: set HUBSPOT_PRIVATE_APP_TOKEN (preferred) or HUBSPOT_TOKEN"
  );
}

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
  // some assoc endpoints return 204/empty
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// ---------- READ HELPERS ----------
export async function getHubSpotObject(objectType, objectId, properties = []) {
  const qs = properties.length ? `?properties=${encodeURIComponent(properties.join(","))}` : "";
  const url = `${HS.base}/crm/v3/objects/${objectType}/${objectId}${qs}`;
  try {
    return await hsFetch(url);
  } catch (err) {
    throw new Error(`HubSpot get ${objectType}/${objectId} failed: ${err.message}`);
  }
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

// ---------- ASSOCIATION DISCOVERY ----------
async function discoverAssocMeta(fromType, toType) {
  // returns { list: [{typeId, id, label, category}], preferred }
  try {
    const url = `${HS.base}/crm/v4/associations/${fromType}/${toType}/labels`;
    const data = await hsFetch(url);
    const list = data?.results || [];
    const preferred =
      list.find((x) => x?.category === "HUBSPOT_DEFINED") || list[0] || null;
    return { list, preferred };
  } catch (e) {
    console.warn(`[warn] labels discovery failed for ${fromType} -> ${toType}:`, e.message);
    return { list: [], preferred: null };
  }
}

// ---------- ASSOCIATION ATTEMPTS (3 strategies) ----------
async function assocTryV4Single(fromType, fromId, toType, toId, typeId) {
  const url = `${HS.base}/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}/${typeId}`;
  await hsFetch(url, { method: "PUT" }); // no body
  return "v4-single";
}

async function assocTryV4BatchTypeId(fromType, fromId, toType, toId, typeId) {
  const url = `${HS.base}/crm/v4/associations/${fromType}/${toType}/batch/create`;
  const body = { inputs: [{ from: { id: String(fromId) }, to: { id: String(toId) }, type: String(typeId) }] };
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
  if (!preferred) {
    console.warn(`[warn] No association types returned for ${fromType} -> ${toType}`);
    return false;
  }

  // Try with preferred first; if needed, try others.
  const candidates = [preferred, ...list.filter((x) => x !== preferred)];

  for (const c of candidates) {
    const typeId = c.typeId || c.id;
    const label = c.label || String(typeId);

    // 1) v4 single (typeId in path)
    try {
      const how = await assocTryV4Single(fromType, fromId, toType, toId, typeId);
      console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId} via ${how} (typeId=${typeId}, label=${label})`);
      return true;
    } catch (_) {}

    // 2) v4 batch (typeId in "type")
    try {
      const how = await assocTryV4BatchTypeId(fromType, fromId, toType, toId, typeId);
      console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId} via ${how} (typeId=${typeId}, label=${label})`);
      return true;
    } catch (_) {}

    // 3) v3 batch (label string)
    try {
      const how = await assocTryV3BatchLabel(fromType, fromId, toType, toId, label);
      console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId} via ${how} (typeId=${typeId}, label=${label})`);
      return true;
    } catch (e) {
      // keep looping to next candidate
    }
  }

  console.warn(`[warn] Association attempts exhausted for ${fromType}:${fromId} -> ${toType}:${toId}`);
  return false;
}

// ---------- CALL UPDATE ----------
export async function updateCall(callId, analysis) {
  const callType = analysis?.call_type || "Initial Consultation";
  const conf =
    typeof analysis?.ai_call_type_confidence === "number"
      ? String(analysis.ai_call_type_confidence)
      : "90";

  const decisionCriteria = Array.isArray(analysis?.ai_decision_criteria)
    ? analysis.ai_decision_criteria
    : [];

  const materials =
    (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length > 0)
      ? analysis.materials_to_send
      : [];

  const nextSteps =
    (Array.isArray(analysis?.next_actions) && analysis.next_actions.length > 0)
      ? analysis.next_actions
      : [];

  const objections = Array.isArray(analysis?.objections) ? analysis.objections : [];

  const dataPointsText =
    typeof analysis?.__data_points_captured_text === "string" &&
    analysis.__data_points_captured_text.trim().length
      ? analysis.__data_points_captured_text
      : "No personal data captured.";

  let productInterest = "";
  const pd = analysis?.key_details?.products_discussed || [];
  if (pd.length === 2) productInterest = "Both";
  else if (pd.length === 1) productInterest = pd[0] || "";
  if (!productInterest) productInterest = "Not mentioned";

  const likeToClose =
    typeof analysis?.likelihood_to_close === "number"
      ? Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10)))
      : 1;

  const allowedCategories = new Set(["Price","Timing","Risk","Complexity","Authority","Clarity"]);
  let aiCat = "Clarity";
  if (objections.some(o => /price|fee|cost/i.test(o))) aiCat = "Price";
  else if (objections.some(o => /time|timeline|delay/i.test(o))) aiCat = "Timing";
  else if (objections.some(o => /risk/i.test(o))) aiCat = "Risk";
  else if (objections.some(o => /complex/i.test(o))) aiCat = "Complexity";
  else if (objections.some(o => /authority|sign off|decision/i.test(o))) aiCat = "Authority";
  if (!allowedCategories.has(aiCat)) aiCat = "Clarity";

  const increaseLikely = Array.isArray(analysis?.increase_likelihood)
    ? analysis.increase_likelihood.join("; ")
    : (analysis?.increase_likelihood || "No suggestions.");
  const perfSummary = analysis?.sales_performance_summary || "No specific coaching available.";
  const perfScore =
    typeof analysis?.sales_performance_rating === "number"
      ? String(analysis.sales_performance_rating)
      : "";
  const scoreReason = analysis?.score_reasoning || "No reasoning provided.";

  const missingInfo =
    typeof analysis?.ai_missing_information === "string" && analysis.ai_missing_information.trim()
      ? analysis.ai_missing_information
      : "Nothing requested or all information provided.";

  const requestedMaterials =
    materials.length > 0 ? materials.join("; ") : "Nothing requested";

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
  try {
    await hsFetch(url, {
      method: "PATCH",
      body: JSON.stringify({ properties: props }),
    });
  } catch (e) {
    console.warn("[HubSpot] PATCH", url, "failed:", e.message);
  }

  try {
    const after = await getHubSpotObject("calls", callId, [
      "ai_inferred_call_type",
      "ai_call_type_confidence",
      "ai_consultation_outcome",
      "ai_consultation_likelihood_to_close",
      "ai_product_interest",
      "ai_decision_criteria",
      "ai_data_points_captured",
      "ai_missing_information",
      "ai_consultation_required_materials",
      "ai_next_steps",
      "ai_key_objections",
      "ai_objections_bullets",
      "ai_primary_objection",
      "ai_objection_severity",
      "ai_objection_categories",
      "chat_gpt___increase_likelihood_of_sale_suggestions",
      "chat_gpt___sales_performance",
      "chat_gpt___score_reasoning",
      "sales_performance_summary",
    ]);
    console.log("[debug] Call updated:", after?.properties || after);
  } catch {}
}

// ---------- SCORECARD CREATE + ASSOC ----------
export async function createScorecard(analysis, ctx) {
  const { callId, contactIds = [], dealIds = [], ownerId } = ctx || {};
  const objectType = "p49487487_sales_scorecards";

  const ce = analysis?.consult_eval || {};
  const fv = (v) => (v === 1 ? 1 : 0);

  const tenScale =
    typeof analysis?.likelihood_to_close === "number"
      ? Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10)))
      : 1;

  const props = {
    activity_type: "Initial Consultation",
    activity_name: `${callId} — Initial Consultation — ${new Date().toISOString().slice(0, 10)}`,
    hubspot_owner_id: ownerId || undefined,

    sales_performance_rating_: Number(analysis?.sales_performance_rating || 1),
    sales_scorecard___what_you_can_improve_on:
      analysis?.sales_performance_summary ||
      "What went well:\n- \n\nAreas to improve:\n- ",

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
  for (const [k, w] of Object.entries(weights)) {
    const v = Number(props[k]) || 0;
    weighted += v * w;
  }
  props["consult_score_final"] = Math.max(1, Math.min(10, Math.round(weighted * 10) / 10));

  // Create scorecard
  const createUrl = `${HS.base}/crm/v3/objects/${objectType}`;
  let scorecardId = null;
  try {
    const created = await hsFetch(createUrl, {
      method: "POST",
      body: JSON.stringify({ properties: props }),
    });
    scorecardId = created?.id;
    console.log("[scorecard] created id:", scorecardId);
  } catch (e) {
    console.warn("[HubSpot] create scorecard failed:", e.message);
    return null;
  }

  if (!scorecardId) return null;

  // Always associate to the Call; optionally to contacts/deals
  const assocOK = await associateSmart(objectType, scorecardId, "calls", String(callId));
  for (const cid of (ctx?.contactIds || [])) {
    await associateSmart(objectType, scorecardId, "contacts", String(cid));
  }
  for (const did of (ctx?.dealIds || [])) {
    await associateSmart(objectType, scorecardId, "deals", String(did));
  }

  if (!assocOK) {
    console.warn("[warn] scorecard was created but not linked to the Call (will still exist).");
  }
  return scorecardId;
}
