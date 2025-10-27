// ai/analyseQualification.js
// Analyses Qualification Calls for TLPI
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function asText(v, fb = "") { const s = (v ?? "").toString().trim(); return s || fb; }
function asList(v) {
  if (Array.isArray(v)) return v.map(x => asText(x)).filter(Boolean);
  const s = asText(v); if (!s) return [];
  return s.split(/[\n,;•|-]+/).map(t => t.trim()).filter(Boolean);
}
function clamp(n, min, max, fb = null) {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
}
function raiseIfMissingKey() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
}

// --- OpenAI call helper ---
async function callOpenAI_JSON(prompt, transcript) {
  raiseIfMissingKey();
  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are TLPI’s AI Call Analyst. Task: Analyse **Qualification Calls** only. Use UK English. Return STRICT JSON only."
      },
      {
        role: "user",
        content: `TRANSCRIPT:\n${transcript}\n\nINSTRUCTIONS:\n${prompt}`
      }
    ]
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text().catch(()=> "")}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(text);
}

// --- Prompt & expected schema ---
const PROMPT_QUAL = `
Respond ONLY in valid JSON matching this schema:
{
  "ai_product_interest": "SSAS | FIC | Both | Unclear",
  "ai_decision_criteria": "What matters to the client when choosing TLPI",
  "ai_data_points_captured": "Any personal/company data mentioned (comma separated)",
  "ai_next_steps": "Agreed next actions",
  "ai_key_objections": "Concise summary of objections raised",
  "chat_gpt_increase_likelihood_of_sale": "3 bullet suggestions to improve likelihood of booking an Initial Consultation",
  "chat_gpt_score_reasoning": "Short reason for the score",
  "sales_performance_summary": "2–4 bullet points on what went well / areas to improve",
  "chat_gpt_sales_performance": 1–10,
  "ai_objection_categories": "Short labels like 'Fees' or 'Timing'",
  "ai_objection_severity": "Low | Medium | High",
  "ai_objections_bullets": "Bullet list of objections",
  "ai_primary_objection": "Single most important objection",
  "ai_consultation_likelihood_to_close": 0–100,
  "ai_consultation_required_materials": "Guides, links, or 'Did not request any'",
  "qualification_eval": {
    "qual_active_listening": 0|0.5|1,
    "qual_benefits_linked_to_needs": 0|0.5|1,
    "qual_clear_responses_or_followup": 0|0.5|1,
    "qual_commitment_requested": 0|0.5|1,
    "qual_intro": 0|0.5|1,
    "qual_next_steps_confirmed": 0|0.5|1,
    "qual_open_question": 0|0.5|1,
    "qual_rapport": 0|0.5|1,
    "qual_relevant_pain_identified": 0|0.5|1,
    "qual_services_explained_clearly": 0|0.5|1
  }
}
Rules:
- Outcome target = client books an Initial Consultation.
- If clearly committed to book → ai_consultation_likelihood_to_close ≥ 80.
- If no interest or disqualified → ai_consultation_likelihood_to_close ≤ 30.
`;

export async function analyseQualification(transcript) {
  const t = asText(transcript);
  if (t.length < 25) {
    return { ai_product_interest:"", ai_next_steps:"", ai_key_objections:"", qualification_eval:{} };
  }
  const js = await callOpenAI_JSON(PROMPT_QUAL, t);

  // Normalise numeric + list fields
  const ceIn = js.qualification_eval || {};
  const ceKeys = [
    "qual_active_listening","qual_benefits_linked_to_needs","qual_clear_responses_or_followup",
    "qual_commitment_requested","qual_intro","qual_next_steps_confirmed","qual_open_question",
    "qual_rapport","qual_relevant_pain_identified","qual_services_explained_clearly"
  ];
  const qualification_eval = {};
  for (const k of ceKeys) {
    const v = Number(ceIn[k]);
    qualification_eval[k] = [0,0.5,1].includes(v) ? v : 0;
  }

  // Compute weighted qualification_score (max 10)
  const weights = {
    qual_commitment_requested: 2.0,
    qual_relevant_pain_identified: 1.5,
    qual_benefits_linked_to_needs: 1.5,
    qual_active_listening: 1.0,
    qual_services_explained_clearly: 1.0,
    qual_open_question: 1.0,
    qual_next_steps_confirmed: 0.8,
    qual_clear_responses_or_followup: 0.8,
    qual_rapport: 0.8,
    qual_intro: 0.6
  };
  let total = 0, max = 0;
  for (const [k,w] of Object.entries(weights)) {
    total += (qualification_eval[k] || 0) * w;
    max += w;
  }
  const qualification_score = clamp((total / max) * 10, 0, 10, 0);

  return {
    ...js,
    qualification_eval,
    qualification_score
  };
}
