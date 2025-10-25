// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY; // Private App Token preferred
const HS_BASE = "https://api.hubapi.com";

// Optional: override custom scorecard object type via env
const SCORECARD_OBJECT = process.env.HUBSPOT_SCORECARD_OBJECT || "notes";
// If you *do* have a custom object, set HUBSPOT_SCORECARD_OBJECT to something like "p2_sales_scorecard" (the fully qualified object type).

if (!HUBSPOT_TOKEN) {
  console.warn("[cfg] HUBSPOT_TOKEN missing — HubSpot updates will fail.");
}

function hsHeaders() {
  return {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Generic GET object
 */
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

/**
 * Associations: from calls -> contacts or deals etc
 */
export async function getAssociations(fromId, toType) {
  // v4 association endpoint is simplest
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

/**
 * Update the Call record with structured fields from analysis.
 * We coerce arrays -> strings where appropriate.
 */
export async function updateCall(callId, analysis) {
  const properties = {};

  // Summary: array -> neat string
  if (analysis?.summary) {
    let summaryStr;
    if (Array.isArray(analysis.summary)) {
      // bulletish join
      summaryStr = analysis.summary.map(s => (typeof s === "string" ? `• ${s}` : "")).filter(Boolean).join("\n");
    } else if (typeof analysis.summary === "string") {
      summaryStr = analysis.summary;
    }
    if (summaryStr) properties.hs_call_body = summaryStr.slice(0, 5000);
  }

  // Safe mapping — adjust to your portal’s properties
  if (typeof analysis?.likelihood_to_close === "number") properties.tlpi_likelihood_close = analysis.likelihood_to_close;
  if (analysis?.outcome) properties.tlpi_outcome = String(analysis.outcome);
  if (Array.isArray(analysis?.objections)) properties.tlpi_objections = analysis.objections.join("; ");
  if (Array.isArray(analysis?.next_actions)) properties.tlpi_next_actions = analysis.next_actions.join("; ");
  if (Array.isArray(analysis?.materials_to_send)) properties.tlpi_materials = analysis.materials_to_send.join("; ");
  if (analysis?.call_type) properties.tlpi_call_type_detected = String(analysis.call_type);

  await hubspotPatch(`crm/v3/objects/calls/${encodeURIComponent(callId)}`, { properties });
}

/**
 * Create a "Scorecard" artefact and associate to call + contacts + deals.
 * Default implementation uses a Note if no custom object is configured.
 */
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId = null } = {}) {

  let objResponse;
  if (SCORECARD_OBJECT === "notes") {
    // Create a Note with a structured payload in the body
    const body = [
      "TLPI Sales Scorecard",
      "",
      `Overall: ${numOrNA(analysis?.scorecard?.overall)}/5`,
      `Problem Fit: ${numOrNA(analysis?.scorecard?.problem_fit)}/5`,
      `Budget Fit: ${numOrNA(analysis?.scorecard?.budget_fit)}/5`,
      `Authority: ${numOrNA(analysis?.scorecard?.authority)}/5`,
      `Urgency: ${numOrNA(analysis?.scorecard?.urgency)}/5`,
      "",
      `Likelihood to Close: ${numOrNA(analysis?.likelihood_to_close)}%`,
      `Outcome: ${strOrNA(analysis?.outcome)}`,
      "",
      `Objections: ${arrToString(analysis?.objections)}`,
      `Next Actions: ${arrToString(analysis?.next_actions)}`,
      `Materials: ${arrToString(analysis?.materials_to_send)}`,
    ].join("\n");

    objResponse = await hubspotPost(`crm/v3/objects/notes`, {
      properties: {
        hs_note_body: body.slice(0, 10000),
        hs_timestamp: Date.now(), // REQUIRED for notes
        hubspot_owner_id: ownerId || undefined,
      },
    });

    const noteId = objResponse?.id;
    // Associate Note ↔ Call/Contacts/Deals
    await associate("notes", noteId, "calls", callId);
    for (const cId of contactIds) await associate("notes", noteId, "contacts", cId);
    for (const dId of dealIds) await associate("notes", noteId, "deals", dId);
    return { type: "note", id: noteId };
  }

  // Custom object route
  objResponse = await hubspotPost(`crm/v3/objects/${encodeURIComponent(SCORECARD_OBJECT)}`, {
    properties: {
      name: `Scorecard for call ${callId}`,
      hubspot_owner_id: ownerId || undefined,
      tlpi_overall: analysis?.scorecard?.overall,
      tlpi_problem_fit: analysis?.scorecard?.problem_fit,
      tlpi_budget_fit: analysis?.scorecard?.budget_fit,
      tlpi_authority: analysis?.scorecard?.authority,
      tlpi_urgency: analysis?.scorecard?.urgency,
      tlpi_likelihood_close: analysis?.likelihood_to_close,
      tlpi_outcome: analysis?.outcome ? String(analysis.outcome) : undefined,
      tlpi_objections: Array.isArray(analysis?.objections) ? analysis.objections.join("; ") : undefined,
      tlpi_next_actions: Array.isArray(analysis?.next_actions) ? analysis.next_actions.join("; ") : undefined,
      tlpi_materials: Array.isArray(analysis?.materials_to_send) ? analysis.materials_to_send.join("; ") : undefined,
    },
  });

  const scoreId = objResponse?.id;
  // Associate custom object ↔ Call/Contacts/Deals
  await associate(SCORECARD_OBJECT, scoreId, "calls", callId);
  for (const cId of contactIds) await associate(SCORECARD_OBJECT, scoreId, "contacts", cId);
  for (const dId of dealIds) await associate(SCORECARD_OBJECT, scoreId, "deals", dId);

  return { type: SCORECARD_OBJECT, id: scoreId };
}

// --- Low level helpers with resilient error handling ---

async function hubspotPost(path, body) {
  const url = `${HS_BASE}/${path}`;
  const res = await fetch(url, { method: "POST", headers: hsHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // If properties don’t exist, just log and continue
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

async function associate(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;

  const url = `${HS_BASE}/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}`;
  const res = await fetch(url, { method: "PUT", headers: hsHeaders() });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`[HubSpot] Associate ${fromType}:${fromId} -> ${toType}:${toId} failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

// helpers
function arrToString(a) {
  return Array.isArray(a) ? a.join("; ") : "n/a";
}
function numOrNA(n) {
  return typeof n === "number" ? n : "n/a";
}
function strOrNA(s) {
  return s ? String(s) : "n/a";
}
