// ai/parallelTranscribe.js
import ffmpegBin from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import os from "os";

import { transcribeFile } from "./analyse.js";

ffmpeg.setFfmpegPath(ffmpegBin.path);

/**
 * Split audio into N-second segments and transcribe with limited concurrency.
 * @param {string} audioPath
 * @param {string|number} callId
 * @param {{segmentSeconds?: number, concurrency?: number}} opts
 * @returns {Promise<string>} combined transcript
 */
export async function transcribeAudioParallel(audioPath, callId, opts = {}) {
  const segmentSeconds = Math.max(30, Number(opts.segmentSeconds) || 120);
  const concurrency = Math.max(1, Number(opts.concurrency) || 4);

  // Ensure callId is a string for filesystem paths
  const callKey = String(callId);

  const baseDir = path.join(os.tmpdir(), "ai-call-worker", callKey);
  const chunksDir = path.join(baseDir, "chunks");
  await fs.mkdir(chunksDir, { recursive: true });

  // Probe duration
  const durationSec = await probeDuration(audioPath);
  const parts = Math.ceil(durationSec / segmentSeconds);

  // Segment using ffmpeg
  const chunkPaths = [];
  for (let i = 0; i < parts; i++) {
    const start = i * segmentSeconds;
    const out = path.join(chunksDir, `part_${String(i).padStart(3, "0")}.mp3`);
    await cutSegment(audioPath, out, start, segmentSeconds);
    chunkPaths.push(out);
  }

  // Simple concurrency pool
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < chunkPaths.length) {
      const myIndex = idx++;
      const p = chunkPaths[myIndex];
      try {
        const txt = await transcribeFile(p);
        results[myIndex] = txt;
      } catch (err) {
        results[myIndex] = `[TRANSCRIPTION_ERROR part ${myIndex}]: ${err.message}`;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // cleanup best effort
  try { await fs.rm(baseDir, { recursive: true, force: true }); } catch {}

  return results.filter(Boolean).join("\n");
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const dur = data?.format?.duration || 0;
      resolve(Number(dur));
    });
  });
}

function cutSegment(src, out, startSec, durationSec) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(src)
      .seekInput(startSec)
      .duration(durationSec)
      .audioCodec("libmp3lame")
      .format("mp3")
      .on("error", reject)
      .on("end", resolve)
      .save(out);

    // Ensure output dir exists
    const dir = path.dirname(out);
    if (!fss.existsSync(dir)) fss.mkdirSync(dir, { recursive: true });
  });
}
