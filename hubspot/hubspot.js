// hubspot/hubspot.js
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const HUBSPOT_BASE = "https://api.hubapi.com";

// Accept any of these env var names (first wins)
const HS =
  process.env.HUBSPOT_ACCESS_TOKEN ||
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN; // <- new fallback

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

// ------------------------- helpers -------------------------
function hsHeaders() {
  assertToken();
  return {
    Authorization: `Bearer ${HS}`,
    "Content-Type": "application/json",
  };
}

async function hsGet(url) {
  const r = await fetch(url, { headers: hsHeaders() });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HubSpot GET ${url} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function hsPatch(url, body) {
  const r = await fetch(url, {
    method: "PATCH",
    headers: hsHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HubSpot PATCH ${url} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function hsPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: hsHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HubSpot POST ${url} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

// ------------------------- public API -------------------------

export async function getHubSpotObject(objectType, id, properties = []) {
  const propQuery = properties.length
    ? `?properties=${properties.join(",")}`
    : "";
  const url = `${HUBSPOT_BASE}/crm/v3/objects/${objectType}/${id}${propQuery}`;
  try {
    return await hsGet(url);
  } catch (e) {
    throw new Error(`HubSpot get ${objectType}/${id} failed: ${e.message}`);
  }
}

export async function getAssociations(id, toType) {
  const url = `${HUBSPOT_BASE}/crm/v4/objects/calls/${id}/associations/${toType}`;
  try {
    const js = await hsGet(url);
    const ids = (js?.results || [])
      .map((x) => x.toObjectId)
      .filter(Boolean);
    return ids;
  } catch (e) {
    console.warn(
      `[HubSpot] assoc calls:${id} -> ${toType} failed: ${e.message}`
    );
    return [];
  }
}

// The rest of your updateCall/createScorecard functions unchanged...
export { updateCall, createScorecard } from "./_exported-impl.js";
