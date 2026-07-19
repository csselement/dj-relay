import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelaySession } from "./db.js";
import { archiveFilename, MediaMtxRecordingBackend, isReplaySession, recordingDetails } from "./recordings.js";

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
  it("names archives by Pacific start time and a safe session-name slug", () => {
    expect(archiveFilename(endedSession)).toBe("202607171205_recorded-session.mp3");
  });

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

  it("serves authenticated recording files with byte ranges for iOS media playback", async () => {
    const recordingsPath = await mkdtemp(join(tmpdir(), "discus-recordings-"));
    try {
      const sessionPath = join(recordingsPath, "recording-session-test");
      await mkdir(sessionPath);
      await writeFile(join(sessionPath, "2026-07-17_20-00-00-123456.mp4"), Uint8Array.from([0, 1, 2, 3, 4, 5]));
      const backend = new MediaMtxRecordingBackend("http://playback:9996", "http://media:9997", recordingsPath);
      const response = await backend.fetchPart(
        "recording-session-test",
        { start: "2026-07-17T20:00:00.123456Z", durationSeconds: 12.5 },
        new AbortController().signal,
        "bytes=2-4",
      );

      expect(response.status).toBe(206);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-range")).toBe("bytes 2-4/6");
      expect(response.headers.get("content-length")).toBe("3");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([2, 3, 4]));
    } finally {
      await rm(recordingsPath, { recursive: true, force: true });
    }
  });

  it("finalizes an Opus recording once, validates the MP3, and serves the MP3 with ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "discus-finalize-"));
    const recordingsPath = join(root, "recordings");
    const playbackPath = join(root, "playback");
    const sessionPath = join(recordingsPath, "recording-session-test");
    await Promise.all([mkdir(sessionPath, { recursive: true }), mkdir(playbackPath, { recursive: true })]);
    const sourcePath = join(sessionPath, "2026-07-17_20-00-00-123400.mp4");
    const source = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", "0.25", "-c:a", "libopus", "-b:a", "192k", "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof", sourcePath,
    ]);
    if (source.status !== 0) throw new Error(source.stderr.toString() || "Could not create finalization fixture");

    const deletedStarts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/list") {
        return new Response(JSON.stringify([{ start: "2026-07-17T20:00:00.1234Z", duration: 0.25 }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.includes("/v3/recordings/get/")) {
        return new Response(JSON.stringify({ segments: [{ start: "2026-07-17T20:00:00.1234Z" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/v3/recordings/deletesegment" && init?.method === "DELETE") {
        deletedStarts.push(url.searchParams.get("start") ?? "");
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    try {
      const backend = new MediaMtxRecordingBackend(
        "http://playback:9996",
        "http://media:9997",
        recordingsPath,
        playbackPath,
      );
      const session = {
        ...endedSession,
        name: "Recorded Session!",
        startedAt: "2026-07-17T20:00:00.1234Z",
        mediaPath: "recording-session-test",
      };
      await expect(backend.finalize(session)).resolves.toBe(true);
      await expect(backend.listParts("recording-session-test")).resolves.toEqual([
        {
          start: "2026-07-17T20:00:00.1234Z",
          durationSeconds: 0.25,
          filename: "202607171300_recorded-session.mp3",
        },
      ]);
      const response = await backend.fetchPart(
        "recording-session-test",
        { start: "2026-07-17T20:00:00.1234Z", durationSeconds: 0.25 },
        new AbortController().signal,
        "bytes=0-2",
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
      expect(Buffer.from(await response.arrayBuffer()).toString("ascii")).toBe("ID3");
      expect(deletedStarts).toEqual(["2026-07-17T20:00:00.1234Z"]);
      await expect(stat(join(playbackPath, "202607171300_recorded-session.mp3"))).resolves.toMatchObject({ size: expect.any(Number) });
      const metadata = JSON.parse(await readFile(join(playbackPath, "202607171300_recorded-session.json"), "utf8"));
      expect(metadata).toMatchObject({
        schemaVersion: 1,
        sessionId: "session-1",
        sessionName: "Recorded Session!",
        mediaPath: "recording-session-test",
        filename: "202607171300_recorded-session.mp3",
        archiveTimeZone: "America/Los_Angeles",
        startedAt: "2026-07-17T20:00:00.1234Z",
        durationSeconds: 0.25,
        codec: "mp3",
        bitrateKbps: 192,
        sampleRateHz: 48_000,
        channels: 2,
        sourceFormat: "fmp4/opus",
        sourcePartCount: 1,
        sourceStarts: ["2026-07-17T20:00:00.1234Z"],
        bytes: expect.any(Number),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy media-path archives to the start-time naming scheme", async () => {
    const root = await mkdtemp(join(tmpdir(), "discus-migrate-"));
    const recordingsPath = join(root, "recordings");
    const playbackPath = join(root, "playback");
    await Promise.all([mkdir(recordingsPath), mkdir(playbackPath)]);
    const legacyAudio = join(playbackPath, `${endedSession.mediaPath}.mp3`);
    const encoded = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", "0.25", "-c:a", "libmp3lame", "-b:a", "192k", "-ac", "2", "-ar", "48000", legacyAudio,
    ]);
    if (encoded.status !== 0) throw new Error(encoded.stderr.toString() || "Could not create migration fixture");
    await writeFile(join(playbackPath, `${endedSession.mediaPath}.json`), JSON.stringify({
      start: endedSession.startedAt,
      durationSeconds: 0.25,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    try {
      const backend = new MediaMtxRecordingBackend(
        "http://playback:9996",
        "http://media:9997",
        recordingsPath,
        playbackPath,
      );
      await expect(backend.finalize(endedSession)).resolves.toBe(false);
      await expect(stat(join(playbackPath, "202607171205_recorded-session.mp3"))).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(stat(legacyAudio)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(backend.listParts(endedSession.mediaPath)).resolves.toEqual([{
        start: endedSession.startedAt,
        durationSeconds: 0.25,
        filename: "202607171205_recorded-session.mp3",
      }]);
      const metadata = JSON.parse(await readFile(join(playbackPath, "202607171205_recorded-session.json"), "utf8"));
      expect(metadata.sourcePartCount).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

    vi.spyOn(Date, "now").mockReturnValue(new Date(endedAt).getTime() + 15 * 60_000 + 1);
    await expect(recordingDetails(session, backend)).resolves.toMatchObject({ summary: { status: "unavailable" } });
  });
});
