// file: hubspot/hubspot.js
import fetch from "node-fetch";

const HS_BASE = "https://api.hubapi.com";

// Prefer PRIVATE_APP_TOKEN but fall back to HUBSPOT_TOKEN if present
const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  "";

/** Association type IDs you confirmed in your portal */
const TYPEID_SCORECARDS__CALLS = 395; // scorecards -> calls (USER_DEFINED)
const TYPEID_CALLS__SCORECARDS = 396; // calls -> scorecards (USER_DEFINED)
const TYPEID_SCORECARDS__CONTACTS = 421; // scorecards -> contacts (USER_DEFINED)
const TYPEID_SCORECARDS__DEALS = 423; // scorecards -> deals (USER_DEFINED)

function assertToken() {
  if (!HUBSPOT_TOKEN) {
    throw new Error(
      "HubSpot token missing: set HUBSPOT_PRIVATE_APP_TOKEN (or HUBSPOT_TOKEN)."
    );
  }
}

async function hsFetch(path, opts = {}) {
  assertToken();
  const res = await fetch(`${HS_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HubSpot ${opts.method || "GET"} ${path} failed: ${res.status} ${text}`
    );
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------- CALLS ------------------------- */

export async function getCall(callId, properties = []) {
  const props = properties.length ? `?properties=${properties.join(",")}` : "";
  return hsFetch(`/crm/v3/objects/calls/${callId}${props}`);
}

export async function updateCall(callId, properties) {
  return hsFetch(`/crm/v3/objects/calls/${callId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

/** Pull core recording fields from Call (when webhook payload omits them) */
export async function getCallRecordingMeta(callId) {
  const want = [
    "hs_call_video_recording_url",
    "hs_call_recording_url",
    "hs_call_recording_duration",
    "hs_call_status",
  ];
  const res = await getCall(callId, want);
  const p = res?.properties || {};
  return {
    recordingUrl: p.hs_call_video_recording_url || p.hs_call_recording_url || "",
    duration: p.hs_call_recording_duration
      ? Number(p.hs_call_recording_duration)
      : 0,
    status: p.hs_call_status || "",
  };
}

/** Discover contacts & deals associated to a Call */
export async function getCallAssociations(callId) {
  const [contacts, deals] = await Promise.all([
    hsFetch(`/crm/v3/objects/calls/${callId}/associations/contacts?limit=100`),
    hsFetch(`/crm/v3/objects/calls/${callId}/associations/deals?limit=100`),
  ]);

  const contactIds = (contacts?.results || [])
    .map((r) => r.toObjectId)
    .filter(Boolean);
  const dealIds = (deals?.results || [])
    .map((r) => r.toObjectId)
    .filter(Boolean);

  // Call owner
  const call = await getCall(callId, ["hubspot_owner_id"]);
  const ownerId = call?.properties?.hubspot_owner_id || null;

  return { contactIds, dealIds, ownerId };
}

/* ------------------------- SCORECARDS ------------------------- */

export async function createScorecard(scorecardProps) {
  const out = await hsFetch(`/crm/v3/objects/p49487487_sales_scorecards`, {
    method: "POST",
    body: JSON.stringify({ properties: scorecardProps }),
  });
  return out?.id;
}

/** Official v4 batch association with types[] — the reliable way */
async function batchAssociate(fromObjType, toObjType, pairsWithTypeId) {
  if (!pairsWithTypeId?.length) return;

  const inputs = pairsWithTypeId.map(({ fromId, toId, typeId }) => ({
    from: { id: String(fromId) },
    to: { id: String(toId) },
    types: [
      { associationCategory: "USER_DEFINED", associationTypeId: Number(typeId) },
    ],
  }));

  await hsFetch(
    `/crm/v4/associations/${fromObjType}/${toObjType}/batch/create`,
    {
      method: "POST",
      body: JSON.stringify({ inputs }),
    }
  );
}

/** Link a scorecard to call/contact/deal. We do BOTH directions for call<->scorecard. */
export async function associateScorecard({
  scorecardId,
  callId, // required
  contactId, // optional
  dealId, // optional
}) {
  if (callId) {
    // calls -> scorecards (396)
    await batchAssociate("calls", "p49487487_sales_scorecards", [
      { fromId: callId, toId: scorecardId, typeId: TYPEID_CALLS__SCORECARDS },
    ]);

    // scorecards -> calls (395)
    await batchAssociate("p49487487_sales_scorecards", "calls", [
      { fromId: scorecardId, toId: callId, typeId: TYPEID_SCORECARDS__CALLS },
    ]);
  }

  if (contactId) {
    await batchAssociate("p49487487_sales_scorecards", "contacts", [
      {
        fromId: scorecardId,
        toId: contactId,
        typeId: TYPEID_SCORECARDS__CONTACTS,
      },
    ]);
  }

  if (dealId) {
    await batchAssociate("p49487487_sales_scorecards", "deals", [
      { fromId: scorecardId, toId: dealId, typeId: TYPEID_SCORECARDS__DEALS },
    ]);
  }
}

/* ------------------------- UTIL / DEBUG ------------------------- */

export function hasHubSpotToken() {
  return Boolean(HUBSPOT_TOKEN);
}

export function tokenSource() {
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) return "HUBSPOT_PRIVATE_APP_TOKEN";
  if (process.env.HUBSPOT_TOKEN) return "HUBSPOT_TOKEN";
  return "NONE";
}
