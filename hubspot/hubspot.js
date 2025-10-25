// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY;
const HS_BASE = "https://api.hubapi.com";

// Custom Scorecard object
const SCORECARD_OBJECT = process.env.HUBSPOT_SCORECARD_OBJECT || "p49487487_sales_scorecards";

if (!HUBSPOT_TOKEN) console.warn("[cfg] HUBSPOT_TOKEN missing — HubSpot updates will fail.");

function hsHeaders() {
  return { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" };
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

  // SUMMARY: use hs_call_summary (this is what HubSpot renders on the call)
  const summaryStr = arrayToBullets(analysis?.summary, "• ") || "No summary generated.";
  props.hs_call_summary = summaryStr.slice(0, 5000);

  // Inferred call type + confidence
  const inferredType = normaliseCallType(analysis?.call_type);
  if (inferredType) props.ai_inferred_call_type = inferredType;

  const explicitConf = toNumberOrNull(analysis?.ai_call_type_confidence ?? analysis?.call_type_confidence);
  const conf = explicitConf != null ? clamp(explicitConf, 0, 100) : (inferredType ? 85 : null);
  if (conf != null) props.ai_call_type_confidence = conf;
  if (inferredType && conf >= 75) props.hs_activity_type = inferredType;

  // Objections (text fields defaulted so nothing looks blank)
  const objections = ensureArray(analysis?.objections);
  if (objections.length) {
    props.ai_objections_bullets = objections.join(" • ").slice(0, 5000);
    props.ai_primary_objection = objections[0].slice(0, 500);
    props.ai_key_objections = objections.join("; ").slice(0, 1000);
    props.ai_objection_categories = mapObjectionCategories(objections).join("; ") || "Not mentioned.";
    props.ai_objection_severity = analysis?.ai_objection_severity
      ? normaliseSeverity(analysis.ai_objection_severity)
      : "Medium"; // default when objections exist
  } else {
    props.ai_objections_bullets = "No objections mentioned.";
    props.ai_primary_objection = "None.";
    props.ai_key_objections = "None.";
    props.ai_objection_categories = "None.";
    // don't set severity if there are none
  }

  // Product interest (dropdown only if clear)
  const productInterest = mapProductInterest(analysis?.key_details?.products_discussed);
  if (productInterest) props.ai_product_interest = productInterest;

  // Data points captured (or default)
  const kd = analysis?.key_details || {};
  const dp = [];
  if (kd.client_name) dp.push(`Client: ${kd.client_name}`);
  if (kd.company_name) dp.push(`Company: ${kd.company_name}`);
  if (Array.isArray(kd.products_discussed) && kd.products_discussed.length) dp.push(`Products: ${kd.products_discussed.join(", ")}`);
  if (kd.timeline) dp.push(`Timeline: ${kd.timeline}`);
  props.ai_data_points_captured = (dp.length ? dp.join("\n") : "Not mentioned.");

  // Missing info & decision criteria (derive or default)
  props.ai_missing_information = toMultiline(analysis?.ai_missing_information) || "Not mentioned.";
  let decisionCriteria = toMultiline(analysis?.ai_decision_criteria);
  if (!decisionCriteria) {
    const crit = inferDecisionCriteriaFromSummary(analysis?.summary || []);
    decisionCriteria = crit.length ? crit.join("; ") : "Not mentioned.";
  }
  props.ai_decision_criteria = decisionCriteria.slice(0, 1000);

  // Recommendations provided
  if (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length) {
    props.ai_recommendations_provided = analysis.materials_to_send.join("; ").slice(0, 5000);
  } else {
    props.ai_recommendations_provided = "None promised.";
  }

  // Sentiment/engagement/complaint/escalation (safe defaults)
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome) || "Neutral";
  props.ai_customer_sentiment = sentiment;
  props.ai_client_engagement_level = sentimentToEngagement(sentiment);
  props.ai_complaint_detected = normaliseYesNoUnclear(analysis?.ai_complaint_detected || "No");
  props.ai_escalation_required = normaliseEscalation(analysis?.ai_escalation_required || "No");
  props.ai_escalation_notes = toMultiline(analysis?.ai_escalation_notes) || "No escalation required.";

  // Type-specific
  if (inferredType === "Initial Consultation") {
    if (typeof analysis?.likelihood_to_close === "number") {
      props.ai_consultation_likelihood_to_close = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
    }
    props.ai_consultation_outcome = mapConsultationOutcome(analysis?.outcome || "Monitor");
    if (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length) {
      props.ai_consultation_required_materials = analysis.materials_to_send.join("; ").slice(0, 5000);
    } else {
      props.ai_consultation_required_materials = "No materials required.";
    }
    if (Array.isArray(analysis?.next_actions) && analysis.next_actions.length) {
      props.ai_next_steps = analysis.next_actions.join("; ").slice(0, 5000);
    } else {
      props.ai_next_steps = "No next steps captured.";
    }
  }

  if (inferredType === "Follow up call") {
    if (typeof analysis?.likelihood_to_close === "number") {
      props.ai_follow_up_close_likelihood = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
    }
    props.ai_follow_up_required_materials = (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length)
      ? analysis.materials_to_send.join("; ").slice(0, 5000)
      : "No materials required.";
    props.ai_follow_up_objections_remaining = objections.length
      ? objections.join("; ").slice(0, 1000)
      : "No objections remaining.";
    props.ai_next_steps = (Array.isArray(analysis?.next_actions) && analysis.next_actions.length)
      ? analysis.next_actions.join("; ").slice(0, 5000)
      : "No next steps captured.";
  }

  const patchResp = await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: props });

  // DEBUG: read back the key fields so we know they saved
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

  const props = {
    activity_type: callType,
    activity_name: activityName,
    hubspot_owner_id: ownerId || undefined, // copy owner to scorecard
    // coaching + rating (use model output if present; else fallbacks)
    sales_scorecard___what_you_can_improve_on:
      (analysis?.sales_performance_summary && String(analysis.sales_performance_summary).slice(0, 9000))
      || buildCoachingNotes(analysis),
    sales_performance_rating_:
      (toNumberOrNull(analysis?.sales_performance_rating)) ??
      toScoreOutOf10OrNull(analysis?.scorecard?.overall),

    // Mirrors (with safe defaults)
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

  // Initial Consultation: optional likelihood mapping
  if (callType === "Initial Consultation" && typeof analysis?.likelihood_to_close === "number") {
    props.ai_consultation_likelihood_to_close = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
  }

  // NOTE: Your Scorecard currently exposes fields like:
  //   consult_purpose_clearly_stated, consult_needs_pain_uncovered, consult_specific_tax_estimate_given, ...
  // These are different from the c1..c20 names I expected.
  // I will ONLY populate these once you confirm the exact mapping (see Step 3 below).

  const created = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, { properties: props });
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

function mapProductInterest(products){ const arr=ensureArray(products).map(p=>p.toLowerCase());
  const hasSSAS=arr.some(p=>p.includes("ssas")), hasFIC=arr.some(p=>p.includes("fic"));
  if (hasSSAS && hasFIC) return "Both"; if (hasSSAS) return "SSAS"; if (hasFIC) return "FIC"; return undefined;
}

function mapConsultationOutcome(outcome){ const s=String(outcome||"").toLowerCase();
  if (s.includes("positive") || s.includes("win") || s.includes("proceed")) return "Likely";
  if (s.includes("negative") || s.includes("lost") || s.includes("no")) return "Not proceeding";
  return "Monitor";
}

function normaliseSeverity(v){const s=String(v||"").toLowerCase(); if(s.startsWith("h"))return"High"; if(s.startsWith("m"))return"Medium"; if(s.startsWith("l"))return"Low"; return undefined;}

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

function buildCoachingNotes(analysis) {
  const positives = ensureArray(analysis?.summary).slice(0, 3).map(s => `✓ ${s}`).join("\n") || "No positives captured.";
  const improvements = ensureArray(analysis?.next_actions).slice(0, 3).map(s => `• ${s}`).join("\n") || "No improvement items captured.";
  return [`What went well:\n${positives}`, `\nAreas to improve:\n${improvements}`].join("\n").slice(0, 9000);
}

function arrToString(a){return Array.isArray(a)?a.join("; "):"n/a";}
