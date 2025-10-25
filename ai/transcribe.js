// ai/transcribe.js
// Handles audio downloading and conversion for Whisper

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const TMP_DIR = os.tmpdir();

// Download the call recording (Zoom or HubSpot URL)
export async function downloadRecording(url, callId) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filePath = path.join(TMP_DIR, `${callId}_src`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// Convert to mono 16kHz MP3 for Whisper
export async function ensureAudio(inPath, callId) {
  const outPath = path.join(TMP_DIR, `${callId}.mp3`);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .audioCodec("libmp3lame")
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate("24k")
      .format("mp3")
      .output(outPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
  return outPath;
}
