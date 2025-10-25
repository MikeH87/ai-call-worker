// ai/parallelTranscribe.js
// Smarter, parallel Whisper transcription:
// - Detects duration with ffprobe
// - If duration <= 15 min: single upload (no segmentation)
// - If duration > 15 min: segment into ~15-min chunks (900s)
// - Parallel uploads with safe concurrency (default 3-4)
// - Reuses robust retry logic in ai/analyse.js: transcribeFile()

import os from "os";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { transcribeFile } from "./analyse.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const TMP_DIR = os.tmpdir();

function logSize(p) {
  try {
    const b = fs.statSync(p).size;
    return (b / 1048576).toFixed(2) + " MB";
  } catch {
    return "? MB";
  }
}

// Probe duration (seconds)
function getDurationSeconds(inPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inPath, (err, data) => {
      if (err) return reject(err);
      const dur = data?.format?.duration || 0;
      resolve(Number(dur) || 0);
    });
  });
}

// Segment by fixed duration (seconds)
function segmentAudio(inPath, outPattern, seconds) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(outPattern);
    fs.mkdirSync(outDir, { recursive: true });

    ffmpeg(inPath)
      .outputOptions([
        "-f", "segment",
        "-segment_time", String(seconds),
        "-reset_timestamps", "1",
      ])
      .output(outPattern)
      .on("error", reject)
      .on("end", () => {
        const base = path.basename(outPattern).replace("%03d", "");
        const files = fs.readdirSync(outDir)
          .filter(f => f.startsWith(base))
          .map(f => path.join(outDir, f))
          .sort();
        resolve(files);
      })
      .run();
  });
}

// Simple promise pool
async function promisePool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0, active = 0;

  return new Promise((resolve, reject) => {
    const next = () => {
      if (idx >= items.length && active === 0) return resolve(results);
      while (active < limit && idx < items.length) {
        const myIndex = idx++;
        const it = items[myIndex];
        active++;
        Promise.resolve(worker(it, myIndex))
          .then(res => { results[myIndex] = res; active--; next(); })
          .catch(reject);
      }
    };
    next();
  });
}

/**
 * Transcribe with dynamic chunking:
 *  - <= 15 min → single upload
 *  - >  15 min → chunks of ~15 min (900s) in parallel
 */
export async function transcribeAudioParallel(mp3Path, callId, opts = {}) {
  const concurrency = Math.max(1, Number(process.env.WHISPER_CONCURRENCY ?? opts.concurrency ?? 3));
  const maxChunkSeconds = 900; // 15 minutes

  const durationSec = await getDurationSeconds(mp3Path).catch(() => 0);
  console.log(`[dur] ${durationSec ? durationSec.toFixed(1) : "?"}s total; file ${logSize(mp3Path)}`);

  if (!durationSec || durationSec <= maxChunkSeconds) {
    console.log("[seg] duration <= 15 min → single-file transcription");
    return await transcribeFile(mp3Path); // robust retry inside
  }

  console.log("[seg] duration > 15 min → splitting into ~15-min chunks");
  const baseName = `call_${callId}_part_%03d.mp3`;
  const pattern = path.join(TMP_DIR, baseName);
  const chunks = await segmentAudio(mp3Path, pattern, maxChunkSeconds);

  if (!chunks.length) {
    console.log("[seg] segmentation produced 0 chunks; falling back to single-file transcription");
    return await transcribeFile(mp3Path);
  }

  console.log(`[seg] created ${chunks.length} chunk(s). Parallel transcription (concurrency=${concurrency})…`);
  const t0 = Date.now();

  const pieces = await promisePool(chunks, concurrency, async (file, i) => {
    const n = i + 1;
    console.log(`[whisper-par] chunk ${n}/${chunks.length} (${logSize(file)}) starting…`);
    const s0 = Date.now();
    const txt = await transcribeFile(file);
    console.log(`[whisper-par] chunk ${n}/${chunks.length} finished in ${((Date.now()-s0)/1000).toFixed(1)}s`);
    return txt || "";
  });

  console.log(`[whisper-par] all chunks done in ${((Date.now()-t0)/1000).toFixed(1)}s; stitching…`);
  return pieces.join("\n");
}
