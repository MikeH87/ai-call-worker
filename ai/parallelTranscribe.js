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

// ---------- helpers ----------
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

async function splitAudio(filePath, outDir, segmentSeconds) {
  await ensureDir(outDir);
  // Clear old parts if any
  try {
    const entries = await fsp.readdir(outDir);
    await Promise.all(
      entries.map((e) => fsp.unlink(path.join(outDir, e)).catch(() => {}))
    );
  } catch {}
  return new Promise((resolve, reject) => {
    const pattern = path.join(outDir, "part-%03d.mp3");
    ffmpeg(filePath)
      .audioCodec("copy")
      .format("mp3")
      .outputOptions(["-f segment", `-segment_time ${segmentSeconds}`, "-reset_timestamps 1"])
      .output(pattern)
      .on("end", async () => {
        const files = (await fsp.readdir(outDir))
          .filter((f) => f.startsWith("part-") && f.endsWith(".mp3"))
          .map((f) => path.join(outDir, f))
          .sort();
        resolve(files);
      })
      .on("error", (err) => reject(err))
      .run();
  });
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
    contentType: "audio/mpeg",
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

// ---------- main ----------
export async function transcribeAudioParallel(destPath, callId, opts = {}) {
  const sourceUrl = opts.sourceUrl;
  const segmentSeconds = Number(opts.segmentSeconds) || 120;
  const concurrency = Math.max(1, Number(opts.concurrency) || 4);

  if (!sourceUrl) throw new Error("transcribeAudioParallel: sourceUrl is required");
  if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY missing — Whisper will fail.");

  // 1) Download
  await downloadToFile(sourceUrl, destPath);

  // 2) Verify media
  await ffprobePromise(destPath).catch((err) => {
    throw new Error(`ffprobe failed for ${destPath}: ${err.message || err}`);
  });

  // 3) Split into chunks
  const tmpDir = path.join(os.tmpdir(), `ai-call-worker-${callId}`);
  const parts = await splitAudio(destPath, tmpDir, segmentSeconds);
  if (!parts.length) {
    const err = new Error("No audio segments produced");
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }

  // 4) Transcribe with modest concurrency
  const queue = parts.slice();
  const results = [];
  async function worker(i) {
    while (queue.length) {
      const file = queue.shift();
      try {
        const text = await whisperTranscribe(file);
        results.push({ file, text });
      } catch (e) {
        console.warn("[warn] Whisper failed for", path.basename(file), e.message);
        results.push({ file, text: "" });
      }
    }
  }
  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  // 5) Join
  results.sort((a, b) => a.file.localeCompare(b.file));
  const joined = results.map((r) => (r.text || "").trim()).filter(Boolean).join("\n\n");
  const trimmed = (joined || "").trim();

  if (!trimmed || trimmed.length < 16) {
    const err = new Error("Transcript appears empty/meaningless — skipping AI analysis.");
    err.code = "EMPTY_TRANSCRIPT";
    throw err;
  }
  return trimmed;
}
