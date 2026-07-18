import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Mp3Transcoder = (input: Readable, output: Writable, signal: AbortSignal) => Promise<void>;

export const transcodeToMp3: Mp3Transcoder = async (input, output, signal) => {
  const child = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-map", "0:a:0",
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ac", "2",
    "-f", "mp3",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk;
  });

  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });

  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, childSignal) => {
      if (code === 0) return resolve();
      const detail = stderr.trim() || (childSignal ? `terminated by ${childSignal}` : `exited with code ${code}`);
      reject(new Error(`MP3 conversion failed: ${detail}`));
    });
  });

  try {
    await Promise.all([
      pipeline(input, child.stdin),
      pipeline(child.stdout, output),
      exited,
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
