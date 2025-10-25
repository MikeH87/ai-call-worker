// ai/parallelTranscribe.js
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import fetch from "node-fetch";
import FormData from "form-data";

ffmpeg.setFfmpegPath(ffmpegPath.path);

const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_TOKEN;
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

async function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const dur = data?.format?.duration || 0;
      resolve(Number(dur));
    });
  });
}

async function extractChunk(src, startSec, durSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .setStartTime(startSec)
      .duration(durSec)
      .audioCodec("libmp3lame")
      .format("mp3")
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}

async function whisperTranscribe(filePath) {
  const fd = new FormData();
  fd.append("model", "whisper-1");
  fd.append("temperature", "0");
  fd.append("response_format", "json");
  fd.append("file", (await import("node:fs")).default.createReadStream(filePath));

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: fd,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Whisper failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const js = await res.json();
  return js?.text || "";
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;
  let active = 0;

  return new Promise((resolve) => {
    const kick = () => {
      while (active < concurrency && idx < tasks.length) {
        const cur = idx++;
        active++;
        tasks[cur]()
          .then((r) => { results[cur] = r; })
          .catch((e) => { results[cur] = ""; console.warn("[warn] chunk failed:", e.message); })
          .finally(() => { active--; if (idx >= tasks.length && active === 0) resolve(results); else kick(); });
      }
    };
    kick();
  });
}

export async function transcribeAudioParallel(filePath, callId, opts = {}) {
  const segmentSeconds = Number(opts.segmentSeconds) || 120;
  const concurrency = Number(opts.concurrency) || 4;

  const duration = await ffprobeDuration(filePath);
  const total = Math.max(1, Math.ceil(duration / segmentSeconds));

  const tmpDir = path.join(os.tmpdir(), "ai-call-worker", String(callId));
  await fs.mkdir(tmpDir, { recursive: true });

  const tasks = Array.from({ length: total }).map((_, i) => async () => {
    const start = i * segmentSeconds;
    const len = Math.min(segmentSeconds, Math.max(1, Math.floor(duration - start)));
    const out = path.join(tmpDir, `seg_${i}.mp3`);
    await extractChunk(filePath, start, len, out);
    const text = await whisperTranscribe(out);
    try { await fs.unlink(out).catch(() => {}); } catch {}
    return text?.trim() || "";
  });

  const parts = await runPool(tasks, concurrency);
  const joined = parts.filter(Boolean).join("\n").trim();
  return joined;
}
