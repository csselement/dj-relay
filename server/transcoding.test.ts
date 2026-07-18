import { spawnSync } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { transcodeToMp3 } from "./transcoding.js";

function silentStereoWav(durationSeconds = 0.1): Buffer {
  const channelCount = 2;
  const sampleRate = 48_000;
  const bytesPerSample = 2;
  const dataLength = Math.round(durationSeconds * sampleRate) * channelCount * bytesPerSample;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channelCount, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  wav.writeUInt16LE(channelCount * bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

describe("transcodeToMp3", () => {
  it("produces an MP3 stream from an Opus fMP4 recording", async () => {
    const source = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-b:a", "192k",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    ], { input: silentStereoWav() });
    if (source.status !== 0) throw new Error(source.stderr.toString() || "Could not create the fMP4 test recording");

    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));

    await transcodeToMp3(
      Readable.from([source.stdout]),
      output,
      new AbortController().signal,
    );

    const encoded = Buffer.concat(chunks);
    expect(encoded.length).toBeGreaterThan(1000);
    expect(encoded.subarray(0, 3).toString("ascii")).toBe("ID3");
  });
});
