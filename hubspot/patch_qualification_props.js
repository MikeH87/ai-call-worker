/* hubspot/patch_qualification_props.js — v3
   Safe, isolated: patches ONLY 3 CALL props.
   Change: ALWAYS fetch the Call’s ai_data_points_captured from HubSpot and parse CT from there.
*/

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

const HS_BASE = "https://api.hubapi.com";

const clampEnum = (val, allowed) => {
  const s = String(val ?? "").trim();
  return allowed.includes(s) ? s : "";
};

function parseApproxNumber(x) {
  const s0 = String(x ?? "").trim();
  if (!s0) return null;
  const s = s0.toLowerCase().replace(/£|,|\s/g, "");
  let m = s.match(/^(\d+(\.\d+)?)k$/); if (m) return Math.round(Number(m[1]) * 1_000);
  m = s.match(/^(\d+(\.\d+)?)(m|million)$/); if (m) return Math.round(Number(m[1]) * 1_000_000);
  m = s.match(/^(\d+(\.\d+)?)(grand|g)$/); if (m) return Math.round(Number(m[1]) * 1_000);
  const only = s.replace(/[^0-9.]/g, "");
  const n = Number(only);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// CT extractor: tolerant window around "corporation tax" / "ct"
function extractCorporationTaxFromText(text = "") {
  const s = String(text || "");
  if (!s) return null;
  const re = /(?:^|.{0,120})(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)(?=[^a-zA-Z]{0,25}(?:corp(?:oration)?\s*tax|ct\b))|(?:corp(?:oration)?\s*tax|ct\b)[^a-zA-Z]{0,25}(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)/ig;
  let best = null;
  for (const m of s.matchAll(re)) {
    const cand = m[1] || m[2];
    const parsed = parseApproxNumber(cand);
    if (parsed && (!best || parsed > best)) best = parsed;
  }
  return best;
}

async function hsGetCallDataPoints(callId) {
  const url = `${HS_BASE}/crm/v3/objects/calls/${callId}?properties=ai_data_points_captured,ai_is_company_director,ai_qualification_likelihood_to_book_ic`;
  const res = await fetch(url, {
    headers: { "Content-Type":"application/json", Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("[qual-patch] hsGetCallDataPoints failed:", res.status, t);
    return null;
  }
  try { return await res.json(); } catch { return null; }
}

export async function patchQualificationCallProps({ callId, data }) {
  try {
    if (!callId) { console.warn("[qual-patch] no callId"); return; }

    // ALWAYS read from the Call in HubSpot (most reliable source after main update)
    const callObj = await hsGetCallDataPoints(callId);
    const propsInCall = callObj?.properties || {};

    const dataPoints = String(propsInCall.ai_data_points_captured ?? "");
    const ctFromText = extractCorporationTaxFromText(dataPoints);
    const ctBill = (ctFromText ?? null);

    // For now, keep director/likelihood from analysis if provided; otherwise leave blank (prompt tweak will fix)
    const director = clampEnum(
      data?.ai_is_company_director,
      ["Yes", "No", "Unsure"]
    );
    const likelihoodBookIC = clampEnum(
      data?.ai_qualification_likelihood_to_book_ic,
      ["Booked", "Very Likely", "Likely", "Unclear", "Unlikely", "No"]
    );

    const props = {
      ai_approx_corporation_tax_bill: (ctBill != null ? String(ctBill) : ""),
      ai_is_company_director: director,
      ai_qualification_likelihood_to_book_ic: likelihoodBookIC,
    };

    // PATCH only these three properties (cannot affect anything else)
    const url = `${HS_BASE}/crm/v3/objects/calls/${callId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      },
      body: JSON.stringify({ properties: props }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("[qual-patch] PATCH failed:", res.status, t, "props:", props);
      return;
    }
    console.log("[qual-patch] Updated 3 CALL props OK:", callId, props, "dataPoints:", dataPoints.slice(0,200));
  } catch (e) {
    console.error("[qual-patch] error:", e?.message || e);
  }
}
