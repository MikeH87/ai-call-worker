// hubspot/hubspot.js
// HubSpot helpers: read objects, associations, update Call, create Scorecard
// - Uses v3 objects + v4 associations
// - Prunes unknown properties on 400 PROPERTY_DOESNT_EXIST and retries once
// - Copies owner from Call to Scorecard (hubspot_owner_id) if present
// - Associates Scorecard → Call (always), and → Contact/Deal (best-effort)
// - Writes analysis fields to Call and (optionally) to Scorecard if those props exist

import fetch from "node-fetch";

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// Custom object "Sales Scorecard"
const SCORECARD_TYPE = "p49487487_sales_scorecards";

// ---- small helpers ----
function hsHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function clampInt(v, lo, hi, fallback = 0) {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function normOutcome(v) {
  // Allowed options: "Proceed now", "Likely", "Unclear", "Not now", "No fit"
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("proceed")) return "Proceed now";
  if (s.startsWith("likely")) return "Likely";
  if (s.startsWith("unclear")) return "Unclear";
  if (s.startsWith("not now")) return "Not now";
  if (s.includes("no fit")) return "No fit";
  return ""; // avoid INVALID_OPTION
}

function normProduct(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "both") return "Both";
  if (s.includes("fic")) return "FIC";
  if (s.includes("ssas")) return "SSAS";
  return "";
}

function joinBullets(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.filter(Boolean).join(" • ");
}

// ---- Objects / Associations ----
export async function getHubSpotObject(objectType, objectId, properties = []) {
  const params = new URLSearchParams();
  if (properties.length) params.set("properties", properties.join(","));

  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}?${params}`,
    { headers: hsHeaders() }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`getHubSpotObject failed: ${res.status} ${t}`);
  }
  return await res.json();
}

export async function getAssociations(fromObjectId, toObjectType, fromObjectType = "calls") {
  // v4: /crm/v4/objects/{fromType}/{fromId}/associations/{toType}
  const res = await fetch(
    `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromObjectType)}/${encodeURIComponent(fromObjectId)}/associations/${encodeURIComponent(toObjectType)}?limit=100`,
    { headers: hsHeaders() }
  );
  if (!res.ok) {
    const t = await res.text();
    // Return empty list on association errors (best-effort pattern)
    console.warn(`[assoc] getAssociations ${fromObjectType}:${fromObjectId} → ${toObjectType} failed: ${res.status} ${t}`);
    return [];
  }
  const j = await res.json();
  const ids = (j?.results || []).map(r => r?.toObjectId).filter(Boolean).map(String);
  return Array.from(new Set(ids));
}

// Cache for association labels/types
const assocCache = new Map(); // key `${from}::${to}` -> { typeId, category }

async function findAssocLabel(fromType, toType) {
  const key = `${fromType}::${toType}`;
  if (assocCache.has(key)) return assocCache.get(key);

  // Prefer labels endpoint
  let res = await fetch(
    `https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/labels`,
    { headers: hsHeaders() }
  );
  if (res.ok) {
    const j = await res.json();
    const first = j?.results?.[0];
    if (first?.typeId && first?.category) {
      assocCache.set(key, first);
      return first;
    }
  }

  // Fallback types endpoint
  res = await fetch(
    `https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/types`,
    { headers: hsHeaders() }
  );
  if (res.ok) {
    const j = await res.json();
    const first = j?.results?.[0];
    if (first?.typeId && first?.category) {
      assocCache.set(key, first);
      return first;
    }
  }

  return null;
}

// ---- Update Call with analysis ----
export async function updateCall(callId, analysis) {
  const props = {};

  // Initial Consultation fields (as provided in your portal)
  if (analysis.ai_consultation_outcome) {
    props.ai_consultation_outcome = normOutcome(analysis.ai_consultation_outcome);
  }
  if (analysis.ai_decision_criteria) {
    props.ai_decision_criteria = String(analysis.ai_decision_criteria).slice(0, 3000);
  }
  if (analysis.ai_key_objections) {
    props.ai_key_objections = String(analysis.ai_key_objections).slice(0, 1000);
  }
  if (typeof analysis.ai_consultation_likelihood_to_close !== "undefined") {
    props.ai_consultation_likelihood_to_close = String(
      clampInt(analysis.ai_consultation_likelihood_to_close, 1, 10, 0)
    );
  }
  if (analysis.ai_next_steps) {
    props.ai_next_steps = String(analysis.ai_next_steps).slice(0, 1000);
  }
  if (analysis.ai_consultation_required_materials) {
    props.ai_consultation_required_materials = String(analysis.ai_consultation_required_materials).slice(0, 3000);
  }

  // Product interest + data capture (IC)
  if (analysis.ai_product_interest) {
    props.ai_product_interest = normProduct(analysis.ai_product_interest);
  }
  if (analysis.ai_data_points_captured) {
    props.ai_data_points_captured = Array.isArray(analysis.ai_data_points_captured)
      ? joinBullets(analysis.ai_data_points_captured)
      : String(analysis.ai_data_points_captured);
  }
  if (analysis.ai_missing_information) {
    props.ai_missing_information = Array.isArray(analysis.ai_missing_information)
      ? joinBullets(analysis.ai_missing_information)
      : String(analysis.ai_missing_information);
  }

  // PATCH with prune-on-unknown retry
  const url = `https://api.hubapi.com/crm/v3/objects/calls/${encodeURIComponent(callId)}`;

  async function patch(bodyProps) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: hsHeaders(),
      body: JSON.stringify({ properties: bodyProps }),
    });
    if (res.ok) return true;

    const text = await res.text();
    // If unknown properties, prune and retry once
    if (res.status === 400 && /PROPERTY_DOESNT_EXIST/.test(text)) {
      const bad = [...text.matchAll(/"name":"([^"]+)"/g)].map(m => m[1]);
      if (bad.length) {
        const pruned = { ...bodyProps };
        for (const b of bad) delete pruned[b];
        const res2 = await fetch(url, {
          method: "PATCH",
          headers: hsHeaders(),
          body: JSON.stringify({ properties: pruned }),
        });
        if (res2.ok) return true;
        const text2 = await res2.text();
        console.warn(`[call] prune retry failed: ${res2.status} ${text2}`);
        return false;
      }
    }
    console.warn(`[call] update failed: ${res.status} ${text}`);
    return false;
  }

  const ok = await patch(props);
  if (!ok) throw new Error(`updateCall failed`);
}

// ---- Create Scorecard and associate ----
export async function createScorecard(analysis, { callId, contactIds = [], dealIds = [], ownerId } = {}) {
  // We expect hs_activity_type already set on the Call; fall back if not supplied
  const callType = analysis?.callType || analysis?.ai_inferred_call_type || "Initial Consultation";
  const todayYMD = new Date().toISOString().slice(0, 10);
  const activityName = `${callId ?? "Call"} — ${callType} — ${todayYMD}`;

  // Base properties (required)
  const props = {
    activity_type: callType,
    activity_name: activityName,
  };

  // Copy owner to scorecard if available
  if (ownerId) props.hubspot_owner_id = String(ownerId);

  // (Optional) Mirror analysis fields on the scorecard too, if those props exist in your custom object
  // We don't know the schema at runtime, so we send them and rely on prune-on-unknown via 400 handler below
  const optional = {};
  const copyKeys = [
    "ai_consultation_outcome",
    "ai_decision_criteria",
    "ai_key_objections",
    "ai_consultation_likelihood_to_close",
    "ai_next_steps",
    "ai_consultation_required_materials",
    "ai_product_interest",
    "ai_data_points_captured",
    "ai_missing_information",
  ];
  for (const k of copyKeys) {
    if (typeof analysis[k] !== "undefined" && analysis[k] !== null && analysis[k] !== "") {
      optional[k] = Array.isArray(analysis[k]) ? joinBullets(analysis[k]) : String(analysis[k]);
    }
  }

  // Normalise known dropdown/number
  if (optional.ai_consultation_outcome) {
    optional.ai_consultation_outcome = normOutcome(optional.ai_consultation_outcome);
  }
  if (optional.ai_consultation_likelihood_to_close) {
    optional.ai_consultation_likelihood_to_close = String(
      clampInt(optional.ai_consultation_likelihood_to_close, 1, 10, 0)
    );
  }
  if (optional.ai_product_interest) {
    optional.ai_product_interest = normProduct(optional.ai_product_interest);
  }

  const body = { properties: { ...props, ...optional } };

  // Associations: always try Call; then best-effort Contact/Deal
  const assocBlocks = [];

  if (callId) {
    const lab = await findAssocLabel(SCORECARD_TYPE, "calls");
    if (lab) {
      assocBlocks.push({
        to: { id: String(callId) },
        types: [{ associationCategory: lab.category, associationTypeId: lab.typeId }],
      });
    } else {
      console.warn("[assoc] no label for scorecard→calls");
    }
  }

  if (Array.isArray(contactIds)) {
    const lab = await findAssocLabel(SCORECARD_TYPE, "contacts");
    if (lab) {
      for (const id of contactIds) {
        assocBlocks.push({
          to: { id: String(id) },
          types: [{ associationCategory: lab.category, associationTypeId: lab.typeId }],
        });
      }
    }
  }

  if (Array.isArray(dealIds)) {
    const lab = await findAssocLabel(SCORECARD_TYPE, "deals");
    if (lab) {
      for (const id of dealIds) {
        assocBlocks.push({
          to: { id: String(id) },
          types: [{ associationCategory: lab.category, associationTypeId: lab.typeId }],
        });
      }
    }
  }

  if (assocBlocks.length) body.associations = assocBlocks;

  const url = `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(SCORECARD_TYPE)}`;

  // Create with prune-on-unknown retry
  async function post(p) {
    const res = await fetch(url, {
      method: "POST",
      headers: hsHeaders(),
      body: JSON.stringify(p),
    });
    if (res.ok) return await res.json();

    const text = await res.text();
    if (res.status === 400 && /PROPERTY_DOESNT_EXIST/.test(text)) {
      const bad = [...text.matchAll(/"name":"([^"]+)"/g)].map(m => m[1]);
      if (bad.length) {
        console.warn(`[scorecard] pruning unknown properties: ${bad.join(", ")}`);
        const pruned = { ...p, properties: { ...p.properties } };
        for (const b of bad) delete pruned.properties[b];
        const res2 = await fetch(url, {
          method: "POST",
          headers: hsHeaders(),
          body: JSON.stringify(pruned),
        });
        if (res2.ok) return await res2.json();
        const text2 = await res2.text();
        throw new Error(`scorecard create failed after prune: ${res2.status} ${text2}`);
      }
    }
    throw new Error(`scorecard create failed: ${res.status} ${text}`);
  }

  const created = await post(body);
  console.log(`[scorecard] created ${created?.id} (call=${callId}, contacts=${(contactIds||[]).length}, deals=${(dealIds||[]).length})`);
  return created?.id;
}
