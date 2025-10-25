// hubspot/hubspot.js
// HubSpot helper functions for calls and associations

import fetch from "node-fetch";

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// --- Update a HubSpot object (call, scorecard, etc.) ---
export async function updateHubSpotObject(objectType, objectId, properties) {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });

  if (!res.ok) {
    const msg = await res.text();
    console.warn(`[warn] updateHubSpotObject failed: ${msg}`);
  }
}

// --- Get HubSpot object with selected properties ---
export async function getHubSpotObject(objectType, objectId, props = []) {
  const params = new URLSearchParams({ properties: props.join(",") });
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`fetch ${objectType} failed: ${res.status}`);
  return await res.json();
}

// --- Get associations (contacts, deals, etc.) for a Call ---
export async function getAssociations(callId, targetType) {
  const url = `https://api.hubapi.com/crm/v4/objects/calls/${callId}/associations/${targetType}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    if (!res.ok) {
      console.warn(`[warn] association fetch failed: ${targetType} ${res.status}`);
      return [];
    }
    const j = await res.json();
    return (j?.results || []).map((x) => String(x.id)).filter((id) => /^\d+$/.test(id));
  } catch (err) {
    console.warn("[warn] association fetch error:", err.message);
    return [];
  }
}
