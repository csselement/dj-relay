import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RelaySession, SessionStore } from "./db.js";

export type RecordingPart = {
  start: string;
  durationSeconds: number;
  filename?: string;
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

type ArchiveMetadata = {
  schemaVersion: 1;
  sessionId: string;
  sessionName: string;
  mediaPath: string;
  filename: string;
  archiveTimeZone: "America/Los_Angeles";
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  codec: "mp3";
  bitrateKbps: 192;
  sampleRateHz: 48_000;
  channels: 2;
  sourceFormat: "fmp4/opus";
  sourcePartCount: number | null;
  sourceStarts: string[];
  finalizedAt: string;
  bytes: number;
};

type ResolvedArchive = {
  audioPath: string;
  metadataPath: string;
  metadata: Pick<ArchiveMetadata, "filename" | "startedAt" | "durationSeconds">;
  legacy: boolean;
};

const ARCHIVE_TIME_ZONE = "America/Los_Angeles";

function archiveTimestamp(startedAt: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ARCHIVE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(startedAt));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}${value("month")}${value("day")}${value("hour")}${value("minute")}`;
}

function archiveSlug(name: string): string {
  return name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recording";
}

export function archiveFilename(session: Pick<RelaySession, "name" | "startedAt" | "createdAt">): string {
  return `${archiveTimestamp(session.startedAt ?? session.createdAt)}_${archiveSlug(session.name)}.mp3`;
}

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
      const archive = await this.resolveArchive(path);
      return archive ? [{
        start: archive.metadata.startedAt,
        durationSeconds: archive.metadata.durationSeconds,
        filename: archive.metadata.filename,
      }] : [];
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
      const archive = await this.resolveArchive(path);
      if (archive) return fileResponse(archive.audioPath, "audio/mpeg", signal, range);
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
      const archive = await this.resolveArchive(path);
      await Promise.all([
        ...(archive ? [
          rm(archive.audioPath, { force: true }),
          rm(archive.metadataPath, { force: true }),
        ] : []),
        rm(join(this.playbackPath, ".index", `${path}.json`), { force: true }),
        rm(join(this.playbackPath, `${path}.mp3`), { force: true }),
        rm(join(this.playbackPath, `${path}.json`), { force: true }),
      ]);
    }
  }

  async finalize(session: RelaySession): Promise<boolean> {
    const path = session.mediaPath;
    if (!this.recordingsPath || !this.playbackPath || !/^[a-zA-Z0-9_-]+$/.test(path)) return false;
    const ready = await this.resolveArchive(path);
    if (ready) {
      if (ready.legacy) await this.migrateLegacyArchive(session, ready);
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
      await this.publishArchive(session, outputPath, durationSeconds, sources, id);
      await this.deleteSources(path);
      return true;
    } finally {
      await Promise.all([
        rm(concatPath, { force: true }),
        rm(outputPath, { force: true }),
      ]);
    }
  }

  private async resolveArchive(path: string): Promise<ResolvedArchive | null> {
    if (!this.playbackPath) return null;
    try {
      const pointer = JSON.parse(await readFile(join(this.playbackPath, ".index", `${path}.json`), "utf8")) as { basename?: unknown };
      if (typeof pointer.basename !== "string" || !/^[a-zA-Z0-9_-]+$/.test(pointer.basename)) throw new Error("Archive index was invalid");
      const metadataPath = join(this.playbackPath, `${pointer.basename}.json`);
      const audioPath = join(this.playbackPath, `${pointer.basename}.mp3`);
      const [raw] = await Promise.all([readFile(metadataPath, "utf8"), stat(audioPath)]);
      const metadata = JSON.parse(raw) as Partial<ArchiveMetadata>;
      if (metadata.mediaPath !== path || typeof metadata.filename !== "string" || typeof metadata.startedAt !== "string" ||
        typeof metadata.durationSeconds !== "number" || metadata.durationSeconds <= 0) throw new Error("Archive metadata was invalid");
      return { audioPath, metadataPath, metadata: metadata as ArchiveMetadata, legacy: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      const metadataPath = join(this.playbackPath, `${path}.json`);
      const audioPath = join(this.playbackPath, `${path}.mp3`);
      const [raw] = await Promise.all([readFile(metadataPath, "utf8"), stat(audioPath)]);
      const legacy = JSON.parse(raw) as { start?: unknown; durationSeconds?: unknown };
      if (typeof legacy.start !== "string" || typeof legacy.durationSeconds !== "number" || legacy.durationSeconds <= 0) {
        throw new Error("Legacy archive metadata was invalid");
      }
      return {
        audioPath,
        metadataPath,
        metadata: { filename: `${path}.mp3`, startedAt: legacy.start, durationSeconds: legacy.durationSeconds },
        legacy: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  private async publishArchive(
    session: RelaySession,
    sourcePath: string,
    durationSeconds: number,
    sources: RecordingPart[],
    id: string,
    sourcePartCount: number | null = sources.length || null,
  ): Promise<void> {
    if (!this.playbackPath) throw new Error("Playback archive path is unavailable");
    await mkdir(join(this.playbackPath, ".index"), { recursive: true });
    let filename = archiveFilename(session);
    let basename = filename.slice(0, -4);
    try {
      await stat(join(this.playbackPath, filename));
      basename = `${basename}-${session.id.slice(0, 8)}`;
      filename = `${basename}.mp3`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const audioPath = join(this.playbackPath, filename);
    const metadataPath = join(this.playbackPath, `${basename}.json`);
    await rename(sourcePath, audioPath);
    const audio = await stat(audioPath);
    const metadata: ArchiveMetadata = {
      schemaVersion: 1,
      sessionId: session.id,
      sessionName: session.name,
      mediaPath: session.mediaPath,
      filename,
      archiveTimeZone: ARCHIVE_TIME_ZONE,
      startedAt: session.startedAt ?? sources[0]?.start ?? session.createdAt,
      endedAt: session.endedAt,
      durationSeconds,
      codec: "mp3",
      bitrateKbps: 192,
      sampleRateHz: 48_000,
      channels: 2,
      sourceFormat: "fmp4/opus",
      sourcePartCount,
      sourceStarts: sources.map((part) => part.start),
      finalizedAt: new Date().toISOString(),
      bytes: audio.size,
    };
    const metadataTemp = `${metadataPath}.${id}`;
    const pointerPath = join(this.playbackPath, ".index", `${session.mediaPath}.json`);
    const pointerTemp = `${pointerPath}.${id}`;
    await writeFile(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`);
    await rename(metadataTemp, metadataPath);
    await writeFile(pointerTemp, `${JSON.stringify({ basename })}\n`);
    await rename(pointerTemp, pointerPath);
  }

  private async migrateLegacyArchive(session: RelaySession, archive: ResolvedArchive): Promise<void> {
    await validateMp3(archive.audioPath, archive.metadata.durationSeconds);
    const id = randomUUID();
    await this.publishArchive(session, archive.audioPath, archive.metadata.durationSeconds, [{
      start: archive.metadata.startedAt,
      durationSeconds: archive.metadata.durationSeconds,
    }], id, null);
    await rm(archive.metadataPath, { force: true });
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
          const finalized = await this.dependencies.recordings.finalize(session);
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
