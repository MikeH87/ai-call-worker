// index.js
// TLPI AI Call Worker v4.1 (modular + parallel Whisper)

import express from "express";
import { downloadRecording, ensureAudio } from "./ai/transcribe.js";
import { aiAnalyse, getCombinedPrompt } from "./ai/analyse.js";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { updateHubSpotObject, getHubSpotObject, getAssociations } from "./hubspot/hubspot.js";
import { createScorecard } from "./hubspot/scorecard.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

// Small helper: yyyy-mm-dd
function ymd(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// Normalise HubSpot dropdown capitalisation
const normaliseOutcome = (v) => {
  const map = {
    "proceed now": "Proceed now",
    "likely": "Likely",
    "unclear": "Unclear",
    "not now": "Not now",
    "no fit": "No fit",
  };
  return map[(v || "").trim().toLowerCase()] || "";
};

app.post("/process-call", async (req, res) => {
  try {
    const b = req.body || {};
    const props = b.properties || {};
    const callId = props.hs_object_id?.value || props.hs_object_id || b.objectId;
    const recUrl = props.hs_call_recording_url?.value || props.hs_call_recording_url;
    const ts = Number(props.hs_timestamp?.value || props.hs_timestamp || Date.now());
    const typeLabel = props.hs_activity_type?.value || props.hs_activity_type || "Initial Consultation";

    if (!callId || !recUrl) return res.status(400).send("Missing data");
    res.status(200).send("Processing");

    // Background work
    setImmediate(async () => {
      try {
        console.log(`[bg] Downloading: ${recUrl}`);
        const src = await downloadRecording(recUrl, callId);
        const mp3 = await ensureAudio(src, callId);

        // PARALLEL TRANSCRIPTION (uses robust retries inside transcribeFile)
        const seg = Number(process.env.WHISPER_SEGMENT_SECONDS ?? 120); // 2 min chunks by default
        const cc  = Number(process.env.WHISPER_CONCURRENCY ?? 4);       // 4 concurrent uploads by default
        console.log(`[bg] Transcribing in parallel (segment=${seg}s, concurrency=${cc})…`);
        const transcript = await transcribeAudioParallel(mp3, callId, { segmentSeconds: seg, concurrency: cc });

        console.log("[bg] Analysing…");
        const analysis = await aiAnalyse(transcript, typeLabel);
        console.log("[ai] analysis:", analysis);

        // Write back to the Call (Initial Consultation layer fields included)
        const callUpdates = {
          ai_consultation_outcome: normaliseOutcome(analysis.ai_consultation_outcome),
          ai_decision_criteria: analysis.ai_decision_criteria || "",
          ai_key_objections: analysis.ai_key_objections || "",
          ai_consultation_likelihood_to_close: String(analysis.ai_consultation_likelihood_to_close || 0),
          ai_next_steps: analysis.ai_next_steps || "",
          ai_consultation_required_materials: analysis.ai_consultation_required_materials || "",
          ai_product_interest: analysis.ai_product_interest || "",
          ai_data_points_captured: (analysis.ai_data_points_captured || []).join(" • "),
          ai_missing_information: (analysis.ai_missing_information || []).join(" • "),
        };
        await updateHubSpotObject("calls", callId, callUpdates);

        // Get owner + associations
        const callInfo = await getHubSpotObject("calls", callId, ["hubspot_owner_id"]);
        const ownerId = callInfo?.properties?.hubspot_owner_id;
        const contactIds = await getAssociations(callId, "contacts");
        const dealIds = await getAssociations(callId, "deals");
        console.log("[assoc]", { callId, contactIds, dealIds, ownerId });

        // Create the Sales Scorecard (mirror same fields)
        await createScorecard(callUpdates, {
          callId,
          contactIds,
          dealIds,
          ownerId,
          typeLabel,
          timestamp: ts,
        });

        console.log(`✅ Done ${callId}`);
      } catch (err) {
        console.error("❌ Background error:", err);
      }
    });
  } catch (err) {
    console.error("❌ Main error:", err);
    res.status(500).send("Internal error");
  }
});

// ----------------------------------------------------
// DEBUG: See the exact combined prompt (no OpenAI call)
// ----------------------------------------------------
app.post("/debug-prompt", (req, res) => {
  try {
    const { callType = "Initial Consultation", transcript = "(sample transcript here)" } = req.body || {};
    const prompt = getCombinedPrompt(callType, transcript);
    console.log("[debug-prompt]", { callType });
    console.log("----- COMBINED PROMPT START -----\n" + prompt + "\n----- COMBINED PROMPT END -----");
    res.status(200).json({ callType, prompt });
  } catch (e) {
    console.error("debug-prompt error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`AI Call Worker v4.1 modular+parallel running on :${PORT}`));
