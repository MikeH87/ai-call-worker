/* hubspot/patch_qualification_props.js — v5
   Safe helper: optionally patch 3 CALL props for Qualification calls.
   - Tries to infer corporation tax bill from ai_data_points_captured
   - Does NOT overwrite explicit values coming from analyseQualification
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

// Robust numeric parser for things like "30k", "0.3m", "300 grand", "£90,000"
function parseApproxNumber(x) {
  const s0 = String(x ?? "").trim();
  if (!s0) return null;
  const s = s0.toLowerCase().replace(/£|,|\s/g, "");

  let m = s.match(/^(\d+(\.\d+)?)k$/);
  if (m) return Math.round(Number(m[1]) * 1_000);

  m = s.match(/^(\d+(\.\d+)?)(m|million)$/);
  if (m) return Math.round(Number(m[1]) * 1_000_000);

  m = s.match(/^(\d+(\.\d+)?)(grand|g)$/);
  if (m) return Math.round(Number(m[1]) * 1_000);

  const only = s.replace(/[^0-9.]/g, "");
  const n = Number(only);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// CT extractor: scan for any money-like token within a window around "corporation tax"/"corp tax"/"ct"
function extractCorporationTaxFromText(text = "") {
  const s = String(text || "");
  if (!s) return null;

  const lower = s.toLowerCase();
  if (!/(corp(?:oration)?\s*tax|ct\b)/.test(lower)) return null;

  const moneyRe = /£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?/gi;
  let best = null;
  let m;

  while ((m = moneyRe.exec(s)) !== null) {
    const valueStr = m[0];
    const idx = m.index;
    const windowStart = Math.max(0, idx - 80);
    const windowEnd = Math.min(s.length, idx + valueStr.length + 80);
    const window = s.slice(windowStart, windowEnd).toLowerCase();

    if (/(corp(?:oration)?\s*tax|corp tax|ct\b)/.test(window)) {
      const parsed = parseApproxNumber(valueStr);
      if (parsed && (!best || parsed > best)) best = parsed;
    }
  }
  return best;
}

async function hsGetCallDataPoints(callId) {
  const url = `${HS_BASE}/crm/v3/objects/calls/${callId}?properties=ai_data_points_captured,ai_is_company_director,ai_qualification_likelihood_to_book_ic,ai_approx_corporation_tax_bill`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HUBSPOT_TOKEN}` }
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
    if (!HUBSPOT_TOKEN) { console.warn("[qual-patch] no HubSpot token"); return; }

    const callObj = await hsGetCallDataPoints(callId);
    const propsInCall = callObj?.properties || {};

    const dataPoints = String(propsInCall.ai_data_points_captured ?? "");
    const ctExisting = parseApproxNumber(
      data?.ai_approx_corporation_tax_bill ?? propsInCall.ai_approx_corporation_tax_bill
    );
    const ctFromText = ctExisting == null ? extractCorporationTaxFromText(dataPoints) : null;
    const ctBill = ctExisting ?? ctFromText ?? null;

    let director = clampEnum(
      data?.ai_is_company_director ?? propsInCall.ai_is_company_director ?? "Unsure",
      ["Yes", "No", "Unsure"]
    );

    const likelihoodBookIC = clampEnum(
      data?.ai_qualification_likelihood_to_book_ic ?? propsInCall.ai_qualification_likelihood_to_book_ic ?? "Unclear",
      ["Booked", "Very Likely", "Likely", "Unclear", "Unlikely", "No"]
    );

    // Business rule: if we have a CT bill and no strong contrary signal, treat as director = Yes
    if ((director === "" || director === "Unsure") && ctBill != null) {
      director = "Yes";
    }

    const props = {};
    if (ctBill != null && ctBill > 0) props.ai_approx_corporation_tax_bill = String(ctBill);
    if (director) props.ai_is_company_director = director;
    if (likelihoodBookIC) props.ai_qualification_likelihood_to_book_ic = likelihoodBookIC;

    if (!Object.keys(props).length) {
      console.log("[qual-patch] Nothing to update for", callId);
      return;
    }

    const url = `${HS_BASE}/crm/v3/objects/calls/${callId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      body: JSON.stringify({ properties: props }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("[qual-patch] PATCH failed:", res.status, t, "props:", props);
      return;
    }
    console.log("[qual-patch] Updated CALL props OK:", callId, props, "dataPoints:", dataPoints.slice(0, 200));
  } catch (e) {
    console.error("[qual-patch] error:", e?.message || e);
  }
}

