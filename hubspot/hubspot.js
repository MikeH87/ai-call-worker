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

// ---------- Generic fetch wrapper ----------
async function hsFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), ...HS.jsonHeaders },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${init.method || "GET"} ${url} failed: ${res.status} ${text}`);
  }
  return res.json().catch(() => ({}));
}

// ---------- Read helpers ----------
export async function getHubSpotObject(objectType, objectId, properties = []) {
  const qs = properties.length ? `?properties=${encodeURIComponent(properties.join(","))}` : "";
  const url = `${HS.base}/crm/v3/objects/${objectType}/${objectId}${qs}`;
  try {
    return await hsFetch(url);
  } catch (err) {
    throw new Error(`HubSpot get ${objectType}/${objectId} failed: ${err.message}`);
  }
}

export async function getAssociations(objectId, toType) {
  // Returns array of associated IDs (simple helper for calls -> contacts/deals)
  const url = `${HS.base}/crm/v4/objects/calls/${objectId}/associations/${toType}`;
  try {
    const data = await hsFetch(url);
    const ids =
      data?.results?.map((r) => String(r.toObjectId)).filter(Boolean) ||
      data?.results?.map((r) => String(r.id)).filter(Boolean) ||
      [];
    return ids.map((x) => (/\d+/.test(x) ? Number(x) : x));
  } catch (e) {
    console.warn(`[warn] getAssociations calls/${objectId} -> ${toType} failed:`, e.message);
    return [];
  }
}

// ---------- Association helpers (v4) ----------

// Try to discover a valid associationTypeId, then fall back to known IDs you gave me.
async function getAssociationTypeId(fromType, toType) {
  const fallback = {
    "p49487487_sales_scorecards->calls": 395,
    "p49487487_sales_scorecards->contacts": 421,
    "p49487487_sales_scorecards->deals": 423,
  };
  const key = `${fromType}->${toType}`;

  try {
    const url = `${HS.base}/crm/v4/associations/${fromType}/${toType}/labels`;
    const data = await hsFetch(url);
    const list = data?.results || [];
    const preferred =
      list.find((x) => x?.category === "HUBSPOT_DEFINED") ||
      list[0];
    return preferred?.typeId || preferred?.id || fallback[key] || null;
  } catch {
    return fallback[key] || null;
  }
}

// Correct v4 association: PUT + { types: [ { associationCategory, associationTypeId } ] }
async function associateOnceV4(fromType, fromId, toType, toId) {
  const typeId = await getAssociationTypeId(fromType, toType);
  if (!typeId) {
    console.warn(`[warn] No association typeId for ${fromType} -> ${toType}`);
    return false;
  }

  const url = `${HS.base}/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`;
  const body = {
    types: [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: Number(typeId),
      },
    ],
  };

  try {
    await hsFetch(url, { method: "PUT", body: JSON.stringify(body) });
    console.log(`[assoc] Linked ${fromType}:${fromId} -> ${toType}:${toId}`);
    return true;
  } catch (e) {
    console.warn(
      `[HubSpot] v4 associate ${fromType}:${fromId} -> ${toType}:${toId} failed:`,
      e.message
    );
    return false;
  }
}

// ---------- CALL UPDATE ----------
export async function updateCall(callId, analysis) {
  // ------- robust defaults on the CALL side (so we don't rely on analyse.js for these) -------
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

  // product interest -> SSAS | FIC | Both
  let productInterest = "";
  const pd = analysis?.key_details?.products_discussed || [];
  if (pd.length === 2) productInterest = "Both";
  else if (pd.length === 1) productInterest = pd[0] || "";
  if (!productInterest) productInterest = "Not mentioned";

  const likeToClose =
    typeof analysis?.likelihood_to_close === "number"
      ? Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10)))
      : 1;

  // objection category limited set (portal list: Price, Timing, Risk, Complexity, Authority, Clarity)
  const allowedCategories = new Set(["Price","Timing","Risk","Complexity","Authority","Clarity"]);
  let aiCat = "Clarity";
  if (objections.some(o => /price|fee|cost/i.test(o))) aiCat = "Price";
  else if (objections.some(o => /time|timeline|delay/i.test(o))) aiCat = "Timing";
  else if (objections.some(o => /risk/i.test(o))) aiCat = "Risk";
  else if (objections.some(o => /complex/i.test(o))) aiCat = "Complexity";
  else if (objections.some(o => /authority|sign off|decision/i.test(o))) aiCat = "Authority";
  if (!allowedCategories.has(aiCat)) aiCat = "Clarity";

  // Coaching / guidance on the CALL
  const increaseLikely = Array.isArray(analysis?.increase_likelihood)
    ? analysis.increase_likelihood.join("; ")
    : (analysis?.increase_likelihood || "No suggestions.");
  const perfSummary = analysis?.sales_performance_summary || "No specific coaching available.";
  const perfScore =
    typeof analysis?.sales_performance_rating === "number"
      ? String(analysis.sales_performance_rating)
      : "";

  const scoreReason = analysis?.score_reasoning || "No reasoning provided.";

  // Missing info & materials (now guaranteed)
  const missingInfo =
    typeof analysis?.ai_missing_information === "string" &&
    analysis.ai_missing_information.trim().length
      ? analysis.ai_missing_information
      : "Nothing requested or all information provided.";

  const requestedMaterials =
    materials.length > 0 ? materials.join("; ") : "Nothing requested";

  // Build request body for the CALL update
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

    // Guidance
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

  // Log a projection to verify
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

// ---------- SCORECARD CREATE ----------
export async function createScorecard(analysis, ctx) {
  const { callId, contactIds = [], dealIds = [], ownerId } = ctx || {};
  const objectType = "p49487487_sales_scorecards";

  const ce = analysis?.consult_eval || {};
  const fv = (v) => (v === 1 ? 1 : 0);

  // Likelihood-to-close (1..10) mirrored on Scorecard too
  const tenScale =
    typeof analysis?.likelihood_to_close === "number"
      ? Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10)))
      : 1;

  const props = {
    activity_type: "Initial Consultation",
    activity_name: `${callId} — Initial Consultation — ${new Date().toISOString().slice(0, 10)}`,
    hubspot_owner_id: ownerId || undefined,

    // Coaching
    sales_performance_rating_: Number(analysis?.sales_performance_rating || 1),
    sales_scorecard___what_you_can_improve_on:
      analysis?.sales_performance_summary ||
      "What went well:\n- \n\nAreas to improve:\n- ",

    // Mirrors for reviewer convenience
    ai_next_steps: (analysis?.next_actions || []).join("; "),
    ai_consultation_required_materials:
      (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length
        ? analysis.materials_to_send.join("; ")
        : "Nothing requested"),
    ai_decision_criteria: (analysis?.ai_decision_criteria || []).join("; "),
    ai_key_objections: (analysis?.objections || []).join("; ") || "No objections",
    ai_consultation_outcome: analysis?.outcome || "Unclear",
    ai_consultation_likelihood_to_close: String(tenScale),

    // Consult metrics (0/1 projection)
    consult_closing_question_asked: fv(ce.commitment_requested),
    consult_collected_dob_nin_when_agreed: fv(ce.specific_tax_estimate_given), // proxy; adjust if you prefer
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

  // Weighted score calculation (weights sum to 10)
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

  // Create the Scorecard
  const createUrl = `${HS.base}/crm/v3/objects/${objectType}`;
  let createdId = null;
  try {
    const created = await hsFetch(createUrl, {
      method: "POST",
      body: JSON.stringify({ properties: props }),
    });
    createdId = created?.id;
    console.log("[scorecard] created id:", createdId);
  } catch (e) {
    console.warn("[HubSpot] create scorecard failed:", e.message);
    return null;
  }

  if (!createdId) return null;

  // Always associate to the Call
  const assocResults = [];
  assocResults.push(await associateOnceV4(objectType, createdId, "calls", String(callId)));

  // Optionally associate to Contacts and Deals (skip if none)
  for (const cid of (contactIds || [])) {
    assocResults.push(await associateOnceV4(objectType, createdId, "contacts", String(cid)));
  }
  for (const did of (dealIds || [])) {
    assocResults.push(await associateOnceV4(objectType, createdId, "deals", String(did)));
  }

  if (!assocResults[0]) {
    console.warn("[warn] scorecard was created but not linked to the Call (will still exist).");
  }
  return createdId;
}
