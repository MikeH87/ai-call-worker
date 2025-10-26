// file: index.js
import express from "express";
import { transcribeAudioParallel } from "./ai/parallelTranscribe.js";
import { analyseTranscript } from "./ai/analyse.js";
import {
  getCallRecordingMeta,
  getCallAssociations,
  updateCall,
  createScorecard,
  associateScorecard,
  hasHubSpotToken,
  tokenSource,
} from "./hubspot/hubspot.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ------------------ helpers ------------------ */

function pickRecordingUrlFromWebhook(body) {
  const url =
    body?.recordingUrl ||
    body?.hs_call_video_recording_url ||
    body?.hs_call_recording_url ||
    "";
  return typeof url === "string" ? url : "";
}

function normaliseList(val) {
  if (!val) return "";
  if (Array.isArray(val)) return val.filter(Boolean).join("; ");
  return String(val);
}

function toBullets(val) {
  if (!val) return "";
  if (Array.isArray(val)) return val.filter(Boolean).join(" • ");
  return String(val);
}

// Clamp 1..10 ints
function clampTen(n) {
  const x = Math.round(Number(n) || 0);
  if (x < 1) return 1;
  if (x > 10) return 10;
  return x;
}

/* ------------------ routes ------------------ */

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ai-call-worker" });
});

app.get("/_debug/env", (_req, res) => {
  res.json({
    ok: true,
    tokenSource: tokenSource(),
    hasHubSpotToken: hasHubSpotToken(),
    node: process.version,
    now: Date.now(),
  });
});

/**
 * POST /process-call
 * Body (either webhook or manual):
 * {
 *   callId: "123",
 *   recordingUrl?: "https://..",
 *   chunkSeconds?: 60,
 *   concurrency?: 2
 * }
 */
app.post("/process-call", async (req, res) => {
  const callId = req.body?.callId || req.body?.hs_object_id;
  let recordingUrl = pickRecordingUrlFromWebhook(req.body);

  if (!callId) {
    return res.status(400).json({ ok: false, error: "callId is required" });
  }

  // Recording URL fallback: fetch from HubSpot Call if webhook omitted it
  if (!recordingUrl) {
    console.log("[info] recordingUrl missing in webhook — fetching from HubSpot Call…");
    try {
      const meta = await getCallRecordingMeta(callId);
      recordingUrl = meta.recordingUrl || "";
      if (recordingUrl) {
        console.log("[info] Found recording URL on Call.");
      }
    } catch (err) {
      console.warn("[warn] Could not fetch call to find recording URL:", err.message);
    }
  }

  if (!recordingUrl) {
    console.warn("[warn] Missing callId or recordingUrl", {
      callIdPresent: !!callId,
      recordingUrlPresent: !!recordingUrl,
    });
    return res.status(400).json({ ok: false, error: "callId and recordingUrl are required" });
  }

  res.json({ ok: true, callId });

  // Background pipeline
  try {
    // 1) Transcribe
    console.log(`[bg] Downloading audio to /tmp/ai-call-worker/${callId}.mp3`);
    const chunkSeconds = Number(req.body?.chunkSeconds) || 120;
    const concurrency = Number(req.body?.concurrency) || 4;
    console.log(
      `[bg] Transcribing in parallel… (segment=${chunkSeconds}s, concurrency=${concurrency})`
    );

    const transcript = await transcribeAudioParallel({
      url: recordingUrl,
      outPath: `/tmp/ai-call-worker/${callId}.mp3`,
      chunkSeconds,
      concurrency,
    });

    // 2) Analyse
    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(transcript);
    console.log("[ai] analysis:", analysis);

    // if transcript is empty/meaningless, we still bail early (you asked for a failsafe)
    if (analysis?.uncertainty_reason === "Transcript contains no meaningful content.") {
      console.log("✅ Done", callId);
      return;
    }

    // 3) Associations for this call
    const assoc = await getCallAssociations(callId);
    console.log("[assoc]", {
      callId,
      contactIds: assoc.contactIds,
      dealIds: assoc.dealIds,
      ownerId: assoc.ownerId,
    });

    /* 4) Update Call properties */
    const callProps = {};

    // From your “Initial Consultation” spec:
    callProps.ai_inferred_call_type = analysis.call_type || "Initial Consultation";
    callProps.ai_call_type_confidence = String(analysis?.ai_confidence || 90);

    callProps.ai_consultation_outcome = analysis?.outcome || "Unclear";
    callProps.ai_product_interest = analysis?.key_details?.products_discussed?.[0] || "";

    // Decision criteria
    callProps.ai_decision_criteria = normaliseList(analysis?.ai_decision_criteria);

    // Data points captured
    callProps.ai_data_points_captured =
      analysis?.__data_points_captured_text ||
      "Nothing captured.";

    // Missing info + Next steps
    callProps.ai_missing_information =
      analysis?.missing_information || "Nothing requested or all information provided.";
    callProps.ai_next_steps =
      normaliseList(analysis?.next_actions) ||
      "No next steps recorded.";

    // Objections (concise / bullets / severity / primary)
    callProps.ai_key_objections =
      normaliseList(analysis?.objections) || "No objections";
    callProps.ai_objections_bullets =
      toBullets(analysis?.objections) || "No objections";
    callProps.ai_objection_severity = analysis?.objection_severity || "Medium";
    callProps.ai_primary_objection =
      analysis?.primary_objection || (analysis?.objections?.[0] || "No objection");
    callProps.ai_objection_categories =
      analysis?.objection_category || "Clarity";

    // Customer sentiment / engagement (if you emit these)
    if (analysis?.sentiment) callProps.ai_customer_sentiment = analysis.sentiment;
    if (typeof analysis?.engagement_level === "number") {
      callProps.ai_client_engagement_level = String(analysis.engagement_level);
    }

    // Consultation likelihood (1..10), score reasoning, “increase likelihood” suggestions
    if (typeof analysis?.likelihood_to_close === "number") {
      callProps.ai_consultation_likelihood_to_close = String(
        clampTen(analysis.likelihood_to_close / 10)
      );
    }
    callProps.chat_gpt___score_reasoning =
      analysis?.score_reasoning || "No specific reasoning extracted.";
    callProps.chat_gpt___increase_likelihood_of_sale_suggestions =
      normaliseList(analysis?.increase_likelihood) ||
      "No suggestions.";

    // Sales performance summary on the call (duplicate for convenience)
    callProps.sales_performance_summary =
      analysis?.sales_performance_summary || "";

    // Requested materials (if any)
    callProps.ai_consultation_required_materials =
      normaliseList(analysis?.materials_to_send) || "Nothing requested";

    // Write to Call
    try {
      const up = await updateCall(callId, callProps);
      console.log("[debug] Call updated:", {
        ...Object.fromEntries(
          Object.entries(callProps).map(([k, v]) => [k, v])
        ),
        hs_object_id: up?.id || callId,
      });
    } catch (err) {
      console.warn("[HubSpot] PATCH /calls failed:", err.message);
    }

    /* 5) Create Scorecard */
    // (Weights are now in your analyse pipeline; consult_eval has 0/0.5/1 flags you already send)
    const scProps = {
      activity_type: "Initial Consultation",
      activity_name: `${callId} — Initial Consultation — ${new Date()
        .toISOString()
        .slice(0, 10)}`,

      // Copy the deterministic “AI Sales Performance Rating (new)”
      sales_performance_rating_: clampTen(analysis?.sales_performance_rating || 1),

      // Copy performance summary for the consultant
      sales_scorecard___what_you_can_improve_on:
        analysis?.sales_performance_summary ||
        "No coaching notes.",

      // Copy core mirrored AI fields
      ai_consultation_likelihood_to_close:
        String(clampTen(analysis?.likelihood_to_close / 10 || 0)) || "5",
      ai_consultation_outcome: analysis?.outcome || "Unclear",
      ai_consultation_required_materials:
        normaliseList(analysis?.materials_to_send) || "Nothing requested",
      ai_decision_criteria: normaliseList(analysis?.ai_decision_criteria),
      ai_key_objections: normaliseList(analysis?.objections) || "No objections",
      ai_next_steps:
        normaliseList(analysis?.next_actions) || "No next steps recorded",

      // 20 × consult_* flags mapped from consult_eval (0/0.5/1)
      // Your analyser already populates these; default to 0 to be safe.
      consult_customer_agreed_to_set_up:
        Number(analysis?.consult_eval?.commitment_requested > 0.5 ? 1 : 0),
      consult_overcame_objection_and_closed:
        Number(analysis?.consult_eval?.overcame_objection_and_closed ? 1 : 0),
      consult_next_step_specific_date_time:
        Number(analysis?.consult_eval?.next_step_specific_date_time || 0),
      consult_closing_question_asked:
        Number(analysis?.consult_eval?.closing_question_asked || 0),
      consult_prospect_asked_next_steps:
        Number(analysis?.consult_eval?.prospect_asked_next_steps || 0),
      consult_strong_buying_signals_detected:
        Number(analysis?.consult_eval?.strong_buying_signals_detected || 0),
      consult_needs_pain_uncovered:
        Number(analysis?.consult_eval?.needs_pain_uncovered || 0),
      consult_purpose_clearly_stated:
        Number(analysis?.consult_eval?.purpose_clearly_stated || 0),
      consult_quantified_value_roi:
        Number(analysis?.consult_eval?.quantified_value_roi || 0),
      consult_demo_tax_saving:
        Number(analysis?.consult_eval?.demo_tax_saving || 0),
      consult_fees_tax_deductible_explained:
        Number(analysis?.consult_eval?.fees_tax_deductible_explained || 0),
      consult_fees_annualised:
        Number(analysis?.consult_eval?.fees_annualised || 0),
      consult_fee_phrasing_three_seven_five:
        Number(analysis?.consult_eval?.fee_phrasing_three_seven_five || 0),
      consult_specific_tax_estimate_given:
        Number(analysis?.consult_eval?.specific_tax_estimate_given || 0),
      consult_confirm_reason_for_zoom:
        Number(analysis?.consult_eval?.confirm_reason_for_zoom || 0),
      consult_rapport_open:
        Number(analysis?.consult_eval?.rapport_open || 0),
      consult_interactive_throughout:
        Number(analysis?.consult_eval?.interactive_throughout || 0),
      consult_next_contact_within_5_days:
        Number(analysis?.consult_eval?.next_contact_within_5_days || 0),
      consult_no_assumptions_evidence_gathered:
        Number(analysis?.consult_eval?.no_assumptions_evidence_gathered || 0),
      consult_collected_dob_nin_when_agreed:
        Number(analysis?.consult_eval?.collected_dob_nin_when_agreed || 0),

      // final score (1–10) — your analyser already computes weights; we trust its value
      consult_score_final: Number(
        analysis?.consult_eval?.final_weighted_score || 0
      ),
    };

    // Owner on scorecard = call owner (if present)
    if (assoc.ownerId) {
      scProps.hubspot_owner_id = String(assoc.ownerId);
    }

    let scorecardId = null;
    try {
      scorecardId = await createScorecard(scProps);
      if (scorecardId) {
        console.log("[scorecard] created id:", scorecardId);
      }
    } catch (err) {
      console.warn("[HubSpot] create scorecard failed:", err.message);
    }

    // 6) Associate scorecard
    if (scorecardId) {
      try {
        await associateScorecard({
          scorecardId,
          callId,
          contactId: assoc.contactIds?.[0] || null,
          dealId: assoc.dealIds?.[0] || null,
        });
        console.log(
          `[assoc] Linked scorecard:${scorecardId} to call:${callId} (and contact/deal if present).`
        );
      } catch (err) {
        console.warn("[assoc] association failed:", err.message);
      }
    }

    console.log("✅ Done", callId);
  } catch (err) {
    console.error("❌ Background error:", err);
  }
});

/* ------------------ boot ------------------ */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`==> Listening on ${PORT}`);
});
