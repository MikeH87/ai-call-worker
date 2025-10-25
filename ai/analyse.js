// ai/analyse.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import { getCombinedPrompt } from "./getCombinedPrompt.js";

dotenv.config();
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_TOKEN;
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

function oaiHeaders(){ return { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }; }

// Transcribe already done elsewhere (parallelTranscribe). This file analyses a given transcript.
export async function analyseTranscript(callTypeLabel, transcript) {
  const callType = (callTypeLabel || "Initial Consultation").toString();

  // 1) Sales performance rating (1–10) using editable prompt file
  const ratingPrompt = await readPromptFile("prompts/sales-performance-rating.md");
  const perfRating = await callJSON("gpt-4o-mini", [
    { role: "system", content: "Return ONLY an integer 1..10. No extra words." },
    { role: "user", content: ratingPrompt + "\n\nTRANSCRIPT:\n" + transcript.slice(0, 20000) }
  ], { response_format: { type: "json_schema", json_schema: { name:"rating", schema:{ type:"object", properties:{ score:{ type:"integer", minimum:1, maximum:10 } }, required:["score"], additionalProperties:false } } } }).then(r => r?.score).catch(() => null);

  // 2) Coaching summary text (editable prompt)
  const summaryPrompt = await readPromptFile("prompts/sales-performance-summary.md");
  const perfSummary = await callText("gpt-4o-mini", [
    { role: "system", content: "Return plain text only." },
    { role: "user", content: summaryPrompt + "\n\nTRANSCRIPT:\n" + transcript.slice(0, 20000) }
  ]).catch(() => "");

  // 3) Structured consult metrics (10 rubric 0/0.5/1, 5 ops 0 or 10)
  const metricsSchema = {
    name: "consult_metrics",
    schema: {
      type:"object",
      properties:{
        // rubric 0/0.5/1
        intro:{type:"number"}, rapport_open:{type:"number"}, open_question:{type:"number"},
        needs_pain_uncovered:{type:"number"}, services_explained_clearly:{type:"number"},
        benefits_linked_to_needs:{type:"number"}, active_listening:{type:"number"},
        clear_responses_or_followup:{type:"number"}, commitment_requested:{type:"number"},
        next_steps_confirmed:{type:"number"},
        // ops 0 or 10
        specific_tax_estimate_given:{type:"number"}, fees_tax_deductible_explained:{type:"number"},
        next_step_specific_date_time:{type:"number"}, interactive_throughout:{type:"number"},
        quantified_value_roi:{type:"number"},
      },
      required: [],
      additionalProperties:false
    }
  };

  const metricsPrompt =
`Score the Initial Consultation using:
- For the 10 rubric items: use 0, 0.5, or 1 ONLY (see rubric below).
- For the 5 operational items: use 0 or 10 ONLY.

Rubric (0/0.5/1 each):
1) intro; 2) rapport_open; 3) open_question; 4) needs_pain_uncovered; 5) services_explained_clearly;
6) benefits_linked_to_needs; 7) active_listening; 8) clear_responses_or_followup; 9) commitment_requested; 10) next_steps_confirmed.

Operational (0 or 10 each):
- specific_tax_estimate_given; fees_tax_deductible_explained; next_step_specific_date_time; interactive_throughout; quantified_value_roi.

Be conservative: if unclear, score 0.`;

  const consultMetrics = await callJSON("gpt-4o-mini", [
    { role: "system", content: "Return only the JSON schema." },
    { role: "user", content: metricsPrompt + "\n\nTRANSCRIPT:\n" + transcript.slice(0, 20000) }
  ], { response_format: { type:"json_schema", json_schema: metricsSchema } }).catch(() => ({}));

  // 4) TLPI combined analysis for other fields (existing)
  const combinedPrompt = await getCombinedPrompt(callType, transcript);
  const other = await callJSON("gpt-4o-mini", [
    { role: "system", content: "You are TLPI’s AI Call Analyst. Return a concise JSON object only." },
    { role: "user", content: combinedPrompt }
  ], {
    response_format: { type: "json_schema", json_schema: {
      name:"analysis",
      schema:{
        type:"object",
        properties:{
          call_type:{type:"string"},
          summary:{type:"array", items:{type:"string"}},
          likelihood_to_close:{type:["number","null"]},
          outcome:{type:"string"},
          objections:{type:"array", items:{type:"string"}},
          next_actions:{type:"array", items:{type:"string"}},
          materials_to_send:{type:"array", items:{type:"string"}},
          key_details:{type:"object", properties:{
            client_name:{type:["string","null"]},
            company_name:{type:["string","null"]},
            products_discussed:{type:"array", items:{type:"string"}},
            timeline:{type:["string","null"]}
          }},
          ai_missing_information:{type:["string","array","null"]},
          ai_decision_criteria:{type:["string","array","null"]},
          ai_customer_sentiment:{type:["string","null"]}
        },
        required:["call_type","summary","outcome","objections","next_actions","materials_to_send","key_details"]
      }
    } }
  }).catch(() => ({}));

  // Merge
  const analysis = {
    ...other,
    sales_performance_rating: perfRating ?? null,
    sales_performance_summary: perfSummary || null,
    consult_eval: {
      intro: n01(consultMetrics.intro),
      rapport_open: n01(consultMetrics.rapport_open),
      open_question: n01(consultMetrics.open_question),
      needs_pain_uncovered: n01(consultMetrics.needs_pain_uncovered),
      services_explained_clearly: n01(consultMetrics.services_explained_clearly),
      benefits_linked_to_needs: n01(consultMetrics.benefits_linked_to_needs),
      active_listening: n01(consultMetrics.active_listening),
      clear_responses_or_followup: n01(consultMetrics.clear_responses_or_followup),
      commitment_requested: n01(consultMetrics.commitment_requested),
      next_steps_confirmed: n01(consultMetrics.next_steps_confirmed),
      // ops (0 or 10 as provided)
      specific_tax_estimate_given: z10(consultMetrics.specific_tax_estimate_given),
      fees_tax_deductible_explained: z10(consultMetrics.fees_tax_deductible_explained),
      next_step_specific_date_time: z10(consultMetrics.next_step_specific_date_time),
      interactive_throughout: z10(consultMetrics.interactive_throughout),
      quantified_value_roi: z10(consultMetrics.quantified_value_roi),
    }
  };

  return analysis;
}

/* ================== helpers ================== */
function n01(v){ const n = Number(v); if (!Number.isFinite(n)) return undefined; if (n===0||n===0.5||n===1) return n; return undefined; }
function z10(v){ const n = Number(v); if (!Number.isFinite(n)) return undefined; if (n===0||n===10) return n; return undefined; }

async function callText(model, messages){
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method:"POST", headers:oaiHeaders(),
    body: JSON.stringify({ model, messages, temperature:0 })
  });
  const js = await res.json();
  const txt = js?.choices?.[0]?.message?.content || "";
  return txt.trim();
}

async function callJSON(model, messages, extra={}){
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method:"POST", headers:oaiHeaders(),
    body: JSON.stringify({ model, messages, temperature:0, ...extra })
  });
  const js = await res.json();
  try { return JSON.parse(js?.choices?.[0]?.message?.content || "{}"); }
  catch { return null; }
}

async function readPromptFile(path){
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch { return ""; }
}
