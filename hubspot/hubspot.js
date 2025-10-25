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
    // fallback: empty set (no filtering)
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

/* =================== Update Call =================== */
export async function updateCall(callId, analysis) {
  const props = {};

  // Summary (HubSpot renders this)
  const summaryStr = arrayToBullets(analysis?.summary, "• ") || "No summary generated.";
  props.hs_call_summary = summaryStr.slice(0, 5000);

  // Inferred call type + confidence
  const inferredType = normaliseCallType(analysis?.call_type);
  if (inferredType) props.ai_inferred_call_type = inferredType;

  const explicitConf = toNumberOrNull(analysis?.ai_call_type_confidence ?? analysis?.call_type_confidence);
  const conf = explicitConf != null ? clamp(explicitConf, 0, 100) : (inferredType ? 85 : null);
  if (conf != null) props.ai_call_type_confidence = conf;
  if (inferredType && conf >= 75) props.hs_activity_type = inferredType;

  // Objections & related
  const objections = ensureArray(analysis?.objections);
  if (objections.length) {
    props.ai_objections_bullets = objections.join(" • ").slice(0, 5000);
    props.ai_primary_objection = objections[0].slice(0, 500);
    props.ai_key_objections = objections.join("; ").slice(0, 1000);
    props.ai_objection_categories = mapObjectionCategories(objections).join("; ") || "Not mentioned.";
    props.ai_objection_severity = analysis?.ai_objection_severity
      ? normaliseSeverity(analysis.ai_objection_severity)
      : "Medium";
  } else {
    props.ai_objections_bullets = "No objections mentioned.";
    props.ai_primary_objection = "None.";
    props.ai_key_objections = "None.";
    props.ai_objection_categories = "None.";
  }

  // Product interest (dropdown only if clear)
  const productInterest = mapProductInterest(analysis?.key_details?.products_discussed);
  if (productInterest) props.ai_product_interest = productInterest;

  // Data points captured
  const kd = analysis?.key_details || {};
  const dp = [];
  if (kd.client_name) dp.push(`Client: ${kd.client_name}`);
  if (kd.company_name) dp.push(`Company: ${kd.company_name}`);
  if (Array.isArray(kd.products_discussed) && kd.products_discussed.length) dp.push(`Products: ${kd.products_discussed.join(", ")}`);
  if (kd.timeline) dp.push(`Timeline: ${kd.timeline}`);
  props.ai_data_points_captured = (dp.length ? dp.join("\n") : "Not mentioned.");

  // Missing info & decision criteria
  props.ai_missing_information = toMultiline(analysis?.ai_missing_information) || "Not mentioned.";
  let decisionCriteria = toMultiline(analysis?.ai_decision_criteria);
  if (!decisionCriteria) {
    const crit = inferDecisionCriteriaFromSummary(analysis?.summary || []);
    decisionCriteria = crit.length ? crit.join("; ") : "Not mentioned.";
  }
  props.ai_decision_criteria = decisionCriteria.slice(0, 1000);

  // Recommendations / materials
  props.ai_recommendations_provided =
    (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length)
      ? analysis.materials_to_send.join("; ").slice(0, 5000)
      : "None promised.";

  // Sentiment etc.
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome) || "Neutral";
  props.ai_customer_sentiment = sentiment;
  props.ai_client_engagement_level = sentimentToEngagement(sentiment);
  props.ai_complaint_detected = normaliseYesNoUnclear(analysis?.ai_complaint_detected || "No");
  props.ai_escalation_required = normaliseEscalation(analysis?.ai_escalation_required || "No");
  props.ai_escalation_notes = toMultiline(analysis?.ai_escalation_notes) || "No escalation required.";

  // Type-specific (IC / FU)
  if (inferredType === "Initial Consultation") {
    if (typeof analysis?.likelihood_to_close === "number") {
      props.ai_consultation_likelihood_to_close = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
    }
    props.ai_consultation_outcome = mapConsultationOutcome(analysis?.outcome || "Monitor");
    props.ai_consultation_required_materials =
      (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length)
        ? analysis.materials_to_send.join("; ").slice(0, 5000)
        : "No materials required.";
    props.ai_next_steps =
      (Array.isArray(analysis?.next_actions) && analysis.next_actions.length)
        ? analysis.next_actions.join("; ").slice(0, 5000)
        : "No next steps captured.";
  }
  if (inferredType === "Follow up call") {
    if (typeof analysis?.likelihood_to_close === "number") {
      props.ai_follow_up_close_likelihood = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
    }
    props.ai_follow_up_required_materials =
      (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length)
        ? analysis.materials_to_send.join("; ").slice(0, 5000)
        : "No materials required.";
    props.ai_follow_up_objections_remaining = objections.length
      ? objections.join("; ").slice(0, 1000)
      : "No objections remaining.";
    props.ai_next_steps =
      (Array.isArray(analysis?.next_actions) && analysis.next_actions.length)
        ? analysis.next_actions.join("; ").slice(0, 5000)
        : "No next steps captured.";
  }

  // Filter unknown props for calls, then PATCH
  const safeProps = await filterPropsFor("calls", props);
  const patchResp = await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: safeProps });

  // DEBUG echo
  try {
    const echo = await getHubSpotObject("calls", callId, ["ai_inferred_call_type","ai_call_type_confidence","hs_activity_type","hs_call_summary"]);
    console.log("[debug] Call after update:", {
      hs_call_summary: echo?.properties?.hs_call_summary,
      ai_inferred_call_type: echo?.properties?.ai_inferred_call_type,
      ai_call_type_confidence: echo?.properties?.ai_call_type_confidence,
      hs_activity_type: echo?.properties?.hs_activity_type,
    });
  } catch (e) {
    console.warn("[debug] Could not re-read call:", e.message);
  }

  return patchResp;
}

/* ============ Create Scorecard & associate ============ */
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  if (SCORECARD_OBJECT === "notes") return createNoteScorecard(analysis, { callId, contactIds, dealIds, ownerId });

  const callType = normaliseCallType(analysis?.call_type) || "Initial Consultation";
  const activityName = `${callId} — ${callType} — ${new Date().toISOString().slice(0, 10)}`;

  // ---- consult metrics from analysis.consult_eval
  const consult = analysis?.consult_eval || {};
  // rubric items 0/0.5/1
  const R = {
    intro: consult.intro,
    rapport_open: consult.rapport_open,
    open_question: consult.open_question,
    needs_pain_uncovered: consult.needs_pain_uncovered,
    services_explained_clearly: consult.services_explained_clearly,
    benefits_linked_to_needs: consult.benefits_linked_to_needs,
    active_listening: consult.active_listening,
    clear_responses_or_followup: consult.clear_responses_or_followup,
    commitment_requested: consult.commitment_requested,
    next_steps_confirmed: consult.next_steps_confirmed,
  };
  // operational items 0 or 10 (normalise to 0..1)
  const Oraw = {
    specific_tax_estimate_given: consult.specific_tax_estimate_given, // 0 or 10
    fees_tax_deductible_explained: consult.fees_tax_deductible_explained, // 0 or 10
    next_step_specific_date_time: consult.next_step_specific_date_time, // 0 or 10
    interactive_throughout: consult.interactive_throughout, // 0 or 10
    quantified_value_roi: consult.quantified_value_roi, // 0 or 10
  };

  // Build Scorecard properties object
  const props = {
    activity_type: callType,
    activity_name: activityName,
    hubspot_owner_id: ownerId || undefined,

    // 1–10 (string): prompt-driven overall rating
    sales_performance_rating: String(clamp(Math.round(toNumberOrNull(analysis?.sales_performance_rating) ?? 0), 1, 10)),

    // Coaching summary (fallback if missing)
    sales_scorecard___what_you_can_improve_on:
      (analysis?.sales_performance_summary && String(analysis.sales_performance_summary).slice(0, 9000))
      || buildCoachingNotes(analysis),

    // Mirrors
    ai_next_steps: Array.isArray(analysis?.next_actions) && analysis.next_actions.length
      ? analysis.next_actions.join("; ").slice(0, 5000)
      : "No next steps captured.",
    ai_key_objections: ensureArray(analysis?.objections).length
      ? ensureArray(analysis?.objections).join("; ").slice(0, 1000)
      : "None.",
    ai_consultation_required_materials: Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length
      ? analysis.materials_to_send.join("; ").slice(0, 5000)
      : "No materials required.",
    ai_decision_criteria: (() => {
      const dc = toMultiline(analysis?.ai_decision_criteria);
      if (dc) return dc.slice(0, 1000);
      const crit = inferDecisionCriteriaFromSummary(analysis?.summary || []);
      return (crit.length ? crit.join("; ") : "Not mentioned.").slice(0, 1000);
    })(),
  };

  // Compute 0..100 weighted score for sales_performance_rating_
  const weighted = computeWeightedScore(R, Oraw);
  if (weighted != null) props.sales_performance_rating_ = weighted;

  // ---- Map rubric items to your existing Scorecard fields (pick first that exists)
  const scoreType = SCORECARD_OBJECT; // custom type
  const mapAndSet = async (candidates, value01) => {
    const set = await getKnownPropsSet(scoreType);
    const target = candidates.find(n => set.has(n));
    if (target != null && value01 != null) props[target] = value01;
  };

  // Values already 0/0.5/1 for R; for Op items convert 0|10 -> 0|1 then store back as 0 or 10 (as requested)
  const to01 = v => (Number(v) === 1 || Number(v) === 0.5 || Number(v) === 0) ? Number(v) : null;
  const toZeroTen = v => Number(v) === 10 ? 10 : 0;

  // Rubric (try consult_* first, then reasonable fallbacks)
  await mapAndSet(["consult_intro"], to01(R.intro));
  await mapAndSet(["consult_rapport_open"], to01(R.rapport_open));
  await mapAndSet(["consult_open_question","qual_open_question","consult_no_assumptions_evidence_gathered"], to01(R.open_question));
  await mapAndSet(["consult_needs_pain_uncovered"], to01(R.needs_pain_uncovered));
  await mapAndSet(["consult_services_explained_clearly","consult_purpose_clearly_stated","qual_services_explained_clearly"], to01(R.services_explained_clearly));
  await mapAndSet(["consult_benefits_linked_to_needs","consult_interactive_throughout","qual_benefits_linked_to_needs"], to01(R.benefits_linked_to_needs));
  await mapAndSet(["consult_active_listening","qual_active_listening","consult_interactive_throughout"], to01(R.active_listening));
  await mapAndSet(["consult_clear_responses_or_followup","qual_clear_responses_or_followup"], to01(R.clear_responses_or_followup));
  await mapAndSet(["consult_commitment_requested","qual_commitment_requested","consult_customer_agreed_to_set_up"], to01(R.commitment_requested));
  await mapAndSet(["consult_next_steps_confirmed","qual_next_steps_confirmed","consult_next_contact_within_5_days"], to01(R.next_steps_confirmed));

  // Operational (0 or 10 on record)
  const O10 = {
    consult_specific_tax_estimate_given: toZeroTen(Oraw.specific_tax_estimate_given),
    consult_fees_tax_deductible_explained: toZeroTen(Oraw.fees_tax_deductible_explained),
    consult_next_step_specific_date_time: toZeroTen(Oraw.next_step_specific_date_time),
    consult_interactive_throughout: toZeroTen(Oraw.interactive_throughout),
    consult_quantified_value_roi: toZeroTen(Oraw.quantified_value_roi),
  };
  for (const [prop, val] of Object.entries(O10)) {
    await mapAndSet([prop], Number.isFinite(val) ? (val === 10 ? 1 : 0) : null); // store 0/1 if your fields are 0/1; if your fields are 0/10, change to val directly
    // If your fields are explicitly 0 or 10 (as per your note), do this instead:
    if (KNOWN_PROPS.get(scoreType)?.has(prop)) props[prop] = val; // overrides with 0/10
  }

  // Filter unknown scorecard props, then POST
  const safeProps = await filterPropsFor(SCORECARD_OBJECT, props);
  const created = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, { properties: safeProps });
  const scoreId = created?.id;
  if (!scoreId) {
    console.warn("[HubSpot] Scorecard creation returned no id");
    return { type: SCORECARD_OBJECT, id: null };
  }

  await associateV4UsingLabels(SCORECARD_OBJECT, scoreId, "calls", callId);
  for (const cId of contactIds) await associateV4UsingLabels(SCORECARD_OBJECT, scoreId, "contacts", cId);
  for (const dId of dealIds) await associateV4UsingLabels(SCORECARD_OBJECT, scoreId, "deals", dId);

  return { type: SCORECARD_OBJECT, id: scoreId };
}

/* ============ Legacy Note scorecard (optional) ============ */
async function createNoteScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  const body = [
    "TLPI Sales Scorecard",
    "",
    `Overall (out of 10): ${toScoreOutOf10OrNull(analysis?.scorecard?.overall) ?? "n/a"}`,
    `Objections: ${arrToString(analysis?.objections)}`,
    `Next Actions: ${arrToString(analysis?.next_actions)}`,
    `Materials: ${arrToString(analysis?.materials_to_send)}`,
  ].join("\n");

  const objResponse = await hubspotPost(`crm/v3/objects/notes`, {
    properties: { hs_note_body: body.slice(0, 10000), hs_timestamp: Date.now(), hubspot_owner_id: ownerId || undefined },
  });

  const noteId = objResponse?.id;
  await associateV3("notes", noteId, "calls", callId, "note_to_call");
  for (const cId of contactIds) await associateV3("notes", noteId, "contacts", cId, "note_to_contact");
  for (const dId of dealIds) await associateV3("notes", noteId, "deals", dId, "note_to_deal");
  return { type: "note", id: noteId };
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
async function associateV3(fromType, fromId, toType, toId, type) {
  if (!fromId || !toId) return;
  const url = `${HS_BASE}/crm/v3/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
  const body = { inputs: [{ from: { id: String(fromId) }, to: { id: String(toId) }, type: String(type) }] };
  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`[HubSpot] v3 associate ${fromType}:${fromId} -> ${toType}:${toId} failed: ${res.status} ${txt.slice(0, 300)}`);
    throw new Error("ASSOC_V3_FAIL");
  }
}

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

/* ================== Helpers / NLP ================== */
function ensureArray(v) { if (Array.isArray(v)) return v.filter(Boolean).map(String); if (v == null) return []; return [String(v)].filter(Boolean); }
function arrayToBullets(arr, bullet="• ") { const a = ensureArray(arr); return a.length ? a.map(s => `${bullet}${s}`).join("\n") : ""; }
function toMultiline(v) { if (Array.isArray(v)) return v.join("\n"); if (v == null) return undefined; return String(v); }
function toNumberOrNull(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function toScoreOutOf10OrNull(v) { if (v == null) return null; const n = Number(v); if (!Number.isFinite(n)) return null; return n <= 5 ? clamp(Math.round(n * 2), 0, 10) : clamp(Math.round(n), 0, 10); }

function normaliseCallType(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  const allowed = [
    "qualification call","initial consultation","follow up call",
    "application meeting","strategy call","annual review","existing customer call","other",
  ];
  const found = allowed.find(a => s.includes(a));
  if (found) return title(found);
  if (s.includes("follow") && s.includes("up")) return "Follow up call";
  if (s.includes("consult")) return "Initial Consultation";
  if (s.includes("qualif")) return "Qualification call";
  if (s.includes("applic")) return "Application meeting";
  if (s.includes("strategy")) return "Strategy call";
  if (s.includes("review")) return "Annual Review";
  if (s.includes("existing")) return "Existing customer call";
  return "Other";
}
function title(txt){return txt.replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());}

function normaliseSentiment(v){ if(!v) return undefined; const s=String(v).toLowerCase();
  if (s.includes("pos")) return "Positive";
  if (s.includes("neu")) return "Neutral";
  if (s.includes("neg")) return "Negative";
  if (s.includes("win") || s.includes("close")) return "Positive";
  if (s.includes("lost") || s.includes("no ")) return "Negative";
  return "Neutral";
}
function sentimentToEngagement(sent){ return sent==="Positive"?"High":sent==="Neutral"?"Medium":"Low"; }

function normaliseYesNoUnclear(v){
  const s = String(v || "").toLowerCase();
  if (s.startsWith("y")) return "Yes";
  if (s.startsWith("n")) return "No";
  return "Unclear";
}
function normaliseEscalation(v){
  const s = String(v || "").toLowerCase();
  if (s.startsWith("y")) return "Yes";
  if (s.startsWith("m")) return "Monitor";
  return "No";
}
function normaliseSeverity(v){const s=String(v||"").toLowerCase(); if(s.startsWith("h"))return"High"; if(s.startsWith("m"))return"Medium"; if(s.startsWith("l"))return"Low"; return undefined;}

function mapProductInterest(products){ const arr=ensureArray(products).map(p=>p.toLowerCase());
  const hasSSAS=arr.some(p=>p.includes("ssas")), hasFIC=arr.some(p=>p.includes("fic"));
  if (hasSSAS && hasFIC) return "Both"; if (hasSSAS) return "SSAS"; if (hasFIC) return "FIC"; return undefined;
}
function mapConsultationOutcome(outcome){ const s=String(outcome||"").toLowerCase();
  if (s.includes("positive") || s.includes("win") || s.includes("proceed")) return "Likely";
  if (s.includes("negative") || s.includes("lost") || s.includes("no")) return "Not proceeding";
  return "Monitor";
}
function mapObjectionCategories(objs){ const cats=new Set();
  const text=ensureArray(objs).join(" ").toLowerCase();
  if (/fee|cost|price/.test(text)) cats.add("Fees");
  if (/time|timeline|delay|month|week/.test(text)) cats.add("Timeline");
  if (/risk|volatile|uncertain/.test(text)) cats.add("Risk");
  if (/hmrc|rule|compliance|tax/.test(text)) cats.add("Compliance/Tax");
  if (/provider|trust|reliable|previous/.test(text)) cats.add("Provider/Trust");
  if (/paperwork|process|admin/.test(text)) cats.add("Process");
  return Array.from(cats);
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

function computeWeightedScore(R, O10){
  // weights sum to 100
  const W = {
    intro:4, rapport_open:4, open_question:8,
    needs_pain_uncovered:10, services_explained_clearly:8,
    benefits_linked_to_needs:10, active_listening:8,
    clear_responses_or_followup:8, commitment_requested:12,
    next_steps_confirmed:12,
    specific_tax_estimate_given:4, fees_tax_deductible_explained:4,
    next_step_specific_date_time:4, interactive_throughout:4, quantified_value_roi:4,
  };
  let total = 0;

  // rubric (0/0.5/1)
  for (const [k,w] of Object.entries(W)) {
    if (k in R) {
      const n = Number(R[k]);
      if (n===0 || n===0.5 || n===1) total += n * w;
    }
  }
  // ops (0 or 10 → 0 or 1)
  for (const [k,w] of Object.entries(W)) {
    if (k in O10) {
      const n = Number(O10[k]) === 10 ? 1 : 0;
      total += n * w;
    }
  }
  return Math.max(0, Math.min(100, Math.round(total)));
}

function buildCoachingNotes(analysis) {
  const positives = ensureArray(analysis?.summary).slice(0, 3).map(s => `✓ ${s}`).join("\n") || "No positives captured.";
  const improvements = ensureArray(analysis?.next_actions).slice(0, 3).map(s => `• ${s}`).join("\n") || "No improvement items captured.";
  return [`What went well:\n${positives}`, `\nAreas to improve:\n${improvements}`].join("\n").slice(0, 9000);
}

function arrToString(a){return Array.isArray(a)?a.join("; "):"n/a";}
