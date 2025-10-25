// ai/getCombinedPrompt.js
// Purpose: Build the final analysis prompt by combining the shared company context
// (prompts/company-info.md) with the call-type specific prompt (one of the 4 files).
//
// Used by: the /debug-prompt endpoint and (optionally) analysis flows that need a
// fully-assembled prompt.
// Updates: This function does NOT write to HubSpot itself; it only returns text.
//
// Files referenced:
//   prompts/company-info.md
//   prompts/qualification.md
//   prompts/initial-consultation.md
//   prompts/follow-up.md
//   prompts/application-meeting.md
//
// If you update context about TLPI, products (SSAS/FIC), definitions of call types,
// or rubric details—edit the markdown files in /prompts (not this code).

import fs from "fs/promises";
import path from "path";

/** Read a file safely; if it doesn't exist, return empty string */
async function readIfExists(absPath) {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

/** Map HubSpot call-type label to a prompt file name */
function promptFileForType(callType) {
  const t = String(callType || "").toLowerCase();
  if (t.includes("qualification")) return "qualification.md";
  if (t.includes("initial")) return "initial-consultation.md";
  if (t.includes("follow")) return "follow-up.md";
  if (t.includes("application")) return "application-meeting.md";
  // Fallback to initial consultation prompt if unknown (safest for sales)
  return "initial-consultation.md";
}

/**
 * Return a combined prompt string:
 *   [Company info/context]
 *   ---
 *   [Call-type specific instructions]
 *   ---
 *   [Transcript injected at the end]
 */
export async function getCombinedPrompt(callType, transcript) {
  const cwd = process.cwd();

  const companyInfoPath = path.resolve(cwd, "prompts", "company-info.md");
  const typeFile = promptFileForType(callType);
  const typePath = path.resolve(cwd, "prompts", typeFile);

  const companyInfo = (await readIfExists(companyInfoPath)).trim();
  const typeBlock = (await readIfExists(typePath)).trim();

  const header = companyInfo
    ? `# Company & Product Context\n${companyInfo}\n`
    : `# Company & Product Context\n(No company-info.md found — please add prompts/company-info.md)\n`;

  const typeSection = typeBlock
    ? `# Call-Type Instructions (${callType || "Unknown"})\n${typeBlock}\n`
    : `# Call-Type Instructions (${callType || "Unknown"})\n(No ${typeFile} found — please add prompts/${typeFile})\n`;

  const transcriptSection = `# Transcript\n${transcript || "(No transcript provided)"}\n`;

  return `${header}\n---\n${typeSection}\n---\n${transcriptSection}`;
}
