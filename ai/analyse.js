// ai/analyse.js — v2.1 deterministic
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ----------------- helpers ----------------- */
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
  if (Array.isArray(v)) return v.map((x) => asText(x)).filter(Boolean);
  const s = asText(v);
  if (!s) return [];
  return s.split(/[\n,;•|-]+/).map((t) => t.trim()).filter(Boolean);
};
const uniq = (arr) => {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = x.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
};
const stableSort = (arr) => [...arr].sort((a, b) => a.localeCompare(b));
const roundToNearest = (n, step = 10) => Math.round(n / step) * step;

const OUTCOME_ALLOWED = ["Proceed now", "Likely", "Unclear", "Not now", "No fit"];

function normaliseOutcome(s) {
  const t = asText(s).toLowerCase();
  if (!t) return "Unclear";
  if (/(proceed|sign(ed)?|go ahead|agreed|commit(ed)?)/.test(t)) return "Proceed now";
  if (/(likely|positive|leaning|keen|interested)/.test(t)) return "Likely";
  if (/(not\s+now|pause|later|defer)/.test(t)) return "Not now";
  if (/(no\s+fit|not\s+interested|decline)/.test(t)) return "No fit";
  return "Unclear";
}

function inferProduct(transcript) {
  const t = transcript.toLowerCase();
  const hasSSAS = /\bssas\b/.test(t);
  const hasFIC  = /\bfic\b|family investment compan(y|ies)/.test(t);
  if (hasSSAS && hasFIC) return "Both";
  if (hasSSAS) return "SSAS";
  if (hasFIC)  return "FIC";
  return "";
}

function requireOpenAI() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
}

/* ----------------- OpenAI call ----------------- */
async function callOpenAI_JSON(prompt, transcript) {
  requireOpenAI();

  const sys = [
    "You are TLPI’s AI Call Analyst.",
    "Analyse **Initial Consultation** calls only and return STRICT JSON.",
    "Determinism rules:",
    "- Use only the provided transcript; never invent data.",
    "- When unsure, leave fields empty ('', []) rather than guessing.",
    "- Apply consistent tie-breaks: prefer fewer, clearer bullets; prefer stable ordering (alphabetical).",
    "- If a field is absent, output '' or [] as appropriate.",
  ].join(" ");

  const user = [
    "COMPANY CONTEXT:",
    "- TLPI helps UK company directors with SSAS pensions or Family Investment Companies (FIC).",
    "- Objective of Initial Consultation: explain benefits, surface objections, agree concrete next steps, ideally gain agreement to sign the client agreement (‘Proceed now’).",
    "",
    "RULES:",
    "- 'Proceed now' ONLY if there is explicit commitment (e.g., agree to sign, go ahead).",
    "- If explicit commitment is clear: sales_performance_rating >= 8.",
    "- Use UK English, be concise.",
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
    temperature: 0,
    top_p: 1,
    seed: 12345, // fixed seed for repeatability
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "{}";

  try {
    return JSON.parse(text);
  } catch {
    // one retry ultra-strict
    const retry = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content:
              user +
              "\nReturn ONLY a valid JSON object. Do not include commentary or code fences.",
          },
        ],
      }),
    });
    const d2 = await retry.json();
    const t2 = d2?.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(t2);
  }
}

/* ----------------- Master prompt (Initial Consultation) ----------------- */
const PROMPT_INITIAL_CONSULTATION = `
Return JSON with these keys:
- call_type: string ("Initial Consultation")
- likelihood_to_close: number (0-100, integer)
- outcome: string (one of: Proceed now, Likely, Unclear, Not now, No fit)
- objections: string[] (short labels like "Fees/cost")
- next_actions: string[] (concrete, ordered)
- materials_to_send: string[] (e.g. "Client Agreement", "Fee schedule")
- ai_decision_criteria: string[] (e.g. "Fees/Cost", "Timeline/Speed")
- key_details: object with keys:
    client_name?: string
    company_name?: string
    products_discussed?: string[] (subset of ["SSAS","FIC"])
    timeline?: string
    dob?: string
    ni?: string
    utr?: string
    address?: string
    nationality?: string
    pension_refs?: string
    company_details?: string
- sales_performance_rating: number (1-10)
- sales_performance_summary: string (<=4 bullets, plain text; "What went well"/"Areas to improve")
- score_reasoning: string (why likelihood_to_close is what it is, short)
- increase_likelihood: string (3 bullets, terse)
- consult_eval: object with keys set to 0, 0.5 or 1:
    intro, rapport_open, open_question, needs_pain_uncovered,
    services_explained_clearly, benefits_linked_to_needs, active_listening,
    clear_responses_or_followup, commitment_requested, next_steps_confirmed,
    specific_tax_estimate_given, fees_tax_deductible_explained,
    next_step_specific_date_time, interactive_throughout, quantified_value_roi
Rules:
- If the client explicitly agrees to proceed/sign on the call, set outcome="Proceed now" and sales_performance_rating>=8.
- If information is not present, use "" or [] (not "N/A").
- Prefer stable, concise phrasing; avoid redundancy.
`;

/* ----------------- analyseTranscript ----------------- */
export async function analyseTranscript(callTypeLabel, transcript) {
  // 1) Basic sanity on transcript
  const t = asText(transcript);
  if (t.length < 24 || /no (audio|sound)|silence|silent/i.test(t)) {
    return {
      call_type: "Initial Consultation",
      likelihood_to_close: 0,
      outcome: "Unclear",
      objections: [],
      next_actions: [],
      materials_to_send: [],
      key_details: {},
      ai_decision_criteria: [],
      sales_performance_rating: 1,
      sales_performance_summary:
        "What went well:\n- N/A\n\nAreas to improve:\n- Call contained no meaningful audio.",
      score_reasoning: "Transcript empty/inaudible.",
      increase_likelihood:
        "- Reschedule a proper consultation\n- Ensure clear agenda\n- Confirm next steps",
      consult_eval: {},
      uncertainty_reason: "Transcript contains no meaningful content.",
    };
  }

  // 2) OpenAI
  let js = await callOpenAI_JSON(PROMPT_INITIAL_CONSULTATION, t);

  // 3) Normalise + safe defaults + determinism
  const call_type = "Initial Consultation";

  // Likelihood: clamp then round to nearest 10 to reduce jitter
  let likelihood_to_close = clamp(js.likelihood_to_close, 0, 100, 0) ?? 0;
  likelihood_to_close = roundToNearest(likelihood_to_close, 10);

  let outcome = normaliseOutcome(js.outcome);

  // Arrays -> canonicalize: trim, dedupe (case-insensitive), stable sort
  let objections = uniq(asList(js.objections));
  objections = stableSort(objections);

  let next_actions = uniq(asList(js.next_actions));
  next_actions = stableSort(next_actions);

  let materials_to_send = uniq(asList(js.materials_to_send));
  materials_to_send = stableSort(materials_to_send);

  let ai_decision_criteria = uniq(asList(js.ai_decision_criteria));
  ai_decision_criteria = stableSort(ai_decision_criteria);

  // key details
  const kd = js.key_details || {};
  const key_details = {
    client_name: asText(kd.client_name, ""),
    company_name: asText(kd.company_name, ""),
    products_discussed: uniq(asList(kd.products_discussed)).filter((v) =>
      ["SSAS", "FIC"].includes(v)
    ),
    timeline: asText(kd.timeline, ""),
    dob: asText(kd.dob, ""),
    ni: asText(kd.ni, ""),
    utr: asText(kd.utr, ""),
    address: asText(kd.address, ""),
    nationality: asText(kd.nationality, ""),
    pension_refs: asText(kd.pension_refs, ""),
    company_details: asText(kd.company_details, ""),
  };

  // product fallback from transcript
  if (!key_details.products_discussed?.length) {
    const pi = inferProduct(t);
    if (pi === "Both") key_details.products_discussed = ["SSAS", "FIC"];
    else if (pi) key_details.products_discussed = [pi];
  }

  // consult_eval → keep only expected keys, force values to 0/0.5/1
  const ceIn = js.consult_eval || {};
  const ceKeys = [
    "intro",
    "rapport_open",
    "open_question",
    "needs_pain_uncovered",
    "services_explained_clearly",
    "benefits_linked_to_needs",
    "active_listening",
    "clear_responses_or_followup",
    "commitment_requested",
    "next_steps_confirmed",
    "specific_tax_estimate_given",
    "fees_tax_deductible_explained",
    "next_step_specific_date_time",
    "interactive_throughout",
    "quantified_value_roi",
  ];
  const consult_eval = {};
  for (const k of ceKeys) {
    const v = Number(ceIn[k]);
    consult_eval[k] = [0, 0.5, 1].includes(v) ? v : 0;
  }

  // sales performance rating
  let sales_performance_rating =
    clamp(js.sales_performance_rating, 1, 10, 1) ?? 1;

  // Enforce deterministic links between outcome & likelihood/rating
  const explicitCommitment =
    outcome === "Proceed now" ||
    /agree(d)?\s+to\s+(proceed|sign|go ahead)|we\s+will\s+sign/i.test(t);

  if (explicitCommitment) {
    outcome = "Proceed now";
    if (likelihood_to_close < 80) likelihood_to_close = 80;
    if (sales_performance_rating < 8) sales_performance_rating = 8;
  } else {
    // If no commitment language, don't allow "Proceed now"
    if (outcome === "Proceed now") outcome = "Likely";
  }

  // Stable text fields
  const sales_performance_summary = asText(js.sales_performance_summary, "");
  const score_reasoning = asText(js.score_reasoning, "");
  const increase_likelihood = asText(js.increase_likelihood, "");

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
    sales_performance_summary,
    score_reasoning,
    increase_likelihood,
    consult_eval,
  };

  // Compact personal-data summary for the call field
  const dpParts = [];
  const pd = [
    "dob",
    "ni",
    "utr",
    "address",
    "nationality",
    "pension_refs",
    "company_details",
  ];
  if (key_details.client_name) dpParts.push(`Name: ${key_details.client_name}`);
  if (key_details.company_name)
    dpParts.push(`Company: ${key_details.company_name}`);
  for (const k of pd) {
    const v = asText(key_details[k]);
    if (v) {
      const label = k === "ni" ? "NI" : k.replace(/_/g, " ");
      dpParts.push(`${label[0].toUpperCase() + label.slice(1)}: ${v}`);
    }
  }
  result.__data_points_captured_text = dpParts.length
    ? dpParts.join("\n")
    : "Not mentioned.";

  return result;
}
