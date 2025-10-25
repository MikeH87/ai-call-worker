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
   CALL UPDATE (Initial Consultation — only the fields you listed)
   ========================================================= */
export async function updateCall(callId, analysis) {
  // Always treat this path as Initial Consultation mapping (per your spec)
  const props = {};

  // 1) Ai inferred call type / confidence
  props.ai_inferred_call_type = "Initial Consultation";
  props.ai_call_type_confidence = clamp(
    numberOrNull(analysis?.ai_call_type_confidence ?? analysis?.call_type_confidence) ?? 90,
    0, 100
  );

  // 2) ai consultation outcome (allowed options in your portal)
  props.ai_consultation_outcome = mapConsultationOutcomeHS(analysis?.outcome, analysis?.likelihood_to_close);

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

  // 8) AI key objections (concise) + bullets/category/severity/primary
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

  // 9) ai client engagement level (NUMBER) from sentiment/outcome
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome);
  props.ai_client_engagement_level = engagementNumberFromSentiment(sentiment); // 3/2/1

  // 10) ChatGPT helper fields
  const likeScore10 = toOneToTenFromPct(analysis?.likelihood_to_close) ?? 5;
  props["chat_gpt___increase_likelihood_of_sale_suggestions"] = buildIncreaseLikelihood(analysis);
  props["chat_gpt___likliness_to_proceed_score"] = likeScore10;
  props["chat_gpt___score_reasoning"] = buildScoreReasoning(analysis, likeScore10);

  // Filter & patch
  const safeProps = await filterPropsFor("calls", props);
  const patchResp = await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: safeProps });

  return patchResp;
}

/* ====================================================================
   SCORECARD CREATE (Initial Consultation — only the fields you listed)
   ==================================================================== */
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  await getKnownPropsSet(SCORECARD_OBJECT);
  const has = (n) => KNOWN_PROPS.get(SCORECARD_OBJECT)?.has(n);

  const activityName = `${callId} — Initial Consultation — ${new Date().toISOString().slice(0, 10)}`;

  // 9 x Qual_* metrics (0 or 1)
  const Q = buildQualFromAnalysis(analysis); // returns the 9 booleans you asked for
  const consultScore10 = Math.max(1, Math.round((sum(Object.values(Q)) / 9) * 10));

  // Prompt-driven Sales performance rating (1–10) + summary
  const perf10 = clamp(Math.round(numberOrNull(analysis?.sales_performance_rating) ?? 0), 1, 10);
  const summary = buildCoachingSummary(analysis);

  // Mirror IC fields from the Call
  const likeScore10 = toOneToTenFromPct(analysis?.likelihood_to_close) ?? 5;
  const outcomeHS = mapConsultationOutcomeHS(analysis?.outcome, analysis?.likelihood_to_close);

  const props = {
    activity_type: "Initial Consultation",
    activity_name: activityName,
    hubspot_owner_id: ownerId || undefined,

    // The nine Qual_* fields (0/1)
    ...(has("qual_benefits_linked_to_needs")     ? { qual_benefits_linked_to_needs: Q.benefits_linked_to_needs } : {}),
    ...(has("qual_clear_responses_or_followup")  ? { qual_clear_responses_or_followup: Q.clear_responses_or_followup } : {}),
    ...(has("qual_commitment_requested")         ? { qual_commitment_requested: Q.commitment_requested } : {}),
    ...(has("qual_intro")                        ? { qual_intro: Q.intro } : {}),
    ...(has("qual_next_steps_confirmed")         ? { qual_next_steps_confirmed: Q.next_steps_confirmed } : {}),
    ...(has("qual_open_question")                ? { qual_open_question: Q.open_question } : {}),
    ...(has("qual_rapport")                      ? { qual_rapport: Q.rapport } : {}),
    ...(has("qual_relevant_pain_identified")     ? { qual_relevant_pain_identified: Q.relevant_pain_identified } : {}),
    ...(has("qual_services_explained_clearly")   ? { qual_services_explained_clearly: Q.services_explained_clearly } : {}),

    // Consultation Score (1–10)
    ...(has("consult_score_final")               ? { consult_score_final: consultScore10 } : {}),

    // Sales performance rating (prompt) + summary
    ...(has("sales_performance_rating")          ? { sales_performance_rating: String(perf10) } : {}),
    ...(has("sales_scorecard___what_you_can_improve_on") 
                                                 ? { sales_scorecard___what_you_can_improve_on: summary } : {}),

    // Mirrors from the Call
    ...(has("ai_consultation_likelihood_to_close") ? { ai_consultation_likelihood_to_close: likeScore10 } : {}),
    ...(has("ai_consultation_outcome")             ? { ai_consultation_outcome: outcomeHS } : {}),
    ...(has("ai_consultation_required_materials")  ? { ai_consultation_required_materials: toShortList(analysis?.materials_to_send, [], "No materials requested.") } : {}),
    ...(has("ai_decision_criteria")                ? { ai_decision_criteria: toShortList(analysis?.ai_decision_criteria, inferDecisionCriteriaFromSummary(analysis?.summary || []), "Not mentioned.") } : {}),
    ...(has("ai_key_objections")                   ? { ai_key_objections: ensureArray(analysis?.objections).length ? ensureArray(analysis?.objections).join("; ").slice(0, 1000) : "No objections" } : {}),
    ...(has("ai_next_steps")                       ? { ai_next_steps: toShortList(analysis?.next_actions, [], "No next steps captured.") } : {}),
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

/* ================== Helpers ================== */
function ensureArray(v){ if(Array.isArray(v)) return v.filter(Boolean).map(String); if(v==null) return []; return [String(v)].filter(Boolean); }
function toMultiline(v){ if(Array.isArray(v)) return v.join("\n"); if(v==null) return undefined; return String(v); }
function toShortList(primary, inferred=[], fallback=""){ const a=ensureArray(primary); if(a.length) return a.join("; ").slice(0, 1000); const b=ensureArray(inferred); return (b.length ? b.join("; ") : fallback).slice(0, 1000); }
function numberOrNull(v){ if(v==null) return null; const n=Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function sum(arr){ return arr.reduce((a,b)=>a+(Number(b)||0),0); }

function normaliseSentiment(v){ if(!v) return "Neutral"; const s=String(v).toLowerCase();
  if (s.includes("pos")) return "Positive";
  if (s.includes("neg")) return "Negative";
  return "Neutral";
}
function engagementNumberFromSentiment(sent){ return sent==="Positive" ? 3 : sent==="Negative" ? 1 : 2; }

/** Map analysis outcome/likelihood to your allowed set: Proceed now, Likely, Unclear, Not now, No fit */
function mapConsultationOutcomeHS(outcomeText, likelihoodPct){
  const s = String(outcomeText || "").toLowerCase();
  if (/\bproceed|signed|go(-|\s*)ahead|commit|purchase|bought|agreed|paid/.test(s)) return "Proceed now";
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

/* The nine Qual_* (0/1) you specified */
function buildQualFromAnalysis(analysis){
  const e = analysis?.consult_eval || {};
  const as01 = (v)=> (Number(v) >= 0.75 ? 1 : Number(v) > 0 ? 1 : 0);
  const inferHas = (arr)=> ensureArray(arr).length ? 1 : 0;

  return {
    benefits_linked_to_needs:     as01(e.benefits_linked_to_needs ?? 0),
    clear_responses_or_followup:  as01(e.clear_responses_or_followup ?? 0),
    commitment_requested:         as01(e.commitment_requested ?? 0),
    intro:                        as01(e.intro ?? 1),
    next_steps_confirmed:         as01(e.next_steps_confirmed ?? inferHas(analysis?.next_actions)),
    open_question:                as01(e.open_question ?? 0.5),
    rapport:                      as01(e.rapport_open ?? 1),
    relevant_pain_identified:     as01(e.needs_pain_uncovered ?? 1),
    services_explained_clearly:   as01(e.services_explained_clearly ?? 1),
  };
}
