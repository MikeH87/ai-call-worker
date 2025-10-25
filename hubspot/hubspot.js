// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY;
const HS_BASE = "https://api.hubapi.com";

// Your custom object
const SCORECARD_OBJECT = process.env.HUBSPOT_SCORECARD_OBJECT || "p49487487_sales_scorecards";

if (!HUBSPOT_TOKEN) {
  console.warn("[cfg] HUBSPOT_TOKEN missing — HubSpot updates will fail.");
}

function hsHeaders() {
  return { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" };
}

/* ========== Reads ========== */
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

/* ========== Update Call (maps to your listed ai_* fields) ========== */
export async function updateCall(callId, analysis) {
  const props = {};

  // Summary to body
  const summaryStr = arrayToBullets(analysis?.summary, "• ");
  if (summaryStr) props.hs_call_body = summaryStr.slice(0, 5000);

  // Inferred call type + confidence
  const inferredType = normaliseCallType(analysis?.call_type);
  if (inferredType) props.ai_inferred_call_type = inferredType;

  const conf = toNumberOrNull(analysis?.ai_call_type_confidence ?? analysis?.call_type_confidence);
  if (conf != null) props.ai_call_type_confidence = clamp(conf, 0, 100);
  if (inferredType && (props.ai_call_type_confidence ?? 0) >= 75) {
    props.hs_activity_type = inferredType;
  }

  // Objections
  const objections = ensureArray(analysis?.objections);
  if (objections.length) {
    props.ai_objections_bullets = objections.join(" • ").slice(0, 5000);
    props.ai_primary_objection = objections[0].slice(0, 500);
  }
  if (analysis?.ai_objection_severity) props.ai_objection_severity = normaliseSeverity(analysis.ai_objection_severity);

  // Product Interest from products_discussed
  const productInterest = mapProductInterest(analysis?.key_details?.products_discussed);
  if (productInterest) props.ai_product_interest = productInterest;

  // Optional extras
  if (analysis?.ai_data_points_captured) props.ai_data_points_captured = toMultiline(analysis.ai_data_points_captured);
  if (analysis?.ai_missing_information)  props.ai_missing_information  = toMultiline(analysis.ai_missing_information);

  // Sentiment / complaint / escalation if present or derivable
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome);
  if (sentiment) props.ai_customer_sentiment = sentiment;

  if (analysis?.ai_complaint_detected) props.ai_complaint_detected = normaliseYesNoUnclear(analysis.ai_complaint_detected);
  if (analysis?.ai_escalation_required) props.ai_escalation_required = normaliseEscalation(analysis.ai_escalation_required);
  if (analysis?.ai_escalation_notes) props.ai_escalation_notes = toMultiline(analysis.ai_escalation_notes);

  // Type-specific fields
  if (inferredType === "Initial Consultation") {
    if (typeof analysis?.likelihood_to_close === "number") {
      props.ai_consultation_likelihood_to_close = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
    }
    if (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length) {
      props.ai_consultation_required_materials = analysis.materials_to_send.join("; ").slice(0, 5000);
    }
    if (Array.isArray(analysis?.next_actions) && analysis.next_actions.length) {
      props.ai_next_steps = analysis.next_actions.join("; ").slice(0, 5000);
    }
    if (objections.length) props.ai_key_objections = objections.join("; ").slice(0, 1000);
  }

  if (inferredType === "Follow up call") {
    if (typeof analysis?.likelihood_to_close === "number") {
      props.ai_follow_up_close_likelihood = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
    }
    if (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length) {
      props.ai_follow_up_required_materials = analysis.materials_to_send.join("; ").slice(0, 5000);
    }
    if (objections.length) props.ai_follow_up_objections_remaining = objections.join("; ").slice(0, 1000);
    if (Array.isArray(analysis?.next_actions) && analysis.next_actions.length) {
      props.ai_next_steps = analysis.next_actions.join("; ").slice(0, 5000);
    }
  }

  if (Object.keys(props).length === 0) return;
  await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: props });
}

/* ========== Create Scorecard and associate ========== */
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  if (SCORECARD_OBJECT === "notes") {
    return createNoteScorecard(analysis, { callId, contactIds, dealIds, ownerId });
  }

  const callType = normaliseCallType(analysis?.call_type) || "Initial Consultation";
  const activityName = `${callId} — ${callType} — ${new Date().toISOString().slice(0, 10)}`;

  const props = {
    activity_type: callType,
    activity_name: activityName,
    sales_scorecard___what_you_can_improve_on: buildCoachingNotes(analysis),
    sales_performance_rating_: toScoreOutOf10OrNull(analysis?.scorecard?.overall),

    // AI copies living on scorecard
    ai_next_steps: Array.isArray(analysis?.next_actions) && analysis.next_actions.length
      ? analysis.next_actions.join("; ").slice(0, 5000)
      : undefined,
    ai_key_objections: ensureArray(analysis?.objections).join("; ").slice(0, 1000) || undefined,
    ai_consultation_required_materials: Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length
      ? analysis.materials_to_send.join("; ").slice(0, 5000)
      : undefined,
    ai_decision_criteria: analysis?.ai_decision_criteria ? toMultiline(analysis.ai_decision_criteria) : undefined,
  };

  if (callType === "Initial Consultation" && typeof analysis?.likelihood_to_close === "number") {
    props.ai_consultation_likelihood_to_close = clamp(Math.max(1, Math.round(analysis.likelihood_to_close / 10)), 1, 10);
  }

  const created = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, { properties: props });
  const scoreId = created?.id;
  if (!scoreId) {
    console.warn("[HubSpot] Scorecard creation returned no id");
    return { type: SCORECARD_OBJECT, id: null };
  }

  await associateWithFallback(SCORECARD_OBJECT, scoreId, "calls", callId);
  for (const cId of contactIds) await associateWithFallback(SCORECARD_OBJECT, scoreId, "contacts", cId);
  for (const dId of dealIds) await associateWithFallback(SCORECARD_OBJECT, scoreId, "deals", dId);

  return { type: SCORECARD_OBJECT, id: scoreId };
}

/* ========== Legacy Note scorecard (optional) ========== */
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

/* ========== HTTP helpers ========== */
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

/* ========== Associations (v3 + v4) ========== */
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

async function associateWithFallback(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;
  const labelsUrl = `${HS_BASE}/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/labels`;
  const labelsRes = await fetch(labelsUrl, { headers: hsHeaders() });
  if (!labelsRes.ok) {
    const txt = await labelsRes.text().catch(() => "");
    console.warn(`[HubSpot] association labels fetch failed: ${labelsRes.status} ${txt.slice(0, 300)}`);
    return;
  }
  const labels = await labelsRes.json();
  const typeId = labels?.results?.[0]?.typeId;
  if (!typeId) {
    console.warn("[HubSpot] No association typeId available for", fromType, "->", toType);
    return;
  }
  const url = `${HS_BASE}/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
  const body = { inputs: [{ from: { id: String(fromId) }, to: { id: String(toId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] }] };
  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`[HubSpot] v4 associate ${fromType}:${fromId} -> ${toType}:${toId} failed: ${res.status} ${txt.slice(0, 300)}`);
  }
}

/* ========== Helpers / normalisers ========== */
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
    "qualification call", "initial consultation", "follow up call",
    "application meeting", "strategy call", "annual review", "existing customer call", "other",
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

function normaliseSeverity(v){const s=String(v||"").toLowerCase(); if(s.startsWith("h"))return"High"; if(s.startsWith("m"))return"Medium"; if(s.startsWith("l"))return"Low"; return undefined;}
function mapProductInterest(products){const arr=ensureArray(products).map(p=>p.toLowerCase()); const hasSSAS=arr.some(p=>p.includes("ssas")); const hasFIC=arr.some(p=>p.includes("fic")); if(hasSSAS&&hasFIC)return"Both"; if(hasSSAS)return"SSAS"; if(hasFIC)return"FIC"; return undefined;}
function normaliseSentiment(v){if(!v)return undefined; const s=String(v).toLowerCase(); if(s.includes("pos"))return"Positive"; if(s.includes("neu"))return"Neutral"; if(s.includes("neg"))return"Negative"; if(s.includes("win")||s.includes("close"))return"Positive"; if(s.includes("lost")||s.includes("no "))return"Negative"; return undefined;}
function normaliseYesNoUnclear(v){const s=String(v||"").toLowerCase(); if(s.startsWith("y"))return"Yes"; if(s.startsWith("n"))return"No"; return"Unclear";}
function normaliseEscalation(v){const s=String(v||"").toLowerCase(); if(s.startsWith("y")||s.startsWith("req"))return"Yes"; if(s.startsWith("mon"))return"Monitor"; return"No";}
function arrToString(a){return Array.isArray(a)?a.join("; "):"n/a";}

/** Build a short coaching summary for scorecard */
function buildCoachingNotes(analysis) {
  const good = [];
  const improve = [];

  // Derive from analysis summary/scorecard
  const s = ensureArray(analysis?.summary);
  if (s.length) good.push("Clear summary captured");
  if (Array.isArray(analysis?.next_actions) && analysis.next_actions.length) good.push("Specific next actions set");
  if (Array.isArray(analysis?.materials_to_send) && analysis.materials_to_send.length) good.push("Materials promised");

  const overall = toScoreOutOf10OrNull(analysis?.scorecard?.overall);
  if (overall != null && overall < 6) improve.push("Strengthen discovery depth");
  if (ensureArray(analysis?.objections).length) improve.push("Tighter objection handling");
  if (!analysis?.likelihood_to_close || analysis.likelihood_to_close < 60) improve.push("Create crisper close plan");

  const lines = [];
  if (good.length) lines.push("What went well: " + good.slice(0, 3).join(" • "));
  if (improve.length) lines.push("Areas to improve: " + improve.slice(0, 3).join(" • "));
  const out = lines.join("\n");
  return out.slice(0, 10000);
}
