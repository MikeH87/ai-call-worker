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

function validateHttpUrl(u) {
  try {
    const url = new URL(String(u));
    if (!/^https?:$/i.test(url.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(sourceUrl, destPath) {
  if (!validateHttpUrl(sourceUrl)) {
    const t = typeof sourceUrl;
    throw Object.assign(new Error(`Invalid recording URL (${t})`), { code: "INVALID_URL", input: sourceUrl });
  }

  const res = await fetch(sourceUrl);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Download failed ${res.status}: ${text || sourceUrl}`);
  }
  await ensureDir(path.dirname(destPath));

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
    file.on("error", reject);
  });

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

// TODO: replace this stub with your real Whisper parallel chunking
async function transcribeSegmentsMock(filePath) {
  return "Transcription placeholder (replace with Whisper output).";
}

export async function transcribeAudioParallel(destPath, callId, opts = {}) {
  const { sourceUrl } = opts;
  const segmentSeconds = Number(opts.segmentSeconds) || 120;
  const concurrency = Number(opts.concurrency) || 4;

  if (!sourceUrl) {
    throw new Error("transcribeAudioParallel: sourceUrl is required");
  }

  await downloadToFile(sourceUrl, destPath);

  try {
    await ffprobePromise(destPath);
  } catch (err) {
    throw new Error(`ffprobe failed for ${destPath}: ${err.message || err}`);
  }

  const transcript = await transcribeSegmentsMock(destPath);

  const trimmed = (transcript || "").trim();
  if (!trimmed || trimmed.length < 10) {
    const msg = "Transcript appears empty/meaningless — skipping AI analysis.";
    const err = new Error(msg);
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }

  return trimmed;
}
