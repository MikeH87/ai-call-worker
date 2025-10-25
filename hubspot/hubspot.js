// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY; // Private App Token
const HS_BASE = "https://api.hubapi.com";

// === TLPI custom object (from your schema) ===
const SCORECARD_OBJECT = process.env.HUBSPOT_SCORECARD_OBJECT || "p49487487_sales_scorecards";
// If you want to fallback to notes for quick smoke tests, set HUBSPOT_SCORECARD_OBJECT=notes

if (!HUBSPOT_TOKEN) {
  console.warn("[cfg] HUBSPOT_TOKEN missing — HubSpot updates will fail.");
}

function hsHeaders() {
  return {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/* ---------------------------
   GET object + associations
----------------------------*/
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
  const ids = js?.results?.map(r => r?.toObjectId).filter(Boolean) || [];
  return ids;
}

/* ---------------------------
   UPDATE CALL (your fields)
----------------------------*/
export async function updateCall(callId, analysis) {
  const props = {};

  // Summary -> hs_call_body (string)
  const summaryStr = arrayToBullets(analysis?.summary, "• ");
  if (summaryStr) props.hs_call_body = summaryStr.slice(0, 5000);

  // === AI Fields you provided for the Call object ===
  // Call type & confidence
  const inferredType = normaliseCallType(analysis?.call_type); // map to your allowed values
  if (inferredType) props.ai_inferred_call_type = inferredType;

  // Only set hs_activity_type if we think we’re right (>=75)
  const conf = toNumberOrNull(analysis?.ai_call_type_confidence);
  if (conf != null) props.ai_call_type_confidence = clamp(conf, 0, 100);
  if (inferredType && (props.ai_call_type_confidence ?? 0) >= 75) {
    props.hs_activity_type = inferredType;
  }

  // Objections bullets & derived "primary"
  const objections = ensureArray(analysis?.objections);
  if (objections.length) {
    props.ai_objections_bullets = objections.join(" • ").slice(0, 5000);
    props.ai_primary_objection = objections[0].slice(0, 500);
  }

  // Severity (if present / normalise), else leave unset
  if (analysis?.ai_objection_severity) {
    props.ai_objection_severity = normaliseSeverity(analysis.ai_objection_severity);
  }

  // Product interest (from products_discussed)
  const productInterest = mapProductInterest(analysis?.key_details?.products_discussed);
  if (productInterest) props.ai_product_interest = productInterest;

  // Data points captured / Missing info (if your analysis adds these later)
  if (analysis?.ai_data_points_captured) {
    props.ai_data_points_captured = toMultiline(analysis.ai_data_points_captured);
  }
  if (analysis?.ai_missing_information) {
    props.ai_missing_information = toMultiline(analysis.ai_missing_information);
  }

  // Sentiment (derived from outcome if not provided explicitly)
  const sentiment = normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome);
  if (sentiment) props.ai_customer_sentiment = sentiment;

  // Complaint / escalation (optional if present)
  if (analysis?.ai_complaint_detected) {
    props.ai_complaint_detected = normaliseYesNoUnclear(analysis.ai_complaint_detected);
  }
  if (analysis?.ai_escalation_required) {
    props.ai_escalation_required = normaliseEscalation(analysis.ai_escalation_required);
  }
  if (analysis?.ai_escalation_notes) {
    props.ai_escalation_notes = toMultiline(analysis.ai_escalation_notes);
  }

  // Likelihood to close (0–100)
  if (typeof analysis?.likelihood_to_close === "number") {
    props.tlpi_likelihood_close = clamp(analysis.likelihood_to_close, 0, 100);
  }

  // Outcome (Positive/Neutral/Negative)
  if (analysis?.outcome) {
    props.tlpi_outcome = normaliseSentiment(analysis.outcome); // share same normaliser
  }

  // Nothing else is strictly required — send what we have
  if (Object.keys(props).length === 0) return;

  await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties: props });
}

/* ---------------------------------------------------
   CREATE/UPDATE SCORECARD (custom object) + associate
----------------------------------------------------*/
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  if (SCORECARD_OBJECT === "notes") {
    // Fallback route if you set HUBSPOT_SCORECARD_OBJECT=notes (legacy test mode)
    return createNoteScorecard(analysis, { callId, contactIds, dealIds, ownerId });
  }

  // Identity & coaching
  const callType = normaliseCallType(analysis?.call_type);
  const activityType = callType ?? "Initial Consultation";
  const activityName = `${callId} — ${activityType} — ${new Date().toISOString().slice(0,10)}`;

  const scorecardProps = {
    activity_type: activityType,                         // text
    activity_name: activityName,                         // text
    sales_performance_rating_: toIntegerOrNull(analysis?.scorecard?.overall, 10), // 1–10
    sales_scorecard___what_you_can_improve_on: buildCoachingNotes(analysis),      // long text

    // Scorecard mirrors of Call-level AI fields
    sc_ai_objections_bullets: arrayToBullets(analysis?.objections, "• "),
    sc_ai_primary_objection: ensureArray(analysis?.objections)[0] || undefined,
    sc_ai_objection_severity: analysis?.ai_objection_severity
      ? normaliseSeverity(analysis.ai_objection_severity)
      : undefined,
    sc_ai_product_interest: mapProductInterest(analysis?.key_details?.products_discussed),
    sc_ai_data_points_captured: analysis?.ai_data_points_captured ? toMultiline(analysis.ai_data_points_captured) : undefined,
    sc_ai_missing_information: analysis?.ai_missing_information ? toMultiline(analysis.ai_missing_information) : undefined,
    sc_ai_customer_sentiment: normaliseSentiment(analysis?.ai_customer_sentiment || analysis?.outcome),
    sc_ai_complaint_detected: analysis?.ai_complaint_detected
      ? normaliseYesNoUnclear(analysis.ai_complaint_detected)
      : undefined,
    sc_ai_escalation_required: analysis?.ai_escalation_required
      ? normaliseEscalation(analysis.ai_escalation_required)
      : undefined,
    sc_ai_escalation_notes: analysis?.ai_escalation_notes ? toMultiline(analysis.ai_escalation_notes) : undefined,
  };

  // Create the custom object record
  const created = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, {
    properties: scorecardProps,
  });

  const scoreId = created?.id;
  if (!scoreId) {
    console.warn("[HubSpot] Scorecard creation returned no id");
    return { type: SCORECARD_OBJECT, id: null };
  }

  // Associate scorecard ↔ Call (primary), Contacts, Deals
  // Use v4 labels fallback to avoid guessing association type strings
  await associateWithFallback(SCORECARD_OBJECT, scoreId, "calls", callId);
  for (const cId of contactIds) await associateWithFallback(SCORECARD_OBJECT, scoreId, "contacts", cId);
  for (const dId of dealIds) await associateWithFallback(SCORECARD_OBJECT, scoreId, "deals", dId);

  return { type: SCORECARD_OBJECT, id: scoreId };
}

/* ---------------------------
   Legacy Note scorecard (opt)
----------------------------*/
async function createNoteScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {
  const body = [
    "TLPI Sales Scorecard",
    "",
    `Overall: ${numOrNA(analysis?.scorecard?.overall)}/10`,
    "",
    `Objections: ${arrToString(analysis?.objections)}`,
    `Next Actions: ${arrToString(analysis?.next_actions)}`,
    `Materials: ${arrToString(analysis?.materials_to_send)}`,
  ].join("\n");

  const objResponse = await hubspotPost(`crm/v3/objects/notes`, {
    properties: {
      hs_note_body: body.slice(0, 10000),
      hs_timestamp: Date.now(),
      hubspot_owner_id: ownerId || undefined,
    },
  });

  const noteId = objResponse?.id;
  await associateV3("notes", noteId, "calls", callId, "note_to_call");
  for (const cId of contactIds) await associateV3("notes", noteId, "contacts", cId, "note_to_contact");
  for (const dId of dealIds) await associateV3("notes", noteId, "deals", dId, "note_to_deal");
  return { type: "note", id: noteId };
}

/* ---------------------------
   Low-level HTTP helpers
----------------------------*/
async function hubspotPost(path, body) {
  const url = `${HS_BASE}/${path}`;
  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (txt.includes("PROPERTY_DOESNT_EXIST")) {
      console.warn(`[HubSpot] Missing property creating ${url}:`, txt.slice(0, 300));
    } else {
      console.warn(`[HubSpot] POST ${url} failed: ${res.status} ${txt.slice(0, 300)}`);
    }
  }
  try { return await res.json(); } catch { return null; }
}

async function hubspotPatch(path, body) {
  const url = `${HS_BASE}/${path}`;
  const res = await fetch(url, { method: "PATCH", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (txt.includes("PROPERTY_DOESNT_EXIST")) {
      console.warn(`[HubSpot] Some properties missing while updating ${url}:`, txt.slice(0, 300));
    } else {
      console.warn(`[HubSpot] PATCH ${url} failed: ${res.status} ${txt.slice(0, 300)}`);
    }
  }
  try { return await res.json(); } catch { return null; }
}

/* ---------------------------
   Associations (v3 + v4)
----------------------------*/
async function associateV3(fromType, fromId, toType, toId, type) {
  if (!fromId || !toId) return;
  const url = `${HS_BASE}/crm/v3/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
  const body = {
    inputs: [{ from: { id: String(fromId) }, to: { id: String(toId) }, type: String(type) }],
  };
  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`[HubSpot] v3 associate ${fromType}:${fromId} -> ${toType}:${toId} failed: ${res.status} ${txt.slice(0, 300)}`);
    throw new Error("ASSOC_V3_FAIL");
  }
}

async function associateWithFallback(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;

  // Discover available labels (type IDs)
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

  // v4 batch create with discovered typeId
  const url = `${HS_BASE}/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
  const body = {
    inputs: [
      {
        from: { id: String(fromId) },
        to: { id: String(toId) },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
      },
    ],
  };

  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`[HubSpot] v4 associate ${fromType}:${fromId} -> ${toType}:${toId} failed: ${res.status} ${txt.slice(0, 300)}`);
  }
}

/* ---------------------------
   Value helpers / normalisers
----------------------------*/
function ensureArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (v == null) return [];
  return [String(v)].filter(Boolean);
}

function arrayToBullets(arr, bullet = "• ") {
  const a = ensureArray(arr);
  return a.length ? a.map(s => `${bullet}${s}`).join("\n") : "";
}

function toMultiline(v) {
  if (Array.isArray(v)) return v.join("\n");
  if (v == null) return undefined;
  return String(v);
}

function toNumberOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIntegerOrNull(v, max = 10) {
  const n = toNumberOrNull(v);
  if (n == null) return null;
  const nn = Math.round(n);
  if (!Number.isFinite(nn)) return null;
  return clamp(nn, 0, max);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normaliseCallType(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  const map = [
    "qualification call",
    "initial consultation",
    "follow up call",
    "application meeting",
    "strategy call",
    "annual review",
    "existing customer call",
    "other",
  ];
  const found = map.find(m => s.includes(m));
  if (found) return titleCase(found);
  // allow close variants
  if (s.includes("follow") && s.includes("up")) return "Follow up call";
  if (s.includes("consult")) return "Initial Consultation";
  if (s.includes("qualif")) return "Qualification call";
  if (s.includes("applic")) return "Application meeting";
  if (s.includes("strategy")) return "Strategy call";
  if (s.includes("review")) return "Annual Review";
  if (s.includes("existing")) return "Existing customer call";
  return "Other";
}

function titleCase(txt) {
  return txt.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function normaliseSeverity(v) {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("h")) return "High";
  if (s.startsWith("m")) return "Medium";
  if (s.startsWith("l")) return "Low";
  return undefined;
}

function mapProductInterest(products) {
  const arr = ensureArray(products).map(p => p.toLowerCase());
  const hasSSAS = arr.some(p => p.includes("ssas"));
  const hasFIC = arr.some(p => p.includes("fic"));
  if (hasSSAS && hasFIC) return "Both";
  if (hasSSAS) return "SSAS";
  if (hasFIC) return "FIC";
  return undefined;
}

function normaliseSentiment(v) {
  if (!v) return undefined;
  const s = String(v).toLowerCase();
  if (s.includes("pos")) return "Positive";
  if (s.includes("neu")) return "Neutral";
  if (s.includes("neg")) return "Negative";
  // also accept outcome synonyms
  if (s.includes("win") || s.includes("close")) return "Positive";
  if (s.includes("lost") || s.includes("no")) return "Negative";
  return undefined;
}

function normaliseYesNoUnclear(v) {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("y")) return "Yes";
  if (s.startsWith("n")) return "No";
  return "Unclear";
}

function normaliseEscalation(v) {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("y") || s.startsWith("req")) return "Yes";
  if (s.startsWith("mon")) return "Monitor";
  return "No";
}

function arrToString(a) {
  return Array.isArray(a) ? a.join("; ") : "n/a";
}
function numOrNA(n) {
  return typeof n === "number" ? n : "n/a";
}
