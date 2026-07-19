import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { SessionStore } from "./db.js";
import { directorySize, MediaMtxControlClient, RecordingWatchdog, type MediaMtxControl, type MediaPathSnapshot } from "./recordingWatchdog.js";

afterEach(() => vi.unstubAllGlobals());

function setup(overrides: Record<string, unknown> = {}) {
  const store = new SessionStore(":memory:");
  const config = loadConfig({
    recordingsPath: "/recordings",
    recordingSessionMaxBytes: 100,
    recordingArchiveMaxBytes: 1_000,
    recordingHostFreeFloorBytes: 200,
    recordingHostFreeWarningBytes: 300,
    recordingArchiveWarningRatio: 0.9,
    recordingIngressMaxBytesPerSecond: 10,
    recordingIngressWindowMs: 1_000,
    recordingIngressConsecutiveViolations: 2,
  });
  let paths: MediaPathSnapshot[] = [];
  const mediaMtx: MediaMtxControl = {
    listPaths: vi.fn(async () => paths),
    kickWebRtcSession: vi.fn(async () => undefined),
  };
  let now = 0;
  const directorySize = vi.fn<(path: string) => Promise<number>>(async (path: string) => path === "/recordings" ? 100 : 0);
  const freeBytes = vi.fn<(path: string) => Promise<number>>(async () => 500);
  const watchdog = new RecordingWatchdog({
    config,
    store,
    mediaMtx,
    directorySize,
    freeBytes,
    now: () => now,
    logger: vi.fn(),
    ...overrides,
  });
  return { store, config, mediaMtx, watchdog, directorySize, freeBytes, setPaths: (value: MediaPathSnapshot[]) => { paths = value; }, advance: (ms: number) => { now += ms; } };
}

describe("RecordingWatchdog", () => {
  it("sums every retained file across concurrent directory scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "discus-storage-size-"));
    try {
      const nested = join(root, "nested");
      await mkdir(nested);
      await Promise.all([
        writeFile(join(root, "original-a.mp4"), Buffer.alloc(3)),
        writeFile(join(root, "original-b.mp4"), Buffer.alloc(5)),
        writeFile(join(nested, "finalized.mp3"), Buffer.alloc(7)),
      ]);
      await expect(directorySize(root)).resolves.toBe(15);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks recording until an initial archive scan succeeds and reports warnings", async () => {
    const fixture = setup();
    expect(fixture.watchdog.canCreateRecording()).toBe(false);
    await fixture.watchdog.initialize();
    expect(fixture.watchdog.getStatus()).toMatchObject({ state: "ok", initialized: true, usedBytes: 100, freeBytes: 500 });
    expect(fixture.watchdog.canCreateRecording()).toBe(true);

    fixture.directorySize.mockResolvedValueOnce(950);
    await fixture.watchdog.scanArchive();
    expect(fixture.watchdog.getStatus().state).toBe("warning");
  });

  it("counts retained originals and finalized MP3s together before admitting new recordings", async () => {
    const fixture = setup();
    fixture.directorySize.mockImplementation(async (path: string) => path === "/recordings" ? 600 : 500);
    await fixture.watchdog.initialize();
    expect(fixture.directorySize).toHaveBeenCalledWith("/recordings");
    expect(fixture.directorySize).toHaveBeenCalledWith("/playback");
    expect(fixture.watchdog.getStatus()).toMatchObject({ state: "blocked", usedBytes: 1_100 });
    expect(fixture.watchdog.canCreateRecording()).toBe(false);
  });

  it("ends active recording sessions at session and archive limits with durable codes", async () => {
    const fixture = setup();
    await fixture.watchdog.initialize();
    const session = fixture.store.create("Limited", 4, true);
    fixture.store.setState(session.id, "live");
    fixture.directorySize.mockImplementation(async (path: string) => path === "/recordings" ? 100 : 101);
    await fixture.watchdog.scanActive();
    expect(fixture.store.get(session.id)).toMatchObject({ state: "ended", terminationCode: "recording_session_limit" });

    const archive = fixture.store.create("Archive limited", 4, true);
    fixture.store.setState(archive.id, "live");
    fixture.directorySize.mockResolvedValueOnce(1_001);
    await fixture.watchdog.scanArchive();
    expect(fixture.store.get(archive.id)).toMatchObject({ state: "ended", terminationCode: "recording_archive_limit" });
    expect(fixture.watchdog.canCreateRecording()).toBe(false);
  });

  it("rejects non-Opus publishers and kicks their WebRTC session", async () => {
    const fixture = setup();
    await fixture.watchdog.initialize();
    const session = fixture.store.create("Video", 4, true);
    fixture.store.setState(session.id, "live");
    fixture.setPaths([{ name: session.mediaPath, tracks: ["Opus", "H264"], bytesReceived: 1, sourceType: "webrtcSession", sourceId: "publisher-1" }]);
    await fixture.watchdog.scanActive();
    expect(fixture.store.get(session.id)?.terminationCode).toBe("recording_media_policy");
    expect(fixture.mediaMtx.kickWebRtcSession).toHaveBeenCalledWith("publisher-1");
  });

  it("requires two complete rolling-window rate violations", async () => {
    const fixture = setup();
    await fixture.watchdog.initialize();
    const session = fixture.store.create("High bitrate", 4, true);
    fixture.store.setState(session.id, "live");
    const path = (bytesReceived: number): MediaPathSnapshot => ({
      name: session.mediaPath, tracks: ["Opus"], bytesReceived, sourceType: "webrtcSession", sourceId: "publisher-2",
    });
    fixture.setPaths([path(0)]);
    await fixture.watchdog.scanActive();
    fixture.advance(1_000);
    fixture.setPaths([path(20)]);
    await fixture.watchdog.scanActive();
    expect(fixture.store.get(session.id)?.state).toBe("live");
    fixture.advance(1_000);
    fixture.setPaths([path(40)]);
    await fixture.watchdog.scanActive();
    expect(fixture.store.get(session.id)?.terminationCode).toBe("recording_media_policy");
  });

  it("becomes unavailable on malformed monitoring without ending measured-safe sessions", async () => {
    const fixture = setup();
    await fixture.watchdog.initialize();
    const session = fixture.store.create("Preserved", 4, true);
    fixture.store.setState(session.id, "live");
    vi.mocked(fixture.mediaMtx.listPaths).mockRejectedValueOnce(new Error("invalid response"));
    await fixture.watchdog.scanActive();
    expect(fixture.watchdog.getStatus().state).toBe("unavailable");
    expect(fixture.store.get(session.id)?.state).toBe("live");
    expect(fixture.watchdog.canCreateRecording()).toBe(false);
  });
});

describe("MediaMtxControlClient", () => {
  it("normalizes path tracks and publisher identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{
      name: "recording-session-test",
      tracks: ["Opus"],
      bytesReceived: 42,
      source: { type: "webrtcSession", id: "publisher-1" },
    }] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const client = new MediaMtxControlClient("http://mediamtx:9997");
    await expect(client.listPaths()).resolves.toEqual([{
      name: "recording-session-test", tracks: ["Opus"], bytesReceived: 42,
      sourceType: "webrtcSession", sourceId: "publisher-1",
    }]);
  });

  it("rejects malformed path responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: {} }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
    const client = new MediaMtxControlClient("http://mediamtx:9997");
    await expect(client.listPaths()).rejects.toThrow("response was invalid");
  });
});
