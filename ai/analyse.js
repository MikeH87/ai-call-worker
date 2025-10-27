// ai/analyse.js — v2.0 deterministic scoring
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- helpers ---
const clamp = (n, min, max, fallback = null) => {
  const v = typeof n === "number" ? n : Number(n);
  if (Number.isFinite(v)) return Math.min(max, Math.max(min, v));
  return fallback;
};
const asText = (v, fallback = "") => {
  const s = (v ?? "").toString().trim();
  return s || fallback;
};
const asList = (v) => {
  if (Array.isArray(v)) return v.map(x => asText(x)).filter(Boolean);
  const s = asText(v);
  if (!s) return [];
  return s.split(/[\n,;•|-]+/).map(t => t.trim()).filter(Boolean);
};
const joinBullets = (arr, sep = " • ") => (Array.isArray(arr) && arr.length ? arr.join(sep) : "");

const OUTCOME_ALLOWED = ["Proceed now", "Likely", "Unclear", "Not now", "No fit"];

function normaliseOutcome(s) {
  const t = asText(s).toLowerCase();
  if (!t) return "Unclear";
  if (/(proceed|sign|signed|go ahead|agreed|commit)/.test(t)) return "Proceed now";
  if (/(likely|positive|leaning|keen|interested)/.test(t)) return "Likely";
  if (/(not\s+now|pause|later|defer)/.test(t)) return "Not now";
  if (/(no\s+fit|not\s+interested|decline)/.test(t)) return "No fit";
  return "Unclear";
}
function inferProduct(transcript) {
  const t = transcript.toLowerCase();
  const hasSSAS = /ssas/.test(t);
  const hasFIC  = /\bfic\b|family investment company|family investment companies/.test(t);
  if (hasSSAS && hasFIC) return "Both";
  if (hasSSAS) return "SSAS";
  if (hasFIC)  return "FIC";
  return "";
}
function raiseIfMissingKey() {
  if (!OPENAI_API_KEY) throw new Error(`Missing OPENAI_API_KEY`);
}

// --- transcript normalisation ---
function normaliseTranscript(raw) {
  let t = asText(raw);
  t = t.toLowerCase();
  // remove filler words and repeated spaces
  t = t.replace(/\b(um+|uh+|erm+|like|you know)\b/g, "");
  // remove timestamps [00:12:34] or (00:01)
  t = t.replace(/\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?/g, "");
  // collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// --- OpenAI call with deterministic parameters ---
async function callOpenAI_JSON(prompt, transcript, jsonSchema) {
  raiseIfMissingKey();
  const sys = [
    "You are TLPI’s AI Call Analyst.",
    "Task: Analyse **Initial Consultation** calls only.",
    "Be precise, UK English, and NEVER guess.",
    "If information isn’t present, output an empty string or empty array as appropriate.",
    "Return STRICTLY valid JSON matching the schema.",
  ].join(" ");

  const user = [
    "COMPANY CONTEXT:",
    "- TLPI helps UK company directors with SSAS pensions or Family Investment Companies (FIC).",
    "- Objective of Initial Consultation: explain benefits, surface objections, agree concrete next steps, ideally gain agreement to sign the client agreement (‘Proceed now’).",
    "",
    "EVALUATION NOTES:",
    "- Use the transcript only; do not invent data.",
    "- Product interest: SSAS, FIC, or Both (if both discussed).",
    "- ‘Proceed now’ means they agreed to sign the client agreement (or equivalent explicit commitment).",
    "- If commitment language is clear, set sales_performance_rating >= 8.",
    "",
    "TRANSCRIPT:",
    transcript,
    "",
    "INSTRUCTIONS:",
    prompt,
  ].join("\n");

  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0,           // <— deterministic
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    seed: 7,                  // <— optional deterministic seed
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(text);
}

// --- master prompt (Initial Consultation) ---
const PROMPT_INITIAL_CONSULTATION = `
Return JSON with these keys:
- call_type: string ("Initial Consultation")
- likelihood_to_close: number (0-100, integer)
- outcome: string (one of: Proceed now, Likely, Unclear, Not now, No fit)
- objections: string[] (short labels like "Fees/cost")
- next_actions: string[]
- materials_to_send: string[]
- ai_decision_criteria: string[]
- key_details: object with optional keys (client_name, company_name, products_discussed ["SSAS","FIC"], timeline, dob, ni, utr, address, nationality, pension_refs, company_details)
- sales_performance_rating: number (1-10)
- sales_performance_summary: string (≤4 bullets)
- score_reasoning: string
- increase_likelihood: string (3 bullets)
- consult_eval: object with keys set to 0, 0.5, or 1:
    intro, rapport_open, open_question, needs_pain_uncovered,
    services_explained_clearly, benefits_linked_to_needs, active_listening,
    clear_responses_or_followup, commitment_requested, next_steps_confirmed,
    specific_tax_estimate_given, fees_tax_deductible_explained,
    next_step_specific_date_time, interactive_throughout, quantified_value_roi
Rules:
- If explicit client commitment to proceed/sign: outcome="Proceed now" and rating≥8.
- If field missing, use "" or [].
`;

// --- export ---
export async function analyseTranscript(callTypeLabel, transcript) {
  const t = normaliseTranscript(transcript);
  if (t.length < 30) {
    return {
      call_type: "Initial Consultation",
      likelihood_to_close: 0,
      outcome: "Unclear",
      objections: [],
      next_actions: [],
      materials_to_send: [],
      ai_decision_criteria: [],
      key_details: {},
      sales_performance_rating: 1,
      sales_performance_summary: "No meaningful audio.",
      score_reasoning: "Transcript empty or blank.",
      increase_likelihood: "- Reschedule call; ensure clear audio",
      consult_eval: {},
      uncertainty_reason: "Transcript too short.",
    };
  }

  let js;
  try {
    js = await callOpenAI_JSON(PROMPT_INITIAL_CONSULTATION, t);
  } catch (e) {
    console.warn("OpenAI parse error:", e.message);
    return {
      call_type: "Initial Consultation",
      likelihood_to_close: 0,
      outcome: "Unclear",
      consult_eval: {},
      error: e.message,
    };
  }

  const call_type = "Initial Consultation";
  const likelihood_to_close = clamp(js.likelihood_to_close, 0, 100, 0);
  const outcome = normaliseOutcome(js.outcome);
  const objections = asList(js.objections);
  const next_actions = asList(js.next_actions);
  const materials_to_send = asList(js.materials_to_send);
  const ai_decision_criteria = asList(js.ai_decision_criteria);

  const kd = js.key_details || {};
  const key_details = {
    client_name: asText(kd.client_name),
    company_name: asText(kd.company_name),
    products_discussed: asList(kd.products_discussed).filter(v => ["SSAS", "FIC"].includes(v)),
    timeline: asText(kd.timeline),
    dob: asText(kd.dob),
    ni: asText(kd.ni),
    utr: asText(kd.utr),
    address: asText(kd.address),
    nationality: asText(kd.nationality),
    pension_refs: asText(kd.pension_refs),
    company_details: asText(kd.company_details),
  };
  if (!key_details.products_discussed?.length) {
    const pi = inferProduct(t);
    if (pi) key_details.products_discussed = [pi];
  }

  const ceIn = js.consult_eval || {};
  const ceKeys = [
    "intro","rapport_open","open_question","needs_pain_uncovered",
    "services_explained_clearly","benefits_linked_to_needs","active_listening",
    "clear_responses_or_followup","commitment_requested","next_steps_confirmed",
    "specific_tax_estimate_given","fees_tax_deductible_explained",
    "next_step_specific_date_time","interactive_throughout","quantified_value_roi"
  ];
  const consult_eval = {};
  for (const k of ceKeys) {
    const v = Number(ceIn[k]);
    consult_eval[k] = [0, 0.5, 1].includes(v) ? v : 0;
  }

  let sales_performance_rating = clamp(js.sales_performance_rating, 1, 10, 1);
  if (outcome === "Proceed now" && sales_performance_rating < 8) {
    sales_performance_rating = 8;
  }

  const result = {
    call_type,
    likelihood_to_close,
    outcome,
    objections,
    next_actions,
    materials_to_send,
    ai_decision_criteria,
    key_details,
    sales_performance_rating,
    sales_performance_summary: asText(js.sales_performance_summary, ""),
    score_reasoning: asText(js.score_reasoning, ""),
    increase_likelihood: asText(js.increase_likelihood, ""),
    consult_eval,
  };

  const dpParts = [];
  const pd = ["dob", "ni", "utr", "address", "nationality", "pension_refs", "company_details"];
  if (key_details.client_name) dpParts.push(`Name: ${key_details.client_name}`);
  if (key_details.company_name) dpParts.push(`Company: ${key_details.company_name}`);
  for (const k of pd) {
    if (asText(key_details[k])) {
      const label = k === "ni" ? "NI" : k.replace(/_/g, " ");
      dpParts.push(`${label[0].toUpperCase() + label.slice(1)}: ${key_details[k]}`);
    }
  }
  result.__data_points_captured_text = dpParts.length ? dpParts.join("\n") : "Not mentioned.";

  return result;
}
