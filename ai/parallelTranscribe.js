// ai/parallelTranscribe.js
import fs from "fs";

import fsp from "fs/promises";

import path from "path";

import os from "os";

import fetch from "node-fetch";

import ffmpeg from "fluent-ffmpeg";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

import FormData from "form-data";


ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// -------------------- helpers --------------------
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function validateHttpUrl(u) {
  try {
    const url = new URL(String(u));
    return /^https?:$/i.test(url.protocol);
  } catch {
    return false;
  }
}

async function downloadToFile(sourceUrl, destPath) {
  if (!validateHttpUrl(sourceUrl)) {
    const t = typeof sourceUrl;
    throw Object.assign(new Error(`Invalid recording URL (${t})`), {
      code: "INVALID_URL",
      input: sourceUrl,
    });
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
  if (!stat || stat.size < 2048) {
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

// Transcode to a known-good audio format for segmenting and Whisper
async function transcodeToWorkingAudio(inputPath, outBase) {
  // First try MP3 (libmp3lame mono 16kHz 96kbps)
  const mp3Path = `${outBase}.mp3`;
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .audioChannels(1)
        .audioFrequency(16000)
        .audioBitrate(96)
        .format("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(mp3Path);
    });
    const st = await fsp.stat(mp3Path);
    if (st.size > 2048) return { path: mp3Path, ext: ".mp3" };
  } catch (e) {
    console.warn("[warn] MP3 transcode failed, will try WAV fallback:", e.message || e);
  }

  // Fallback to WAV (PCM s16le mono 16kHz)
  const wavPath = `${outBase}.wav`;
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(wavPath);
  });
  const st2 = await fsp.stat(wavPath);
  if (!st2 || st2.size <= 2048) {
    throw new Error("Transcode produced an invalid file.");
  }
  return { path: wavPath, ext: ".wav" };
}

async function splitAudio(inputPath, outDir, segmentSeconds, extForParts) {
  await ensureDir(outDir);
  // Clean old parts
  try {
    const entries = await fsp.readdir(outDir);
    await Promise.all(entries.map(e => fsp.unlink(path.join(outDir, e)).catch(() => {})));
  } catch {}

  const pattern = path.join(outDir, `part-%03d${extForParts}`);
  // We can segment without re-encoding now
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .addOptions(["-f", "segment", "-segment_time", String(segmentSeconds), "-reset_timestamps", "1"])
      .audioCodec("copy")
      .output(pattern)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  const files = (await fsp.readdir(outDir))
    .filter(f => f.startsWith("part-") && f.endsWith(extForParts))
    .map(f => path.join(outDir, f))
    .sort();

  return files;
}

async function whisperTranscribe(filePath) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("response_format", "text");
  form.append("language", "en");
  form.append("file", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: filePath.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
  });

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Whisper failed ${resp.status}: ${t}`);
  }
  const text = await resp.text();
  return (text || "").trim();
}

// -------------------- main --------------------
export async function transcribeAudioParallel(destPath, callId, opts = {}) {
  const sourceUrl = opts.sourceUrl;
  const segmentSeconds = Math.max(20, Number(opts.segmentSeconds) || 120);
  const concurrency = Math.max(1, Number(opts.concurrency) || 4);

  if (!sourceUrl) throw new Error("transcribeAudioParallel: sourceUrl is required");
  if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY missing — Whisper will fail.");

  // 1) Download original
  await downloadToFile(sourceUrl, destPath);

  // 2) Probe original (not strictly required, useful for early failure)
  await ffprobePromise(destPath).catch((err) => {
    throw new Error(`ffprobe failed for ${destPath}: ${err.message || err}`);
  });

  // 3) Transcode to working format (mp3 → fallback wav)
  const workBase = path.join(os.tmpdir(), `ai-call-worker-${callId}`, "work");
  await ensureDir(path.dirname(workBase));
  const { path: workingPath, ext } = await transcodeToWorkingAudio(destPath, workBase);

  // 4) Segment the working file
  const partsDir = path.join(os.tmpdir(), `ai-call-worker-${callId}`, "parts");
  const parts = await splitAudio(workingPath, partsDir, segmentSeconds, ext);
  if (!parts.length) {
    const err = new Error("No audio segments produced");
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }

  // 5) Transcribe parts with modest concurrency
  const queue = parts.slice();
  const results = [];
  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      try {
        const text = await whisperTranscribe(file);
        results.push({ file, text });
      } catch (e) {
        console.warn("[warn] Whisper failed for", path.basename(file), e.message || e);
        results.push({ file, text: "" });
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // 6) Join transcript
  results.sort((a, b) => a.file.localeCompare(b.file));
  const joined = results.map(r => (r.text || "").trim()).filter(Boolean).join("\n\n");
  const trimmed = (joined || "").trim();

  if (!trimmed || trimmed.length < 16) {
    const err = new Error("Transcript appears empty/meaningless — skipping AI analysis.");
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }
  return trimmed;
}






