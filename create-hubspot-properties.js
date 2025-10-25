/**
 * create-hubspot-properties.js
 * Bulk-create Call & Sales Scorecard properties via HubSpot Properties API.
 * Requires Node 20+ (uses global fetch).
 *
 * ENV:
 *   HUBSPOT_TOKEN=pat-xxx
 *   SALES_PERF_OBJECT=<fullyQualifiedName of your Sales Scorecard custom object>
 *
 * USAGE:
 *   node create-hubspot-properties.js
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
const SALES_PERF_OBJECT = process.env.SALES_PERF_OBJECT; // e.g. p49487487_sales_scorecard
const HS = "https://api.hubapi.com";

if (!TOKEN) { console.error("Missing HUBSPOT_TOKEN"); process.exit(1); }
if (!SALES_PERF_OBJECT) { console.error("Missing SALES_PERF_OBJECT"); process.exit(1); }

// ---------- helpers ----------
async function createGroup(objectType, groupName, groupLabel) {
  const url = `${HS}/crm/v3/properties/${encodeURIComponent(objectType)}/groups`;
  const body = { name: groupName, label: groupLabel };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) { console.log(`✔ group created: ${objectType}.${groupName}`); return; }
  const t = await r.text();
  if (r.status === 409 || t.includes("already exists")) {
    console.log(`• group exists: ${objectType}.${groupName}`); return;
  }
  throw new Error(`Group create failed for ${objectType}.${groupName}: ${r.status} ${t}`);
}

async function batchCreateProps(objectType, inputs) {
  if (!inputs.length) return;
  const url = `${HS}/crm/properties/2025-09/${encodeURIComponent(objectType)}/batch/create`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  if (r.ok) { console.log(`✔ ${objectType}: batch created ${inputs.length} properties`); return; }
  const t = await r.text();
  console.warn(`Batch create failed (${r.status}). Falling back to per-prop...`);
  for (const p of inputs) await createOneProp(objectType, p);
}

async function createOneProp(objectType, p) {
  const url = `${HS}/crm/v3/properties/${encodeURIComponent(objectType)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (r.ok) { console.log(`  ✔ created ${objectType}.${p.name}`); return; }
  const t = await r.text();
  if (r.status === 409 || t.includes("already exists")) {
    console.log(`  • exists  ${objectType}.${p.name}`); return;
  }
  throw new Error(`  ✖ failed ${objectType}.${p.name}: ${r.status} ${t}`);
}

// ---------- definitions ----------

// A) Call object
const CALL = "calls";

// groups
const CALL_GROUPS = [
  { name: "ai_routing", label: "AI Routing / Type Inference" },
  { name: "ai_objections", label: "AI Objections (Shared)" },
  { name: "ai_initial_consult", label: "AI Initial Consultation" },
  { name: "ai_follow_up", label: "AI Follow Up" },
];

// properties (as agreed)
const CALL_PROPS = [
  // Routing / Inference
  {
    name: "ai_inferred_call_type",
    label: "AI Inferred Call Type",
    description: "Worker inference when hs_activity_type is blank after 2-minute grace.",
    type: "string", fieldType: "text", groupName: "ai_routing",
  },
  {
    name: "ai_call_type_confidence",
    label: "AI Call Type Confidence",
    description: "0–100 confidence. If ≥ 75, worker may set hs_activity_type.",
    type: "number", fieldType: "number", groupName: "ai_routing",
  },

  // Shared objections
  {
    name: "ai_objections_bullets",
    label: "AI Objections (Bullets)",
    description: "Bulleted list of objections parsed from transcript.",
    type: "string", fieldType: "textarea", groupName: "ai_objections",
  },
  {
    name: "ai_objection_categories",
    label: "AI Objection Categories",
    description: "Normalised objection tags.",
    type: "enumeration", fieldType: "checkbox", groupName: "ai_objections",
    options: [
      { label: "Price", value: "price" },
      { label: "Timing", value: "timing" },
      { label: "Risk", value: "risk" },
      { label: "Complexity", value: "complexity" },
      { label: "Authority", value: "authority" },
      { label: "Fit", value: "fit" },
      { label: "Clarity", value: "clarity" },
    ],
  },
  {
    name: "ai_primary_objection",
    label: "AI Primary Objection",
    description: "Most material objection extracted from the call.",
    type: "string", fieldType: "text", groupName: "ai_objections",
  },
  {
    name: "ai_objection_severity",
    label: "AI Objection Severity",
    description: "Severity of primary objection.",
    type: "enumeration", fieldType: "select", groupName: "ai_objections",
    options: [
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
    ],
  },

  // Initial Consultation
  {
    name: "ai_consultation_outcome",
    label: "AI Consultation Outcome",
    type: "enumeration", fieldType: "select", groupName: "ai_initial_consult",
    options: [
      { label: "Proceed now", value: "proceed_now" },
      { label: "Likely", value: "likely" },
      { label: "Unclear", value: "unclear" },
      { label: "Not now", value: "not_now" },
      { label: "No fit", value: "no_fit" },
    ],
  },
  {
    name: "ai_product_interest",
    label: "AI Product Interest",
    type: "enumeration", fieldType: "checkbox", groupName: "ai_initial_consult",
    options: [
      { label: "FIC", value: "FIC" },
      { label: "SSAS", value: "SSAS" },
      { label: "Both", value: "Both" },
    ],
  },
  {
    name: "ai_key_objections",
    label: "AI Key Objections (Concise)",
    type: "string", fieldType: "text", groupName: "ai_initial_consult",
  },
  {
    name: "ai_decision_criteria",
    label: "AI Decision Criteria",
    type: "string", fieldType: "text", groupName: "ai_initial_consult",
  },

  // Follow Up
  {
    name: "ai_followup_close_likelihood",
    label: "AI Follow-Up Close Likelihood",
    type: "number", fieldType: "number", groupName: "ai_follow_up",
  },
  {
    name: "ai_followup_objections_remaining",
    label: "AI Follow-Up Objections Remaining",
    type: "string", fieldType: "text", groupName: "ai_follow_up",
  },
  {
    name: "ai_followup_required_materials",
    label: "AI Follow-Up Required Materials",
    type: "string", fieldType: "text", groupName: "ai_follow_up",
  },
];

// B) Sales Scorecard (custom object)
const SP = SALES_PERF_OBJECT;

// optional UI groups
const SP_GROUPS = [
  { name: "qual_metrics", label: "Qualification Metrics" },
  { name: "consult_metrics", label: "Initial Consultation Metrics" },
  { name: "scores_rollup", label: "Scores Rollup" },
];

// Qualification metrics (0/0.5/1)
const QUAL_PROPS = [
  "qual_intro",
  "qual_rapport",
  "qual_open_question",
  "qual_relevant_pain_identified",
  "qual_services_explained_clearly",
  "qual_benefits_linked_to_needs",
  "qual_active_listening",
  "qual_clear_responses_or_followup",
  "qual_next_steps_confirmed",
  "qual_commitment_requested",
].map((name) => ({
  name, label: name.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase()),
  type: "number", fieldType: "number", groupName: "qual_metrics",
}));

// Initial Consultation metrics (0/0.5/1)
const CONSULT_METRIC_NAMES = [
  "consult_rapport_open",
  "consult_purpose_clearly_stated",
  "consult_confirm_reason_for_zoom",
  "consult_demo_tax_saving",
  "consult_specific_tax_estimate_given",
  "consult_no_assumptions_evidence_gathered",
  "consult_needs_pain_uncovered",
  "consult_quantified_value_roi",
  "consult_fees_tax_deductible_explained",
  "consult_fees_annualised",
  "consult_fee_phrasing_three_seven_five",
  "consult_closing_question_asked",
  "consult_collected_dob_nin_when_agreed",
  "consult_overcame_objection_and_closed",
  "consult_customer_agreed_to_set_up",
  "consult_next_step_specific_date_time",
  "consult_next_contact_within_5_days",
  "consult_strong_buying_signals_detected",
  "consult_prospect_asked_next_steps",
  "consult_interactive_throughout",
];
const CONSULT_PROPS = CONSULT_METRIC_NAMES.map((name) => ({
  name, label: name.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase()),
  type: "number", fieldType: "number", groupName: "consult_metrics",
}));

const SP_ROLLUP = [
  { name: "qual_score_sum", label: "Qualification Score Sum", type: "number", fieldType: "number", groupName: "scores_rollup" },
  { name: "qual_score_final", label: "Qualification Score Final (1–10)", type: "number", fieldType: "number", groupName: "scores_rollup" },
  { name: "consult_score_sum", label: "Consultation Score Sum", type: "number", fieldType: "number", groupName: "scores_rollup" },
  { name: "consult_score_final", label: "Consultation Score Final (1–10)", type: "number", fieldType: "number", groupName: "scores_rollup" },
];

// ---------- run ----------
(async () => {
  // CALL groups
  for (const g of CALL_GROUPS) await createGroup(CALL, g.name, g.label);
  // SP groups
  for (const g of SP_GROUPS) await createGroup(SP, g.name, g.label);

  // Batch-create props
  await batchCreateProps(CALL, CALL_PROPS);
  await batchCreateProps(SP, [...QUAL_PROPS, ...CONSULT_PROPS, ...SP_ROLLUP]);

  console.log("All done.");
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
