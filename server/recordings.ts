import type { RelaySession } from "./db.js";

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
  fetchPart(path: string, part: RecordingPart, signal: AbortSignal): Promise<Response>;
  deleteAll(path: string): Promise<void>;
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
    const status: RecordingStatus = Date.now() - finalizedAt < 30_000 ? "finalizing" : "unavailable";
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
  ) {}

  async listParts(path: string): Promise<RecordingPart[]> {
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

  async fetchPart(path: string, part: RecordingPart, signal: AbortSignal): Promise<Response> {
    const url = new URL("/get", this.playbackUrl);
    url.searchParams.set("path", path);
    url.searchParams.set("start", part.start);
    url.searchParams.set("duration", String(part.durationSeconds));
    url.searchParams.set("format", "fmp4");
    return fetch(url, { signal });
  }

  async deleteAll(path: string): Promise<void> {
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
