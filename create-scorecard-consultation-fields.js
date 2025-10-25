// create-scorecard-consultation-fields.js
// TLPI helper: adds AI Consultation Insight fields to the Sales Scorecard custom object
// Usage: node create-scorecard-consultation-fields.js

import fetch from "node-fetch";

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const SCORECARD_OBJECT = "p49487487_sales_scorecards";

const GROUP_NAME = "ai_consultation_insights";
const GROUP_LABEL = "AI Consultation Insights";
const GROUP_DESCRIPTION = "AI-generated insights captured from initial consultation calls, providing a summary of client intent, decision drivers, and follow-up requirements.";

const fields = [
  {
    name: "ai_consultation_outcome",
    label: "AI Consultation Outcome",
    description: "Overall outcome of the consultation call based on client signals and sentiment. Used to identify likelihood of proceeding immediately or requiring follow-up.",
    type: "enumeration",
    fieldType: "select",
    options: [
      { label: "Proceed now", value: "Proceed now" },
      { label: "Likely", value: "Likely" },
      { label: "Unclear", value: "Unclear" },
      { label: "Not now", value: "Not now" },
      { label: "No fit", value: "No fit" }
    ]
  },
  {
    name: "ai_decision_criteria",
    label: "AI Decision Criteria",
    description: "Key factors influencing the client's decision-making process, such as timeline, product suitability, or cost considerations.",
    type: "string",
    fieldType: "text"
  },
  {
    name: "ai_key_objections",
    label: "AI Key Objections",
    description: "Main objections or concerns raised by the client during the consultation. Useful for coaching and follow-up planning.",
    type: "string",
    fieldType: "text"
  },
  {
    name: "ai_consultation_likelihood_to_close",
    label: "AI Consultation Likelihood to Close (1–10)",
    description: "Numeric indicator (1–10) of how likely the client is to proceed to application, based on tone, readiness, and intent.",
    type: "number",
    fieldType: "number"
  },
  {
    name: "ai_next_steps",
    label: "AI Next Steps",
    description: "Recommended next actions or commitments identified during the call — such as scheduling follow-ups or sending documents.",
    type: "string",
    fieldType: "text"
  },
  {
    name: "ai_consultation_required_materials",
    label: "AI Consultation Required Materials",
    description: "Any materials or documentation promised to or required by the client following the consultation.",
    type: "string",
    fieldType: "textarea"
  }
];

// Helper function to create a field
async function createProperty(p) {
  const url = `https://api.hubapi.com/crm/v3/properties/${SCORECARD_OBJECT}`;
  const body = {
    ...p,
    groupName: GROUP_NAME,
    displayOrder: 1
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    console.log(`✅ Created ${p.name}`);
  } else {
    const txt = await res.text();
    if (txt.includes("PROPERTY_ALREADY_EXISTS")) {
      console.log(`ℹ️  ${p.name} already exists`);
    } else {
      console.warn(`⚠️  Failed ${p.name}:`, txt);
    }
  }
}

// Helper function to ensure the group exists
async function ensureGroup() {
  const url = `https://api.hubapi.com/crm/v3/properties/${SCORECARD_OBJECT}/groups`;
  const body = {
    name: GROUP_NAME,
    label: GROUP_LABEL,
    displayOrder: 1,
    description: GROUP_DESCRIPTION
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    console.log(`✅ Created group: ${GROUP_LABEL}`);
  } else {
    const txt = await res.text();
    if (txt.includes("already exists")) {
      console.log(`ℹ️  Group already exists`);
    } else {
      console.warn(`⚠️  Failed to create group:`, txt);
    }
  }
}

// Run
(async () => {
  await ensureGroup();
  for (const f of fields) await createProperty(f);
})();
