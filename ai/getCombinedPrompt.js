// ai/getCombinedPrompt.js
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");          // /ai
const PROMPTS_DIR = path.resolve(ROOT, "prompts");   // /prompts

async function safeRead(relPath) {
  try {
    const p = path.resolve(PROMPTS_DIR, relPath);
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * getCombinedPrompt(callType, transcript) -> messages[]
 * Returns an array of OpenAI chat messages [{role, content}, ...]
 * Loads:
 *  - prompts/company-info.md
 *  - prompts/<call-type>.md  (e.g. initial-consultation.md)
 *  - prompts/sales-performance-summary.md    (optional)
 *  - prompts/sales-performance-rating.md     (optional)
 * Then appends the raw transcript as a user message.
 */
export async function getCombinedPrompt(callType, transcript) {
  const type = String(callType || "").trim().toLowerCase();
  // Map typical labels to file names
  const typeToFile = {
    "qualification call": "qualification.md",
    "qualification": "qualification.md",
    "initial consultation": "initial-consultation.md",
    "initial-consultation": "initial-consultation.md",
    "follow up call": "follow-up.md",
    "follow-up": "follow-up.md",
    "follow up": "follow-up.md",
    "application meeting": "application-meeting.md",
    "application": "application-meeting.md",
    "existing customer call": "initial-consultation.md", // sensible default
    "strategy call": "initial-consultation.md",
    "annual review": "initial-consultation.md",
    "": "initial-consultation.md",
  };

  const company = await safeRead("company-info.md");
  const callSpecific = await safeRead(typeToFile[type] || "initial-consultation.md");
  const perfSummary = await safeRead("sales-performance-summary.md"); // optional
  const perfRating  = await safeRead("sales-performance-rating.md");  // optional

  const messages = [];

  if (company) messages.push({ role: "system", content: company });
  if (callSpecific) messages.push({ role: "system", content: callSpecific });
  if (perfSummary) messages.push({ role: "system", content: perfSummary });
  if (perfRating)  messages.push({ role: "system", content: perfRating });

  messages.push({ role: "user", content: String(transcript || "").trim() });

  return messages;
}
