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

/* =================== Update Call =================== */
/** Only writes the Initial Consultation fields you specified. */
export async function updateCall(callId, analysis) {
  const props = {};

  // Resolve type
  const resolvedType = resolveCallType(analysis?.call_type) || "Initial Consultation";
  if (resolvedType) {
    props.ai_inferred_call_type = resolvedType;               // text/dropdown (your portal)
    props.hs_activity_type = resolvedType;                    // built-in type for consistency
  }
  // Confidence: use explicit if present else 85 when inferred
  const conf = numberOrNull(analysis?.ai_call_type_confidence ?? analysis?.call_type_confidence);
  props.ai_call_type_confidence = conf != null ? clamp(conf, 0, 100) : 85;

  // Consultation outcome (Likely/Monitor/Not proceeding)
  props.ai_consultation_outcome = mapConsultationOutcome(analysis?.outcome || "Monitor");

  // Product interest (FIC/SSAS/Both) from products_discussed
  const productInterest = mapProductInterest(analysis?.key_details?.products_discussed);
  if (productInterest) props.ai_product_interest = productInterest;

  // Decision criteria (from analysis or inferred from summary)
  props.ai_decision_criteria = toShortList(
    analysis?.ai_decision_criteria,
    inferDecisionCriteriaFromSummary(analysis?.summary || []),
    "Not mentioned."
  );

  // Data points captured (DOB, NI, address, etc.) — write whatever we detected; else explicit fallback
  props.ai_data_points_captured = buildDataPointsCaptured(analysis?.key_details) || "No personal data captured.";

  // Missing info (requested but not available)
  props.ai_missing_information = toMultiline(analysis?.ai_missing_information) || "None requested or all provided.";

  // Next steps (plain string, not array)
  props.ai_next_steps = toShortList(analysis?.next_actions, [], "No next steps captured.");

  // Objections
  const objections = ensureArray(analysis?.objections);
  if (objections.length) {
    props.ai_key_objections = objections.join("; ").slice(0, 1000);
    props.ai_objections_bullets = objections.join(" • ").slice(0, 5000);
    props.ai_primary_objection = objections[0].slice(0, 300);
    props.ai_objection_categories = mapObjectionCategories(objections).join("; ") || "None.";
    props.ai_objection_severity = normaliseSeverity(analysis?.ai_objection_severity || "Medium");
  } else {
    props.ai_key_objections = "No objections";
    props.ai_objections_bullets = "No objections";
    props.ai_primary_objection = "No objections";
    props.ai_objection_categories = "None.";
    props.ai_objection_severity = "Low";
  }

  // Materials (what the prospect asked TLPI to send)
  props.ai_consultation_required_materials = toShortList(analysis?.materials_to_send, [], "No materials requested.");

  // Likeliness to proceed (1–10) + reasoning & “increase likelihood” suggestions
  const likeScore10 = toOneToTenFromPct(analysis?.likelihood_to_close);
  props["chat_gpt___likeliness_to_proceed_score"] = likeScore10 ?? 5; // default mid if absent
  props["chat_gpt___score_reasoning"] = buildScoreReasoning(analysis, likeScore10);
  props["chat_gpt___increase_likelihood_of_sale_suggestions"] = buildIncreaseLikelihood(analysis);

  // Summary (HubSpot native summary renderer)
  props.hs_call_summary = arrayToBullets(analysis?.summary, "• ") || "No summary generated.";

  // Sentiment → client engagement NUMBER (High=3, Neutral=2, Low=1)
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome);
  props.ai_client_engagement_level = engagementNumberFromSentiment(sentiment);

  // Filter unknown props for calls and PATCH
  const safeProps = await filterPropsFor("calls", props);
  const patchResp = await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: safeProps });

  // (Optional) echo
  try {
    const echo = await getHubSpotObject("calls", callId, [
      "ai_inferred_call_type","ai_call_type_confidence","hs_activity_type",
      "chat_gpt___likeliness_to_proceed_score","ai_consultation_outcome"
    ]);
    console.log("[debug] Call updated:", echo?.properties);
  } catch (e) {
    console.warn("[debug] Could not re-read call:", e.message);
  }

  return patchResp;
}

/* ============ Create Scorecard & associate ============ */
/**
 * Creates Sales Scorecard with:
 * - Owner copied from call
 * - 9 x Qual_* fields (0/1)
 * - consult_score_final (1–10)
 * - sales_performance_rating (1–10) + summary
 * - Mirrors from the call (likelihood 1–10, outcome, materials, decision criteria, key objections, next steps)
 */
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  // Ensure we know which fields exist on this custom object
  await getKnownPropsSet(SCORECARD_OBJECT);
  const has = (n) => KNOWN_PROPS.get(SCORECARD_OBJECT)?.has(n);

  const callType = resolveCallType(analysis?.call_type) || "Initial Consultation";
  const activityName = `${callId} — ${callType} — ${new Date().toISOString().slice(0, 10)}`;

  // Build the 9 Qual_* booleans (0/1)
  const Q = buildQualFromAnalysis(analysis);

  // Consultation Score (1–10) from nine 0/1 items; min 1
  const consultScore10 = Math.max(1, Math.round((sum(Object.values(Q)) / 9) * 10));

  // Prompt-driven overall rating (1–10)
  const perf10 = clamp(Math.round(numberOrNull(analysis?.sales_performance_rating) ?? 0), 1, 10);

  const props = {
    activity_type: callType,
    activity_name: activityName,
    hubspot_owner_id: ownerId || undefined,

    // 9 x Qual_* (only set those that exist)
    ...(has("qual_benefits_linked_to_needs")           ? { qual_benefits_linked_to_needs: Q.benefits_linked_to_needs } : {}),
    ...(has("qual_clear_responses_or_followup")        ? { qual_clear_responses_or_followup: Q.clear_responses_or_followup } : {}),
    ...(has("qual_commitment_requested")               ? { qual_commitment_requested: Q.commitment_requested } : {}),
    ...(has("qual_intro")                               ? { qual_intro: Q.intro } : {}),
    ...(has("qual_next_steps_confirmed")               ? { qual_next_steps_confirmed: Q.next_steps_confirmed } : {}),
    ...(has("qual_open_question")                      ? { qual_open_question: Q.open_question } : {}),
    ...(has("qual_rapport")                            ? { qual_rapport: Q.rapport } : {}),
    ...(has("qual_relevant_pain_identified")           ? { qual_relevant_pain_identified: Q.relevant_pain_identified } : {}),
    ...(has("qual_services_explained_clearly")         ? { qual_services_explained_clearly: Q.services_explained_clearly } : {}),

    // Consultation Score (1–10)
    ...(has("consult_score_final") ? { consult_score_final: consultScore10 } : {}),

    // Overall performance (prompt) + coaching bullets
    ...(has("sales_performance_rating") ? { sales_performance_rating: String(perf10) } : {}),
    ...(has("sales_scorecard___what_you_can_improve_on")
        ? { sales_scorecard___what_you_can_improve_on: buildCoachingSummary(analysis) }
        : {}),

    // Mirrors from Call
    ...(has("ai_consultation_likelihood_to_close") ? { ai_consultation_likelihood_to_close: toOneToTenFromPct(analysis?.likelihood_to_close) ?? 5 } : {}),
    ...(has("ai_consultation_outcome") ? { ai_consultation_outcome: mapConsultationOutcome(analysis?.outcome || "Monitor") } : {}),
    ...(has("ai_consultation_required_materials") ? { ai_consultation_required_materials: toShortList(analysis?.materials_to_send, [], "No materials requested.") } : {}),
    ...(has("ai_decision_criteria") ? { ai_decision_criteria: toShortList(analysis?.ai_decision_criteria, inferDecisionCriteriaFromSummary(analysis?.summary || []), "Not mentioned.") } : {}),
    ...(has("ai_key_objections") ? { ai_key_objections: ensureArray(analysis?.objections).length ? ensureArray(analysis?.objections).join("; ").slice(0, 1000) : "No objections" } : {}),
    ...(has("ai_next_steps") ? { ai_next_steps: toShortList(analysis?.next_actions, [], "No next steps captured.") } : {}),
  };

  // Filter unknown props, create Scorecard
  const safeProps = await filterPropsFor(SCORECARD_OBJECT, props);
  const created = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, { properties: safeProps });
  const scoreId = created?.id;
  if (!scoreId) {
    console.warn("[HubSpot] Scorecard creation returned no id");
    return { type: SCORECARD_OBJECT, id: null };
  }

  // Associate: scorecard -> call/contact/deal (v4 with labels)
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

/* ================== Helpers ================== */
function ensureArray(v){ if(Array.isArray(v)) return v.filter(Boolean).map(String); if(v==null) return []; return [String(v)].filter(Boolean); }
function arrayToBullets(arr, bullet="• "){ const a=ensureArray(arr); return a.length ? a.map(s=>`${bullet}${s}`).join("\n") : ""; }
function toMultiline(v){ if(Array.isArray(v)) return v.join("\n"); if(v==null) return undefined; return String(v); }
function toShortList(primary, inferred=[], fallback=""){ const a=ensureArray(primary); if(a.length) return a.join("; ").slice(0, 1000); const b=ensureArray(inferred); return (b.length ? b.join("; ") : fallback).slice(0, 1000); }
function numberOrNull(v){ if(v==null) return null; const n=Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function sum(arr){ return arr.reduce((a,b)=>a+(Number(b)||0),0); }

function resolveCallType(v){
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes("follow") && s.includes("up")) return "Follow up call";
  if (s.includes("consult")) return "Initial Consultation";
  if (s.includes("qualif")) return "Qualification call";
  if (s.includes("applic")) return "Application meeting";
  if (s.includes("strategy")) return "Strategy call";
  if (s.includes("review")) return "Annual Review";
  if (s.includes("existing")) return "Existing customer call";
  if (s.includes("other")) return "Other";
  return "Initial Consultation";
}

function normaliseSentiment(v){ if(!v) return "Neutral"; const s=String(v).toLowerCase();
  if (s.includes("pos")) return "Positive";
  if (s.includes("neg")) return "Negative";
  return "Neutral";
}
function engagementNumberFromSentiment(sent){ return sent==="Positive" ? 3 : sent==="Negative" ? 1 : 2; }

function mapConsultationOutcome(outcome){ const s=String(outcome||"").toLowerCase();
  if (s.includes("positive") || s.includes("proceed") || s.includes("win")) return "Likely";
  if (s.includes("negative") || s.includes("no")) return "Not proceeding";
  return "Monitor";
}

function mapProductInterest(products){
  const arr=ensureArray(products).map(p=>p.toLowerCase());
  const hasSSAS=arr.some(p=>p.includes("ssas")), hasFIC=arr.some(p=>p.includes("fic"));
  if (hasSSAS && hasFIC) return "Both"; if (hasSSAS) return "SSAS"; if (hasFIC) return "FIC"; return undefined;
}

function mapObjectionCategories(objs){
  const cats=new Set();
  const text=ensureArray(objs).join(" ").toLowerCase();
  if (/fee|cost|price/.test(text)) cats.add("Fees");
  if (/time|timeline|delay|month|week/.test(text)) cats.add("Timeline");
  if (/risk|volatile|uncertain/.test(text)) cats.add("Risk");
  if (/hmrc|compliance|tax|rules?/.test(text)) cats.add("Compliance/Tax");
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

function toOneToTenFromPct(pct){
  const n = numberOrNull(pct);
  if (n==null) return null;
  return clamp(Math.max(1, Math.round(n/10)), 1, 10);
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
  // 3 short bullets; use next actions/materials as hints
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
  // Compact fallback
  const ww = ensureArray(analysis?.summary).slice(0,2).map(x=>`- ${x}`).join("\n") || "- Rapport established.";
  const imp = ["- Ask for a specific commitment.","- Confirm next step & date."].join("\n");
  return `What went well:\n${ww}\n\nAreas to improve:\n${imp}`;
}

function buildQualFromAnalysis(analysis){
  // Prefer consult_eval 0/0.5/1; coerce to 0/1. If missing, infer lightly.
  const e = analysis?.consult_eval || {};
  const as01 = (v)=> (Number(v) >= 0.75 ? 1 : Number(v) > 0 ? 1 : 0);
  const inferHas = (arr)=> ensureArray(arr).length ? 1 : 0;

  const qual = {
    benefits_linked_to_needs: as01(e.benefits_linked_to_needs ?? 0),
    clear_responses_or_followup: as01(e.clear_responses_or_followup ?? 0),
    commitment_requested: as01(e.commitment_requested ?? 0),
    intro: as01(e.intro ?? 1), // often true
    next_steps_confirmed: as01(e.next_steps_confirmed ?? inferHas(analysis?.next_actions)),
    open_question: as01(e.open_question ?? 0.5),
    rapport: as01(e.rapport_open ?? 1),
    relevant_pain_identified: as01(e.needs_pain_uncovered ?? 1),
    services_explained_clearly: as01(e.services_explained_clearly ?? 1),
  };
  return qual;
}
