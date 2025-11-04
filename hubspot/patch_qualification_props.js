/* hubspot/patch_qualification_props.js — minimal, isolated patcher */
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN;

if (!HUBSPOT_TOKEN) {
  console.warn("[warn] HubSpot token missing for patch_qualification_props");
}

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

// parse numbers like 300k / £300,000 / 0.3m / 300 grand
function parseApproxNumber(x) {
  const s = String(x ?? "").toLowerCase().replace(/£|,|\s/g, "");
  if (!s) return null;
  let m = s.match(/^(\d+(\.\d+)?)k$/); if (m) return Math.round(Number(m[1]) * 1_000);
  m = s.match(/^(\d+(\.\d+)?)(m|million)$/); if (m) return Math.round(Number(m[1]) * 1_000_000);
  m = s.match(/^(\d+(\.\d+)?)(grand|g)$/); if (m) return Math.round(Number(m[1]) * 1_000);
  const only = s.replace(/[^0-9.]/g, "");
  const n = Number(only);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// fallback: look for a number near “corporation tax” in a free-text string
function extractCorporationTaxFromText(text = "") {
  const s = String(text || "");
  if (!s) return null;
  const re = /(?:^|.{0,80})(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)(?=[^a-zA-Z]{0,15}(?:corp(?:oration)?\s*tax|ct\b))|(?:corp(?:oration)?\s*tax|ct\b)[^a-zA-Z]{0,15}(£?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|million|grand|g)?)/ig;
  let best = null;
  for (const m of s.matchAll(re)) {
    const cand = m[1] || m[2];
    const parsed = parseApproxNumber(cand);
    if (parsed && (!best || parsed > best)) best = parsed;
  }
  return best;
}

export async function patchQualificationCallProps({ callId, data }) {
  try {
    if (!callId) { console.warn("[qual-patch] no callId"); return; }

    // Gather likely sources
    const dataPoints = Array.isArray(data?.ai_data_points_captured)
      ? data.ai_data_points_captured.join("; ")
      : toText(data?.ai_data_points_captured, "");

    // CT bill: dedicated field first, then fallback from data points
    const ctFromAI = parseApproxNumber(data?.ai_approx_corporation_tax_bill);
    const ctFromText = (ctFromAI == null) ? extractCorporationTaxFromText(dataPoints) : null;
    const ctBill = (ctFromAI ?? ctFromText ?? null);

    // Director + Likelihood (clamped strictly)
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

    // Send PATCH for only these 3 properties (isolated; can't break other fields)
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
      const t = await res.text();
      console.error("[qual-patch] PATCH failed:", res.status, t);
      return;
    }
    console.log("[qual-patch] Updated 3 CALL props OK:", callId, props);
  } catch (e) {
    console.error("[qual-patch] error:", e?.message || e);
  }
}
