// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const HUBSPOT_BASE = "https://api.hubapi.com";

const HS =
  process.env.HUBSPOT_ACCESS_TOKEN ||
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN;

const HS_SRC = process.env.HUBSPOT_ACCESS_TOKEN
  ? "HUBSPOT_ACCESS_TOKEN"
  : process.env.HUBSPOT_PRIVATE_APP_TOKEN
  ? "HUBSPOT_PRIVATE_APP_TOKEN"
  : process.env.HUBSPOT_TOKEN
  ? "HUBSPOT_TOKEN"
  : "NONE";

console.log(`[hs] token source: ${HS_SRC}`);

function assertToken() {
  if (!HS) {
    throw new Error(
      "HubSpot token missing: set HUBSPOT_ACCESS_TOKEN or HUBSPOT_PRIVATE_APP_TOKEN (or HUBSPOT_TOKEN) in Render."
    );
  }
}
function hsHeaders() {
  assertToken();
  return { Authorization: `Bearer ${HS}`, "Content-Type": "application/json" };
}
async function hsGet(url) {
  const r = await fetch(url, { headers: hsHeaders() });
  if (!r.ok) throw new Error(`HubSpot GET ${url} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function hsPatch(url, body) {
  const r = await fetch(url, { method: "PATCH", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HubSpot PATCH ${url} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function hsPost(url, body) {
  const r = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HubSpot POST ${url} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function toHubspotEnum(value, allowed) {
  if (value == null) return null;
  const v = String(value).trim();
  return allowed.includes(v) ? v : null;
}
function nonEmptyText(v, fallback = null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : fallback;
}
function joinList(val, sep = "; ") {
  if (!val) return null;
  if (Array.isArray(val)) {
    const cleaned = val.map(x => (x ?? "").toString().trim()).filter(Boolean);
    return cleaned.length ? cleaned.join(sep) : null;
    }
  const s = (val ?? "").toString().trim();
  return s || null;
}

export async function getHubSpotObject(objectType, id, properties = []) {
  const propQuery = properties.length ? `?properties=${properties.join(",")}` : "";
  const url = `${HUBSPOT_BASE}/crm/v3/objects/${objectType}/${id}${propQuery}`;
  try { return await hsGet(url); }
  catch (e) { throw new Error(`HubSpot get ${objectType}/${id} failed: ${e.message}`); }
}

export async function getAssociations(id, toType) {
  const url = `${HUBSPOT_BASE}/crm/v4/objects/calls/${id}/associations/${toType}`;
  try {
    const js = await hsGet(url);
    return (js?.results || []).map(x => x.toObjectId).filter(Boolean);
  } catch (e) {
    console.warn(`[HubSpot] assoc calls:${id} -> ${toType} failed: ${e.message}`);
    return [];
  }
}

/** Update CALL (Initial Consultation) */
export async function updateCall(callId, analysis) {
  const outcomeAllowed = ["Proceed now", "Likely", "Unclear", "Not now", "No fit"];
  const severities = ["Low", "Medium", "High"];

  const score1to10 = (n) =>
    typeof n === "number" ? String(Math.max(1, Math.min(10, Math.round(n)))) : null;

  // Build map
  const props = {
    ai_inferred_call_type: "Initial Consultation",
    ai_call_type_confidence:
      typeof analysis?.likelihood_to_close === "number"
        ? String(Math.max(1, Math.min(100, Math.round(analysis.likelihood_to_close))))
        : "90",

    ai_consultation_outcome:
      toHubspotEnum(analysis?.outcome, outcomeAllowed) || "Unclear",
    ai_product_interest:
      Array.isArray(analysis?.key_details?.products_discussed) &&
      analysis.key_details.products_discussed.length
        ? String(analysis.key_details.products_discussed[0])
        : null,

    ai_decision_criteria: joinList(analysis?.ai_decision_criteria),

    ai_key_objections: joinList(analysis?.objections),
    ai_objection_categories:
      joinList(analysis?.objection_categories) ||
      (Array.isArray(analysis?.objections) && analysis.objections.length
        ? "Clarity"
        : "Clarity"),
    ai_objection_severity:
      toHubspotEnum(analysis?.objection_severity, severities) ||
      (Array.isArray(analysis?.objections) && analysis.objections.length
        ? "Medium"
        : "Low"),
    ai_objections_bullets:
      Array.isArray(analysis?.objections) && analysis.objections.length
        ? analysis.objections.join(" • ")
        : "No objections",
    ai_primary_objection:
      nonEmptyText(
        analysis?.primary_objection,
        Array.isArray(analysis?.objections) && analysis.objections.length
          ? analysis.objections[0]
          : "No objection"
      ),

    ai_data_points_captured: nonEmptyText(
      analysis?.__data_points_captured_text,
      "Not mentioned."
    ),
    ai_missing_information: nonEmptyText(
      analysis?.ai_missing_information,
      "None requested or all provided."
    ),
    ai_next_steps: joinList(analysis?.next_actions),
    ai_consultation_required_materials: joinList(analysis?.materials_to_send),

    // IMPORTANT: correct spelling per your portal
    chat_gpt___likeliness_to_proceed_score:
      score1to10((analysis?.likelihood_to_close ?? 0) / 10),

    chat_gpt___score_reasoning: nonEmptyText(analysis?.score_reasoning, ""),
    chat_gpt___increase_likelihood_of_sale_suggestions: nonEmptyText(
      analysis?.increase_likelihood,
      ""
    ),
  };

  const clean = Object.fromEntries(
    Object.entries(props).filter(
      ([, v]) => v !== null && v !== undefined && v !== ""
    )
  );

  try {
    const url = `${HUBSPOT_BASE}/crm/v3/objects/calls/${callId}`;
    await hsPatch(url, { properties: clean });
  } catch (e) {
    console.warn(`[HubSpot] PATCH https://api.hubapi.com/crm/v3/objects/calls/${callId} failed: ${e.message}`);
  }

  // Debug sanity read
  try {
    const debug = await getHubSpotObject("calls", callId, [
      "ai_inferred_call_type",
      "ai_call_type_confidence",
      "ai_consultation_outcome",
      "ai_product_interest",
      "ai_decision_criteria",
      "ai_data_points_captured",
      "ai_missing_information",
      "ai_next_steps",
      "ai_key_objections",
      "ai_objection_categories",
      "ai_objection_severity",
      "ai_objections_bullets",
      "ai_primary_objection",
      "ai_consultation_required_materials",
      "chat_gpt___likeliness_to_proceed_score",
    ]);
    console.log("[debug] Call updated:", debug?.properties || {});
  } catch {}
}

/** Create scorecard + associate via v3 batch create */
export async function createScorecard(analysis, assoc) {
  const objectType = "p49487487_sales_scorecards";
  const props = {};

  // Identity
  props.activity_type = "Initial Consultation";
  props.activity_name = `${assoc.callId} — Initial Consultation — ${new Date().toISOString().slice(0, 10)}`;

  // Sales performance
  if (typeof analysis?.sales_performance_rating === "number") {
    props.sales_performance_rating_ = analysis.sales_performance_rating; // number
    props.sales_performance_rating = String(analysis.sales_performance_rating); // text
  }
  if (analysis?.sales_performance_summary) {
    props.sales_scorecard___what_you_can_improve_on = analysis.sales_performance_summary;
  }

  // consult_eval mapping -> 0/1 flags (booleans in number fields)
  const ce = analysis?.consult_eval || {};
  const to01 = (v) => (v === 1 || v === 0.5 ? 1 : v === 0 ? 0 : Number(v) > 0 ? 1 : 0);

  props.consult_customer_agreed_to_set_up =
    to01(ce.commitment_requested || ce.next_steps_confirmed) || 0;
  props.consult_overcame_objection_and_closed = to01(ce.clear_responses_or_followup) || 0;
  props.consult_next_step_specific_date_time = to01(ce.next_step_specific_date_time) || 0;
  props.consult_closing_question_asked = to01(ce.commitment_requested) || 0;
  props.consult_prospect_asked_next_steps = to01(ce.next_steps_confirmed) || 0;
  props.consult_strong_buying_signals_detected = to01(ce.interactive_throughout) || 0;
  props.consult_needs_pain_uncovered = to01(ce.needs_pain_uncovered) || 0;
  props.consult_purpose_clearly_stated = to01(ce.intro) || 0;
  props.consult_quantified_value_roi = to01(ce.quantified_value_roi) || 0;
  props.consult_demo_tax_saving = to01(ce.specific_tax_estimate_given) || 0;
  props.consult_fees_tax_deductible_explained = to01(ce.fees_tax_deductible_explained) || 0;
  props.consult_fees_annualised = to01(ce.services_explained_clearly) || 0;
  props.consult_fee_phrasing_three_seven_five = to01(ce.benefits_linked_to_needs) || 0;
  props.consult_specific_tax_estimate_given = to01(ce.specific_tax_estimate_given) || 0;
  props.consult_confirm_reason_for_zoom = to01(ce.intro) || 0;
  props.consult_rapport_open = to01(ce.rapport_open) || 0;
  props.consult_interactive_throughout = to01(ce.interactive_throughout) || 0;
  props.consult_next_contact_within_5_days = to01(ce.next_steps_confirmed) || 0;
  props.consult_no_assumptions_evidence_gathered = to01(ce.active_listening) || 0;
  props.consult_collected_dob_nin_when_agreed = to01(ce.open_question) || 0;

  // Weighted total to 10
  const weights = {
    consult_customer_agreed_to_set_up: 2.0,
    consult_overcame_objection_and_closed: 1.0,
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
  const flagsDebug = [];
  for (const [k, w] of Object.entries(weights)) {
    const v = Number(props[k]) || 0;
    const p = v * w;
    flagsDebug.push({ k, w, v, p });
    weighted += p;
  }
  props.consult_score_final = Math.round(weighted * 10) / 10;
  console.log("[scorecard] consult flags:", flagsDebug);
  console.log("[scorecard] weighted raw:", weighted);

  // Copy-through
  const to1to10 = (n) =>
    typeof n === "number" ? String(Math.max(1, Math.min(10, Math.round(n)))) : null;

  props.ai_consultation_likelihood_to_close = to1to10((analysis?.likelihood_to_close ?? 0) / 10);
  props.ai_consultation_outcome = analysis?.outcome || "Unclear";
  props.ai_consultation_required_materials = joinList(analysis?.materials_to_send);
  props.ai_decision_criteria = joinList(analysis?.ai_decision_criteria);
  props.ai_key_objections = joinList(analysis?.objections);
  props.ai_next_steps = joinList(analysis?.next_actions);

  // Copy owner
  if (assoc?.ownerId) props.hubspot_owner_id = String(assoc.ownerId);

  // Create Scorecard
  let createdId = null;
  try {
    const url = `${HUBSPOT_BASE}/crm/v3/objects/${objectType}`;
    const js = await hsPost(url, { properties: props });
    createdId = js?.id;
  } catch (e) {
    console.warn(`[HubSpot] POST https://api.hubapi.com/crm/v3/objects/${objectType} failed: ${e.message}`);
  }
  if (!createdId) {
    console.warn("[HubSpot] Scorecard creation returned no id");
    return null;
  }

  // --- v3 batch associations (robust) ---
  async function assocBatch(fromType, toType, pairs, associationType) {
    if (!pairs.length) return;
    const url = `${HUBSPOT_BASE}/crm/v3/associations/${fromType}/${toType}/batch/create`;
    const body = {
      inputs: pairs.map(([fromId, toId]) => ({
        from: { id: String(fromId) },
        to: { id: String(toId) },
        type: associationType, // e.g., "p49487487_sales_scorecards_to_calls" if defined, else fallback generic
      })),
    };
    // If you don’t have a custom type string, HubSpot accepts the default `"scorecards_to_{obj}"` only if defined.
    // If type name is unknown, omit to test default behavior or replace with a known association label.
    // For safety here we try a generic type name; if it fails, we fall back to no type.
    try {
      await hsPost(url, body);
    } catch (e) {
      console.warn(`[HubSpot] v3 batch assoc ${fromType} -> ${toType} failed (with type): ${e.message}`);
      // retry without explicit type (HubSpot will use default if only one)
      try {
        await hsPost(url, {
          inputs: pairs.map(([fromId, toId]) => ({ from: { id: String(fromId) }, to: { id: String(toId) } })),
        });
      } catch (e2) {
        console.warn(`[HubSpot] v3 batch assoc ${fromType} -> ${toType} failed (no type): ${e2.message}`);
      }
    }
  }

  try {
    await assocBatch(objectType, "calls", [[createdId, assoc.callId]], "p49487487_sales_scorecards_to_calls");
    if (Array.isArray(assoc.contactIds) && assoc.contactIds.length) {
      await assocBatch(objectType, "contacts", assoc.contactIds.map((cid) => [createdId, cid]), "p49487487_sales_scorecards_to_contacts");
    }
    if (Array.isArray(assoc.dealIds) && assoc.dealIds.length) {
      await assocBatch(objectType, "deals", assoc.dealIds.map((did) => [createdId, did]), "p49487487_sales_scorecards_to_deals");
    }
  } catch (e) {
    console.warn("[HubSpot] associations failed:", e.message);
  }

  return createdId;
}
