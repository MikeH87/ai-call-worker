app.post("/process-call", async (req, res) => {
  // --- helpers local to this route ---
  const isObject = (v) => v && typeof v === "object";
  const looksLikeId = (v) => {
    if (v == null) return false;
    const s = String(v).trim();
    // HubSpot IDs are numeric strings, but be generous:
    return /^[0-9]+$/.test(s) || /^[0-9A-Za-z\-]+$/.test(s);
  };

  // Deep search for a field that looks like an object id
  function deepFindId(obj) {
    const stack = [obj];
    const idKeys = [
      "callId",
      "hs_object_id",
      "objectId",
      "object_id",
      "id",
      // common locations:
      "properties.hs_object_id",
      "object.objectId",
      "input.objectId",
      "event.objectId",
    ];

    // direct tries first
    for (const k of idKeys) {
      const parts = k.split(".");
      let cur = obj;
      let ok = true;
      for (const p of parts) {
        if (!isObject(cur) || !(p in cur)) {
          ok = false;
          break;
        }
        cur = cur[p];
      }
      if (ok && looksLikeId(cur)) return String(cur);
    }

    // fallback: scan all keys depth-first and pick the first value that
    // looks like an ID when key name contains "id"
    while (stack.length) {
      const cur = stack.pop();
      if (!isObject(cur)) continue;

      for (const [k, v] of Object.entries(cur)) {
        if (k.toLowerCase().includes("id") && looksLikeId(v)) {
          return String(v);
        }
        if (isObject(v)) stack.push(v);
      }
    }
    return "";
  }

  // Extract recording URL from common fields
  function findRecordingUrl(body) {
    const direct =
      body?.recordingUrl ||
      body?.hs_call_video_recording_url ||
      body?.hs_call_recording_url ||
      "";

    if (typeof direct === "string" && direct.trim()) return direct.trim();

    // try common nested paths
    const nestedCandidates = [
      body?.properties?.hs_call_video_recording_url,
      body?.properties?.hs_call_recording_url,
      body?.object?.properties?.hs_call_video_recording_url,
      body?.object?.properties?.hs_call_recording_url,
    ].filter(Boolean);

    for (const c of nestedCandidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return "";
  }

  // ---- START OF ROUTE LOGIC ----
  // Accept query param too (useful for manual testing)
  let callId =
    req.query?.callId ||
    req.body?.callId ||
    req.body?.hs_object_id ||
    deepFindId(req.body);

  // sanitize
  if (callId) callId = String(callId).trim();

  let recordingUrl = findRecordingUrl(req.body);

  if (!callId) {
    // Last-ditch: some HubSpot workflows wrap payload under "object" or "input"
    const candidates = [
      req.body?.object?.id,
      req.body?.object?.objectId,
      req.body?.input?.objectId,
    ].filter(Boolean);
    if (candidates.length) {
      callId = String(candidates[0]).trim();
    }
  }

  if (!callId) {
    // Short, explicit response HubSpot will log
    return res.status(400).json({ ok: false, error: "callId is required" });
  }

  // If webhook omitted the recording URL, we will fetch it from the Call
  if (!recordingUrl) {
    console.log("[info] recordingUrl missing in webhook — fetching from HubSpot Call…");
    try {
      const meta = await getCallRecordingMeta(callId);
      recordingUrl = meta?.recordingUrl || "";
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
    return res
      .status(400)
      .json({ ok: false, error: "callId and recordingUrl are required" });
  }

  // Respond immediately to HubSpot; continue work in background
  res.json({ ok: true, callId });

  // ---- BACKGROUND PIPELINE (unchanged from your working flow) ----
  try {
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

    console.log("[ai] Analysing with TLPI context…");
    const analysis = await analyseTranscript(transcript);
    console.log("[ai] analysis:", analysis);

    if (analysis?.uncertainty_reason === "Transcript contains no meaningful content.") {
      console.log("✅ Done", callId);
      return;
    }

    const assoc = await getCallAssociations(callId);
    console.log("[assoc]", {
      callId,
      contactIds: assoc.contactIds,
      dealIds: assoc.dealIds,
      ownerId: assoc.ownerId,
    });

    // ----- UPDATE CALL (unchanged) -----
    const callProps = {};

    callProps.ai_inferred_call_type = analysis.call_type || "Initial Consultation";
    callProps.ai_call_type_confidence = String(analysis?.ai_confidence || 90);

    callProps.ai_consultation_outcome = analysis?.outcome || "Unclear";
    callProps.ai_product_interest = analysis?.key_details?.products_discussed?.[0] || "";

    callProps.ai_decision_criteria = (analysis?.ai_decision_criteria || []).join("; ");

    callProps.ai_data_points_captured =
      analysis?.__data_points_captured_text || "Nothing captured.";

    callProps.ai_missing_information =
      analysis?.missing_information || "Nothing requested or all information provided.";
    callProps.ai_next_steps =
      (analysis?.next_actions || []).join("; ") || "No next steps recorded.";

    callProps.ai_key_objections = (analysis?.objections || []).join("; ") || "No objections";
    callProps.ai_objections_bullets =
      (analysis?.objections || []).join(" • ") || "No objections";
    callProps.ai_objection_severity = analysis?.objection_severity || "Medium";
    callProps.ai_primary_objection =
      analysis?.primary_objection || (analysis?.objections?.[0] || "No objection");
    callProps.ai_objection_categories = analysis?.objection_category || "Clarity";

    if (analysis?.sentiment) callProps.ai_customer_sentiment = analysis.sentiment;
    if (typeof analysis?.engagement_level === "number") {
      callProps.ai_client_engagement_level = String(analysis.engagement_level);
    }

    if (typeof analysis?.likelihood_to_close === "number") {
      callProps.ai_consultation_likelihood_to_close = String(
        Math.max(1, Math.min(10, Math.round(analysis.likelihood_to_close / 10)))
      );
    }

    callProps.chat_gpt___score_reasoning =
      analysis?.score_reasoning || "No specific reasoning extracted.";
    callProps.chat_gpt___increase_likelihood_of_sale_suggestions =
      (analysis?.increase_likelihood || []).join(", ") || "No suggestions.";

    callProps.sales_performance_summary = analysis?.sales_performance_summary || "";
    callProps.ai_consultation_required_materials =
      (analysis?.materials_to_send || []).join("; ") || "Nothing requested";

    try {
      const up = await updateCall(callId, callProps);
      console.log("[debug] Call updated:", {
        ...Object.fromEntries(Object.entries(callProps).map(([k, v]) => [k, v])),
        hs_object_id: up?.id || callId,
      });
    } catch (err) {
      console.warn("[HubSpot] PATCH /calls failed:", err.message);
    }

    // ----- CREATE SCORECARD (unchanged) -----
    const scProps = {
      activity_type: "Initial Consultation",
      activity_name: `${callId} — Initial Consultation — ${new Date()
        .toISOString()
        .slice(0, 10)}`,
      sales_performance_rating_: Math.max(
        1,
        Math.min(10, Math.round(analysis?.sales_performance_rating || 1))
      ),
      sales_scorecard___what_you_can_improve_on:
        analysis?.sales_performance_summary || "No coaching notes.",
      ai_consultation_likelihood_to_close: String(
        Math.max(
          1,
          Math.min(
            10,
            Math.round((analysis?.likelihood_to_close || 0) / 10)
          )
        )
      ),
      ai_consultation_outcome: analysis?.outcome || "Unclear",
      ai_consultation_required_materials:
        (analysis?.materials_to_send || []).join("; ") || "Nothing requested",
      ai_decision_criteria: (analysis?.ai_decision_criteria || []).join("; "),
      ai_key_objections: (analysis?.objections || []).join("; ") || "No objections",
      ai_next_steps:
        (analysis?.next_actions || []).join("; ") || "No next steps recorded",

      // 20 consult_* props
      consult_customer_agreed_to_set_up: Number(
        analysis?.consult_eval?.commitment_requested > 0.5 ? 1 : 0
      ),
      consult_overcame_objection_and_closed: Number(
        analysis?.consult_eval?.overcame_objection_and_closed || 0
      ),
      consult_next_step_specific_date_time: Number(
        analysis?.consult_eval?.next_step_specific_date_time || 0
      ),
      consult_closing_question_asked: Number(
        analysis?.consult_eval?.closing_question_asked || 0
      ),
      consult_prospect_asked_next_steps: Number(
        analysis?.consult_eval?.prospect_asked_next_steps || 0
      ),
      consult_strong_buying_signals_detected: Number(
        analysis?.consult_eval?.strong_buying_signals_detected || 0
      ),
      consult_needs_pain_uncovered: Number(
        analysis?.consult_eval?.needs_pain_uncovered || 0
      ),
      consult_purpose_clearly_stated: Number(
        analysis?.consult_eval?.purpose_clearly_stated || 0
      ),
      consult_quantified_value_roi: Number(
        analysis?.consult_eval?.quantified_value_roi || 0
      ),
      consult_demo_tax_saving: Number(
        analysis?.consult_eval?.demo_tax_saving || 0
      ),
      consult_fees_tax_deductible_explained: Number(
        analysis?.consult_eval?.fees_tax_deductible_explained || 0
      ),
      consult_fees_annualised: Number(
        analysis?.consult_eval?.fees_annualised || 0
      ),
      consult_fee_phrasing_three_seven_five: Number(
        analysis?.consult_eval?.fee_phrasing_three_seven_five || 0
      ),
      consult_specific_tax_estimate_given: Number(
        analysis?.consult_eval?.specific_tax_estimate_given || 0
      ),
      consult_confirm_reason_for_zoom: Number(
        analysis?.consult_eval?.confirm_reason_for_zoom || 0
      ),
      consult_rapport_open: Number(analysis?.consult_eval?.rapport_open || 0),
      consult_interactive_throughout: Number(
        analysis?.consult_eval?.interactive_throughout || 0
      ),
      consult_next_contact_within_5_days: Number(
        analysis?.consult_eval?.next_contact_within_5_days || 0
      ),
      consult_no_assumptions_evidence_gathered: Number(
        analysis?.consult_eval?.no_assumptions_evidence_gathered || 0
      ),
      consult_collected_dob_nin_when_agreed: Number(
        analysis?.consult_eval?.collected_dob_nin_when_agreed || 0
      ),
      consult_score_final: Number(
        analysis?.consult_eval?.final_weighted_score || 0
      ),
    };

    if (assoc.ownerId) {
      scProps.hubspot_owner_id = String(assoc.ownerId);
    }

    let scorecardId = null;
    try {
      scorecardId = await createScorecard(scProps);
      if (scorecardId) console.log("[scorecard] created id:", scorecardId);
    } catch (err) {
      console.warn("[HubSpot] create scorecard failed:", err.message);
    }

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
