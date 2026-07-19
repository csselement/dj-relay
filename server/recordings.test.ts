import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelaySession } from "./db.js";
import { MediaMtxRecordingBackend, isReplaySession, recordingDetails } from "./recordings.js";

const endedSession: RelaySession = {
  id: "session-1",
  name: "Recorded session",
  mediaPath: "recording-session-test",
  state: "ended",
  createdAt: "2026-07-17T19:00:00.000Z",
  expiresAt: "2026-07-18T03:00:00.000Z",
  startedAt: "2026-07-17T19:05:00.000Z",
  endedAt: "2026-07-17T20:00:00.000Z",
  endedReason: "dj",
  terminationCode: null,
  djLastSeenAt: "2026-07-17T20:00:00.000Z",
  interruptedAt: null,
  listenerHistoryAvailable: true,
  recordingRequested: true,
  recordingDeletedAt: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MediaMtxRecordingBackend", () => {
  it("normalizes and orders valid playback parts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { start: "2026-07-17T20:01:00Z", duration: 8 },
      { start: "invalid", duration: 0 },
      { start: "2026-07-17T20:00:00Z", duration: 12.5 },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })));
    const backend = new MediaMtxRecordingBackend("http://playback:9996", "http://media:9997");
    await expect(backend.listParts("recording-session-test")).resolves.toEqual([
      { start: "2026-07-17T20:00:00Z", durationSeconds: 12.5 },
      { start: "2026-07-17T20:01:00Z", durationSeconds: 8 },
    ]);
  });

  it("treats MediaMTX's missing-recording response as an empty archive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no recording found", { status: 400 })));
    const backend = new MediaMtxRecordingBackend("http://playback:9996", "http://media:9997");
    await expect(backend.listParts("recording-session-missing")).resolves.toEqual([]);
  });

  it("deletes every segment and reports partial failures", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify(url.searchParams.get("start")?.includes("20:01") ? { error: "locked" } : { ok: true }), {
          status: url.searchParams.get("start")?.includes("20:01") ? 500 : 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ segments: [
        { start: "2026-07-17T20:00:00Z" },
        { start: "2026-07-17T20:01:00Z" },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const backend = new MediaMtxRecordingBackend("http://playback:9996", "http://media:9997");
    await expect(backend.deleteAll("recording-session-test")).rejects.toThrow("locked");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(2);
  });
});

describe("recordingDetails", () => {
  it("summarizes multiple finalized parts without changing the session", async () => {
    const backend = {
      listParts: async () => [
        { start: "2026-07-17T20:00:00Z", durationSeconds: 12.5 },
        { start: "2026-07-17T20:01:00Z", durationSeconds: 8.25 },
      ],
      fetchPart: async () => new Response(),
      deleteAll: async () => undefined,
    };
    await expect(recordingDetails(endedSession, backend)).resolves.toMatchObject({
      summary: { status: "ready", durationSeconds: 20.75, partCount: 2 },
    });
  });

  it("reports deleted recordings without querying MediaMTX", async () => {
    const listParts = vi.fn(async () => []);
    const backend = { listParts, fetchPart: async () => new Response(), deleteAll: async () => undefined };
    const result = await recordingDetails({ ...endedSession, recordingDeletedAt: "2026-07-17T20:05:00Z" }, backend);
    expect(result.summary.status).toBe("deleted");
    expect(listParts).not.toHaveBeenCalled();
  });

  it("finalizes and then marks an unstarted ended session unavailable", async () => {
    const endedAt = "2026-07-17T20:00:00.000Z";
    const session = { ...endedSession, startedAt: null, endedAt };
    const backend = { listParts: async () => [], fetchPart: async () => new Response(), deleteAll: async () => undefined };
    expect(isReplaySession(session)).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(new Date(endedAt).getTime() + 10_000);
    await expect(recordingDetails(session, backend)).resolves.toMatchObject({ summary: { status: "finalizing" } });

    vi.spyOn(Date, "now").mockReturnValue(new Date(endedAt).getTime() + 31_000);
    await expect(recordingDetails(session, backend)).resolves.toMatchObject({ summary: { status: "unavailable" } });
  });
});
