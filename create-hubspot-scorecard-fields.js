/**
 * create-hubspot-scorecard-fields.js
 * Creates Sales Scorecard (custom object) metric fields in HubSpot
 * Requires Node 20+ (uses global fetch)
 *
 * ENV:
 *   HUBSPOT_TOKEN=pat-xxx
 *   SALES_PERF_OBJECT=p49487487_sales_scorecards
 *
 * USAGE:
 *   node create-hubspot-scorecard-fields.js
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
const SALES_PERF_OBJECT = process.env.SALES_PERF_OBJECT;
const HS = "https://api.hubapi.com";

if (!TOKEN) throw new Error("Missing HUBSPOT_TOKEN");
if (!SALES_PERF_OBJECT) throw new Error("Missing SALES_PERF_OBJECT");

async function createOneProp(objectType, p) {
  const url = `${HS}/crm/v3/properties/${encodeURIComponent(objectType)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (r.ok) {
    console.log(`✔ created ${objectType}.${p.name}`);
    return;
  }
  const t = await r.text();
  if (r.status === 409 || t.includes("already exists")) {
    console.log(`• exists  ${objectType}.${p.name}`);
    return;
  }
  console.error(`✖ failed ${objectType}.${p.name}: ${r.status} ${t}`);
}

// === property definitions ===
const props = [];

// Qualification call metrics
[
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
].forEach((name) => {
  props.push({
    name,
    label: name.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    description: "Qualification call performance metric (0, 0.5, 1)",
    type: "number",
    fieldType: "number",
    groupName: "qual_metrics",
  });
});

// Initial consultation metrics
[
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
].forEach((name) => {
  props.push({
    name,
    label: name.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    description: "Initial consultation performance metric (0, 0.5, 1)",
    type: "number",
    fieldType: "number",
    groupName: "consult_metrics",
  });
});

// Roll-up scores
[
  { name: "qual_score_final", label: "Qualification Score (1–10)" },
  { name: "consult_score_final", label: "Consultation Score (1–10)" },
].forEach(({ name, label }) => {
  props.push({
    name,
    label,
    description: "Aggregated performance score (calculated via AI worker)",
    type: "number",
    fieldType: "number",
    groupName: "scores_rollup",
  });
});

(async () => {
  console.log(`Creating ${props.length} properties for ${SALES_PERF_OBJECT}...`);
  for (const p of props) await createOneProp(SALES_PERF_OBJECT, p);
  console.log("✅ All done.");
})();
