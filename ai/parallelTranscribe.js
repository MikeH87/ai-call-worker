// ai/parallelTranscribe.js
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// --- helpers ---
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function downloadToFile(sourceUrl, destPath) {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Download failed ${res.status}: ${text || sourceUrl}`);
  }
  await ensureDir(path.dirname(destPath));

  // stream to file
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
    file.on("error", reject);
  });

  // sanity check
  const stat = await fsp.stat(destPath).catch(() => null);
  if (!stat || stat.size < 1024) {
    throw new Error(`Downloaded file too small or missing: ${destPath}`);
  }
  return destPath;
}

function ffprobePromise(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

// Stub: your real Whisper chunking/transcription should replace this.
// Here we just return a dummy string to keep the pipeline running.
async function transcribeSegmentsMock(filePath) {
  // Replace with your real parallel Whisper logic using segmentSeconds/concurrency.
  return "Transcription placeholder (replace with Whisper output).";
}

/**
 * Main entry:
 * - Ensures dest dir
 * - Downloads MP3 from sourceUrl -> destPath
 * - ffprobe to confirm media
 * - Runs (your) parallel transcription & returns final transcript string
 */
export async function transcribeAudioParallel(destPath, callId, opts = {}) {
  const { sourceUrl, segmentSeconds = 120, concurrency = 4 } = opts;

  if (!sourceUrl) {
    throw new Error("transcribeAudioParallel: sourceUrl is required");
  }

  // Download first
  await downloadToFile(sourceUrl, destPath);

  // Probe to confirm we have audio
  try {
    await ffprobePromise(destPath);
  } catch (err) {
    throw new Error(`ffprobe failed for ${destPath}: ${err.message || err}`);
  }

  // TODO: replace mock with your real chunking Whisper implementation
  const transcript = await transcribeSegmentsMock(destPath);

  // Guard: if the transcript is obviously empty (e.g., blank recording), bail early
  const trimmed = (transcript || "").trim();
  if (!trimmed || trimmed.length < 10) {
    const msg = "Transcript appears empty/meaningless — skipping AI analysis.";
    const err = new Error(msg);
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }

  return trimmed;
}
