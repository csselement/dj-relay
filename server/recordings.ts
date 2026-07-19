import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RelaySession, SessionStore } from "./db.js";

export type RecordingPart = {
  start: string;
  durationSeconds: number;
};

export type RecordingStatus = "off" | "scheduled" | "recording" | "finalizing" | "ready" | "deleted" | "unavailable";

export type RecordingSummary = {
  requested: boolean;
  status: RecordingStatus;
  durationSeconds: number | null;
  partCount: number;
};

export interface RecordingBackend {
  listParts(path: string): Promise<RecordingPart[]>;
  fetchPart(path: string, part: RecordingPart, signal: AbortSignal, range?: string): Promise<Response>;
  deleteAll(path: string): Promise<void>;
}

function recordingFilename(start: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(start);
  const micros = (match?.[5] ?? "").padEnd(6, "0");
  return match ? `${match[1]}_${match[2]}-${match[3]}-${match[4]}-${micros}.mp4` : null;
}

function byteRange(raw: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function isReplaySession(session: RelaySession): boolean {
  return session.recordingRequested && (session.state === "ended" || session.state === "expired");
}

export async function recordingDetails(
  session: RelaySession,
  backend: RecordingBackend,
): Promise<{ summary: RecordingSummary; parts: RecordingPart[] }> {
  if (!session.recordingRequested) {
    return { summary: { requested: false, status: "off", durationSeconds: null, partCount: 0 }, parts: [] };
  }
  if (session.recordingDeletedAt) {
    return { summary: { requested: true, status: "deleted", durationSeconds: null, partCount: 0 }, parts: [] };
  }
  if (!session.startedAt && !isReplaySession(session)) {
    return { summary: { requested: true, status: "scheduled", durationSeconds: null, partCount: 0 }, parts: [] };
  }
  if (!isReplaySession(session)) {
    return { summary: { requested: true, status: "recording", durationSeconds: null, partCount: 0 }, parts: [] };
  }

  try {
    const parts = await backend.listParts(session.mediaPath);
    if (parts.length > 0) {
      return {
        summary: {
          requested: true,
          status: "ready",
          durationSeconds: parts.reduce((total, part) => total + part.durationSeconds, 0),
          partCount: parts.length,
        },
        parts,
      };
    }
    const finalizedAt = new Date(session.endedAt ?? session.expiresAt).getTime();
    const status: RecordingStatus = Date.now() - finalizedAt < 15 * 60_000 ? "finalizing" : "unavailable";
    return { summary: { requested: true, status, durationSeconds: null, partCount: 0 }, parts: [] };
  } catch {
    return { summary: { requested: true, status: "unavailable", durationSeconds: null, partCount: 0 }, parts: [] };
  }
}

type PlaybackListEntry = {
  start?: unknown;
  duration?: unknown;
};

type RecordingApiResponse = {
  segments?: Array<{ start?: unknown }>;
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(payload?.error ?? `${fallback} (${response.status})`);
}

export class MediaMtxRecordingBackend implements RecordingBackend {
  constructor(
    private readonly playbackUrl: string,
    private readonly apiUrl: string,
    private readonly recordingsPath?: string,
    private readonly playbackPath?: string,
  ) {}

  async listParts(path: string): Promise<RecordingPart[]> {
    if (this.playbackPath && /^[a-zA-Z0-9_-]+$/.test(path)) {
      try {
        const [raw] = await Promise.all([
          readFile(join(this.playbackPath, `${path}.json`), "utf8"),
          stat(join(this.playbackPath, `${path}.mp3`)),
        ]);
        const metadata = JSON.parse(raw) as { start?: unknown; durationSeconds?: unknown };
        if (typeof metadata.start === "string" && typeof metadata.durationSeconds === "number" && metadata.durationSeconds > 0) {
          return [{ start: metadata.start, durationSeconds: metadata.durationSeconds }];
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return [];
    }
    return this.listSourceParts(path);
  }

  private async listSourceParts(path: string): Promise<RecordingPart[]> {
    const url = new URL("/list", this.playbackUrl);
    url.searchParams.set("path", path);
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (response.status === 400 || response.status === 404) return [];
    if (!response.ok) throw await responseError(response, "Recording list failed");
    const payload = await response.json() as PlaybackListEntry[];
    if (!Array.isArray(payload)) throw new Error("Recording list response was invalid");
    return payload.flatMap((entry) => {
      const start = typeof entry.start === "string" ? entry.start : "";
      const durationSeconds = typeof entry.duration === "number" ? entry.duration : Number.NaN;
      if (!start || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
      return [{ start, durationSeconds }];
    }).sort((a, b) => a.start.localeCompare(b.start));
  }

  async fetchPart(path: string, part: RecordingPart, signal: AbortSignal, range?: string): Promise<Response> {
    if (this.playbackPath && /^[a-zA-Z0-9_-]+$/.test(path)) {
      try {
        return await fileResponse(join(this.playbackPath, `${path}.mp3`), "audio/mpeg", signal, range);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const filename = recordingFilename(part.start);
    if (this.recordingsPath && filename && /^[a-zA-Z0-9_-]+$/.test(path)) {
      const filePath = join(this.recordingsPath, path, filename);
      try {
        return await fileResponse(filePath, "video/mp4", signal, range);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const url = new URL("/get", this.playbackUrl);
    url.searchParams.set("path", path);
    url.searchParams.set("start", part.start);
    url.searchParams.set("duration", String(part.durationSeconds));
    url.searchParams.set("format", "fmp4");
    return fetch(url, { signal, headers: range ? { Range: range } : undefined });
  }

  async deleteAll(path: string): Promise<void> {
    await this.deleteSources(path);
    if (this.playbackPath && /^[a-zA-Z0-9_-]+$/.test(path)) {
      await Promise.all([
        rm(join(this.playbackPath, `${path}.mp3`), { force: true }),
        rm(join(this.playbackPath, `${path}.json`), { force: true }),
      ]);
    }
  }

  async finalize(path: string): Promise<boolean> {
    if (!this.recordingsPath || !this.playbackPath || !/^[a-zA-Z0-9_-]+$/.test(path)) return false;
    const ready = await this.listParts(path);
    if (ready.length > 0) {
      await this.deleteSources(path);
      return false;
    }

    const sources = await this.listSourceParts(path);
    if (sources.length === 0) return false;
    const files = sources.map((part) => {
      const filename = recordingFilename(part.start);
      if (!filename) throw new Error("Recording source timestamp was invalid");
      return join(this.recordingsPath as string, path, filename);
    });
    await Promise.all(files.map((file) => stat(file)));

    const id = randomUUID();
    const concatPath = join(tmpdir(), `discus-${id}.txt`);
    const outputPath = join(this.playbackPath, `${path}.${id}.mp3`);
    const finalPath = join(this.playbackPath, `${path}.mp3`);
    const metadataPath = join(this.playbackPath, `${path}.json`);
    const durationSeconds = sources.reduce((total, part) => total + part.durationSeconds, 0);
    const concat = files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n");
    await writeFile(concatPath, `${concat}\n`, { mode: 0o600 });
    try {
      await runProcess("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        outputPath,
      ]);
      await validateMp3(outputPath, durationSeconds);
      await rename(outputPath, finalPath);
      const metadataTemp = `${metadataPath}.${id}`;
      await writeFile(metadataTemp, JSON.stringify({ start: sources[0].start, durationSeconds }));
      await rename(metadataTemp, metadataPath);
      await this.deleteSources(path);
      return true;
    } finally {
      await Promise.all([
        rm(concatPath, { force: true }),
        rm(outputPath, { force: true }),
      ]);
    }
  }

  private async deleteSources(path: string): Promise<void> {
    const getUrl = new URL(`/v3/recordings/get/${encodeURIComponent(path)}`, this.apiUrl);
    const response = await fetch(getUrl, { signal: AbortSignal.timeout(2500) });
    if (response.status === 404) return;
    if (!response.ok) throw await responseError(response, "Recording lookup failed");
    const payload = await response.json() as RecordingApiResponse;
    const starts = Array.isArray(payload.segments) ? payload.segments.flatMap((segment) =>
      typeof segment.start === "string" ? [segment.start] : []) : [];

    const results = await Promise.allSettled(starts.map(async (start) => {
      const deleteUrl = new URL("/v3/recordings/deletesegment", this.apiUrl);
      deleteUrl.searchParams.set("path", path);
      deleteUrl.searchParams.set("start", start);
      const deleted = await fetch(deleteUrl, { method: "DELETE", signal: AbortSignal.timeout(2500) });
      if (!deleted.ok) throw await responseError(deleted, "Recording deletion failed");
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

async function fileResponse(filePath: string, contentType: string, signal: AbortSignal, range?: string): Promise<Response> {
  const file = await stat(filePath);
  const headers = new Headers({ "Accept-Ranges": "bytes", "Content-Type": contentType });
  let status = 200;
  let start = 0;
  let end = file.size - 1;
  if (range) {
    const requested = byteRange(range, file.size);
    if (!requested) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    ({ start, end } = requested);
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  const stream = createReadStream(filePath, { start, end, signal });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}

async function runProcess(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 8192) stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
  return stdout;
}

async function validateMp3(path: string, expectedDuration: number): Promise<void> {
  const raw = await runProcess("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels,sample_rate:format=duration",
    "-of", "json", path,
  ]);
  const payload = JSON.parse(raw) as {
    streams?: Array<{ codec_name?: unknown; channels?: unknown; sample_rate?: unknown }>;
    format?: { duration?: unknown };
  };
  const stream = payload.streams?.[0];
  const duration = Number(payload.format?.duration);
  const tolerance = Math.max(2, expectedDuration * 0.01);
  if (stream?.codec_name !== "mp3" || stream.channels !== 2 || stream.sample_rate !== "48000" ||
    !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > tolerance) {
    throw new Error("Finalized MP3 failed codec, channel, sample-rate, or duration validation");
  }
}

export class RecordingFinalizer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dependencies: { store: Pick<SessionStore, "list">; recordings: MediaMtxRecordingBackend }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), 5_000);
    this.timer.unref();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = this.dependencies.store.list().filter((session) =>
        isReplaySession(session) && Boolean(session.startedAt) && !session.recordingDeletedAt);
      for (const session of sessions) {
        try {
          const finalized = await this.dependencies.recordings.finalize(session.mediaPath);
          if (finalized) console.log(JSON.stringify({ level: "info", event: "recording_mp3_finalized", sessionId: session.id }));
        } catch (error) {
          console.error(JSON.stringify({
            level: "error",
            event: "recording_mp3_finalization_failed",
            sessionId: session.id,
            error: error instanceof Error ? error.message : "Unknown error",
          }));
        }
      }
    } finally {
      this.running = false;
    }
  }
}
