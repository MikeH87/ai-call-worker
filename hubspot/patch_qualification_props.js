/* hubspot/patch_qualification_props.js — minimal, isolated patcher (v2)
   Purpose: patch ONLY 3 CALL props (CT bill, director, likelihood) safely.
   Enhancement: if analysis bundle lacks data_points, fetch the CALL and parse ai_data_points_captured there. */

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

const HS_BASE = "https://api.hubapi.com";

const toText = (v, fb = "") => {
  if (v == null) return fb;
  if (Array.isArray(v)) return v.map(x => toText(x, "")).filter(Boolean).join("; ");
  if (typeof v === "object") return String(v?.text ?? v?.content ?? v?.value ?? "");
  const s = String(v).trim();
  return s || fb;
};

const clampEnum = (val, allowed) => {
  const s = String(val ?? "").trim();
  return allowed.includes(s) ? s : "";
};

// 300k / £300,000 / 0.3m / 300 grand
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

// Fallback: look for a number near “corporation tax” / “ct”
function extractCorporationTaxFromText(text = "") {
  const s = String(text || "");
  if (!s) return null;
  // Allow pluralisation (“corporation tax bills”) while still matching the “corporation tax” phrase:
  // We search for a money-like token within a small window adjacent to "corporation tax" or "ct".
  const re = /(?:^|.{0,120})(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)(?=[^a-zA-Z]{0,25}(?:corp(?:oration)?\s*tax|ct\b))|(?:corp(?:oration)?\s*tax|ct\b)[^a-zA-Z]{0,25}(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)/ig;
  let best = null;
  for (const m of s.matchAll(re)) {
    const cand = m[1] || m[2];
    const parsed = parseApproxNumber(cand);
    if (parsed && (!best || parsed > best)) best = parsed;
  }
  return best;
}

async function hsGetCall(callId) {
  const url = `${HS_BASE}/crm/v3/objects/calls/${callId}?properties=ai_data_points_captured`;
  const res = await fetch(url, {
    headers: { "Content-Type":"application/json", Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("[qual-patch] hsGetCall failed:", res.status, t);
    return null;
  }
  try { return await res.json(); } catch { return null; }
}

export async function patchQualificationCallProps({ callId, data }) {
  try {
    if (!callId) { console.warn("[qual-patch] no callId"); return; }

    // 1) Gather from analysis bundle (if present)
    let dataPoints = Array.isArray(data?.ai_data_points_captured)
      ? data.ai_data_points_captured.join("; ")
      : toText(data?.ai_data_points_captured, "");

    // 2) If missing/empty, read the CALL's ai_data_points_captured from HubSpot (post main update)
    if (!dataPoints) {
      const callObj = await hsGetCall(callId);
      const prop = callObj?.properties?.ai_data_points_captured;
      dataPoints = toText(prop, "");
      if (process.env.DEBUG_QUAL) {
        console.log("[qual-patch] pulled dataPoints from CALL:", dataPoints.slice(0, 200));
      }
    }

    // 3) Compute the three fields safely
    const ctFromAI = parseApproxNumber(data?.ai_approx_corporation_tax_bill);
    const ctFromText = (ctFromAI == null) ? extractCorporationTaxFromText(dataPoints) : null;
    const ctBill = (ctFromAI ?? ctFromText ?? null);

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

    // 4) PATCH only these three properties
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
    console.log("[qual-patch] Updated 3 CALL props OK:", callId, props);
  } catch (e) {
    console.error("[qual-patch] error:", e?.message || e);
  }
}
