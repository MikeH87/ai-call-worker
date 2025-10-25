// ai/parallelTranscribe.js
// Parallel Whisper transcription for speed.
// - Segments MP3 into short chunks (default 120s)
// - Uploads chunks to Whisper in parallel with a safe concurrency limit
// - Reuses the robust retry logic already in ai/analyse.js: transcribeFile()
// - Joins all partial transcripts in order

import os from "os";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { transcribeFile } from "./analyse.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const TMP_DIR = os.tmpdir();

// Small helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logSize(p) {
  try {
    const b = fs.statSync(p).size;
    return (b / 1048576).toFixed(2) + " MB";
  } catch {
    return "? MB";
  }
}

// Segment an audio file by fixed duration (in seconds)
function segmentAudioByDuration(inPath, outPattern, seconds = 120) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(outPattern);
    fs.mkdirSync(outDir, { recursive: true });

    ffmpeg(inPath)
      .outputOptions([
        "-f", "segment",
        "-segment_time", String(seconds),
        "-reset_timestamps", "1"
      ])
      .output(outPattern)
      .on("error", reject)
      .on("end", () => {
        const base = path.basename(outPattern).replace("%03d", "");
        const files = fs.readdirSync(outDir)
          .filter(f => f.startsWith(base))
          .map(f => path.join(outDir, f))
          .sort(); // ensure order
        resolve(files);
      })
      .run();
  });
}

// Simple promise pool for concurrency control
async function promisePool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const next = () => {
      if (idx >= items.length && active === 0) return resolve(results);
      while (active < limit && idx < items.length) {
        const myIndex = idx++;
        const item = items[myIndex];
        active++;
        Promise.resolve(worker(item, myIndex))
          .then((res) => { results[myIndex] = res; active--; next(); })
          .catch((err) => reject(err));
      }
    };
    next();
  });
}

/**
 * Transcribe an MP3 by splitting into short chunks and sending to Whisper in parallel.
 * @param {string} mp3Path - Prepared MP3 path (mono, 16kHz).
 * @param {string|number} callId - Call id for logging.
 * @param {object} opts - Options { segmentSeconds, concurrency }
 */
export async function transcribeAudioParallel(mp3Path, callId, opts = {}) {
  const segmentSeconds = Number(opts.segmentSeconds ?? 120);
  const concurrency = Math.max(1, Number(process.env.WHISPER_CONCURRENCY ?? opts.concurrency ?? 4));

  console.log(`[seg] input MP3 ${logSize(mp3Path)}; splitting into ~${segmentSeconds}s chunks…`);
  const baseName = `call_${callId}_part_%03d.mp3`;
  const pattern = path.join(TMP_DIR, baseName);

  const chunks = await segmentAudioByDuration(mp3Path, pattern, segmentSeconds);

  if (!chunks.length) {
    console.log("[seg] no chunks produced; falling back to single-file transcription");
    return await transcribeFile(mp3Path);
  }

  console.log(`[seg] created ${chunks.length} chunk(s). Transcribing in parallel (concurrency=${concurrency})…`);

  const startedAt = Date.now();
  const texts = await promisePool(chunks, concurrency, async (file, i) => {
    const n = i + 1;
    const size = logSize(file);
    console.log(`[whisper-par] chunk ${n}/${chunks.length} (${size}) starting…`);
    const t0 = Date.now();
    const text = await transcribeFile(file);  // robust retry logic inside
    const ms = Date.now() - t0;
    console.log(`[whisper-par] chunk ${n}/${chunks.length} finished in ${(ms / 1000).toFixed(1)}s`);
    return text || "";
  });

  const totalMs = Date.now() - startedAt;
  console.log(`[whisper-par] all ${chunks.length} chunks done in ${(totalMs / 1000).toFixed(1)}s; stitching…`);
  return texts.join("\n");
}
