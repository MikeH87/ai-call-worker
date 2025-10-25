// hubspot/scorecard.js
// Creates Sales Scorecard and associates to Call, Contact, Deal

import fetch from "node-fetch";
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

function ymd(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export async function createScorecard(props, { callId, contactIds, dealIds, ownerId, typeLabel, timestamp }) {
  const body = {
    properties: {
      activity_type: typeLabel,
      activity_name: `${callId} — ${typeLabel} — ${ymd(timestamp)}`,
      hubspot_owner_id: ownerId || undefined,
      ...props,
    },
    associations: [],
  };

  // Helper to attach IDs safely
  const numeric = (arr) => (arr || []).map(String).filter((x) => /^\d+$/.test(x));

  const addAssoc = (ids, typeLabel) => {
    const valid = numeric(ids);
    if (!valid.length) {
      console.warn(`[warn] no valid ${typeLabel} associations found`);
      return;
    }
    valid.forEach((id) => {
      body.associations.push({
        to: { id },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 0 }],
      });
    });
  };

  // Always associate to the Call itself, plus Contact(s) and Deal(s)
  addAssoc([callId], "calls");
  addAssoc(contactIds, "contacts");
  addAssoc(dealIds, "deals");

  // Create the Scorecard
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/p49487487_sales_scorecards", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const j = await res.json();
  if (!res.ok) console.warn("[warn] createScorecard failed:", j);
  else console.log("[scorecard] created", j.id);
}
