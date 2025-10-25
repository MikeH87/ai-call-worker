// ai/getCombinedPrompt.js
import fs from "fs/promises";
import path from "path";

// Map HubSpot/Call labels to prompt files
const CALL_TYPE_TO_FILE = {
  "Qualification Call": "qualification.md",
  "Initial Consultation": "initial-consultation.md",
  "Follow-up Call": "follow-up.md",
  "Application Meeting": "application-meeting.md",
  // Fallbacks
  Qualification: "qualification.md",
  "Initial Consultation Call": "initial-consultation.md",
  "Follow Up": "follow-up.md",
};

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

async function safeRead(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function normaliseType(label = "") {
  const keys = Object.keys(CALL_TYPE_TO_FILE);
  for (const k of keys) {
    if (label.toLowerCase().includes(k.toLowerCase())) return CALL_TYPE_TO_FILE[k];
  }
  return null;
}

export async function getCombinedPrompt(callTypeLabel = "Unknown", transcript = "") {
  const company = await safeRead(path.join(PROMPTS_DIR, "company-info.md"));
  const typeFile =
    normaliseType(callTypeLabel) || "qualification.md"; // default sensible baseline

  const callTypeMd = await safeRead(path.join(PROMPTS_DIR, typeFile));

  const system = [
    "You are TLPI’s AI Call Analyst.",
    "Analyse sales calls for SSAS Pensions and Family Investment Companies (FIC).",
    "Output MUST be compact JSON only — no extra prose.",
    "Be conservative and evidence-based; if unsure, mark fields as null and include 'uncertainty_reason'.",
  ].join(" ");

  const user = `
# COMPANY CONTEXT
${company || "_(company-info.md missing — using defaults)_"}

# CALL TYPE CONTEXT
(${callTypeLabel})
${callTypeMd || "_(call-type file missing — using generic guidance)_"}

# OUTPUT SHAPE (STRICT)
Return JSON with:
{
  "call_type": "<detected>",
  "summary": "<3-6 bullet sentences>",
  "likelihood_to_close": 0..100,
  "outcome": "Positive|Negative|Neutral",
  "objections": ["..."],
  "next_actions": ["..."],
  "materials_to_send": ["..."],
  "key_details": {
     "client_name": "<if known>",
     "company_name": "<if known>",
     "products_discussed": ["SSAS","FIC", "..."],
     "timeline": "<eg within 7 days>"
  },
  "scorecard": {
     "problem_fit": 0..5,
     "budget_fit": 0..5,
     "authority": 0..5,
     "urgency": 0..5,
     "overall": 0..5
  }
}

# TRANSCRIPT
${transcript}
`.trim();

  return { system, user };
}
