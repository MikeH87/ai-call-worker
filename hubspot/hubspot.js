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
 * Associations (read): calls -> contacts/deals
 */
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

/**
 * Update the Call record — for now ONLY write the summary to hs_call_body
 * (We’ll map custom fields in the next step)
 */
export async function updateCall(callId, analysis) {
  let summaryStr = "";
  if (Array.isArray(analysis?.summary)) {
    summaryStr = analysis.summary
      .map(s => (typeof s === "string" ? `• ${s}` : ""))
      .filter(Boolean)
      .join("\n");
  } else if (typeof analysis?.summary === "string") {
    summaryStr = analysis.summary;
  }

  const properties = {};
  if (summaryStr) properties.hs_call_body = summaryStr.slice(0, 5000);

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
    // Associate Note ↔ Call/Contacts/Deals (v3 batch create; reliable)
    await associateV3("notes", noteId, "calls", callId, "note_to_call");
    for (const cId of contactIds) await associateV3("notes", noteId, "contacts", cId, "note_to_contact");
    for (const dId of dealIds) await associateV3("notes", noteId, "deals", dId, "note_to_deal");
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
  await associateWithFallback(SCORECARD_OBJECT, scoreId, "calls", callId);
  for (const cId of contactIds) await associateWithFallback(SCORECARD_OBJECT, scoreId, "contacts", cId);
  for (const dId of dealIds) await associateWithFallback(SCORECARD_OBJECT, scoreId, "deals", dId);

  return { type: SCORECARD_OBJECT, id: scoreId };
}

// --- Low level helpers with resilient error handling ---

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

/**
 * v3 batch association create (reliable)
 */
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

/**
 * v4 fallback using association labels
 */
async function associateWithFallback(fromType, fromId, toType, toId) {
  try {
    const typeGuess = `${singular(fromType)}_to_${singular(toType)}`;
    await associateV3(fromType, fromId, toType, toId, typeGuess);
    return;
  } catch {
    // continue to v4 fallback
  }

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
function singular(type) {
  if (!type) return "";
  if (type.endsWith("ies")) return type.slice(0, -3) + "y";
  if (type.endsWith("s")) return type.slice(0, -1);
  return type;
}
