import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelaySession } from "../types";
import {
  defaultSessionName,
  recordingArchiveLabel,
  sessionAudienceLabel,
  sessionCarriesRecording,
  CopyLink,
  AdminPage,
  runtimeStatusLabel,
} from "./AdminPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const session: RelaySession = {
  id: "session-1",
  name: "Monday lunch sesh",
  mediaPath: "session-path",
  state: "live",
  createdAt: "2026-07-13T17:00:00.000Z",
  expiresAt: "2026-07-14T01:00:00.000Z",
  startedAt: "2026-07-13T17:05:00.000Z",
  endedAt: null,
  endedReason: null,
  terminationCode: null,
  disconnectDeadline: "2026-07-13T17:06:00.000Z",
  listenerCount: 3,
  uniqueListenerCount: 5,
  listenerHistoryAvailable: true,
  recording: { requested: false, status: "off", durationSeconds: null, partCount: 0 },
};

describe("sessionAudienceLabel", () => {
  it("uses the current listening count for active sessions", () => {
    expect(sessionAudienceLabel(session)).toBe("3 listening");
  });

  it("uses singular and plural past tense for ended sessions", () => {
    expect(sessionAudienceLabel({ ...session, state: "ended", uniqueListenerCount: 1 })).toBe("1 person listened");
    expect(sessionAudienceLabel({ ...session, state: "expired", uniqueListenerCount: 5 })).toBe("5 people listened");
  });

  it("does not misreport legacy sessions whose audience was not tracked", () => {
    expect(sessionAudienceLabel({ ...session, state: "ended", listenerHistoryAvailable: false })).toBe("listener history unavailable");
  });
});

describe("defaultSessionName", () => {
  it.each([
    ["2026-07-16T16:00:00.000Z", "Thursday Morning Session"],
    ["2026-07-17T21:00:00.000Z", "Friday Afternoon Session"],
    ["2026-07-18T01:00:00.000Z", "Friday Evening Session"],
    ["2026-07-21T05:00:00.000Z", "Monday Night Session"],
  ])("uses the Los Angeles weekday and time of day for %s", (timestamp, expected) => {
    expect(defaultSessionName(new Date(timestamp))).toBe(expected);
  });
});

describe("recordingArchiveLabel", () => {
  it("shows duration and reconnect parts for ready recordings", () => {
    expect(recordingArchiveLabel({
      ...session,
      state: "ended",
      recording: { requested: true, status: "ready", durationSeconds: 80.4, partCount: 2 },
    })).toBe(" · recording ready · 1:20 · 2 parts");
  });

  it("shows archive state while a recording is not ready", () => {
    expect(recordingArchiveLabel({
      ...session,
      state: "ended",
      recording: { requested: true, status: "finalizing", durationSeconds: null, partCount: 0 },
    })).toBe(" · recording finalizing");
  });
});

describe("sessionCarriesRecording", () => {
  it.each(["scheduled", "recording", "finalizing", "ready"] as const)("shows the recording badge for %s sessions", (status) => {
    expect(sessionCarriesRecording({
      ...session,
      recording: { requested: true, status, durationSeconds: null, partCount: 0 },
    })).toBe(true);
  });

  it.each(["off", "deleted", "unavailable"] as const)("hides the recording badge for %s sessions", (status) => {
    expect(sessionCarriesRecording({
      ...session,
      recording: { requested: true, status, durationSeconds: null, partCount: 0 },
    })).toBe(false);
  });

  it("requires recording to have been requested", () => {
    expect(sessionCarriesRecording({
      ...session,
      recording: { requested: false, status: "ready", durationSeconds: 80, partCount: 1 },
    })).toBe(false);
  });
});

describe("producer resilience and status UI", () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
  const adminStatus = {
    mediaMtx: true,
    recording: {
      state: "ok" as const,
      usedBytes: 1024,
      maxBytes: 2048,
      freeBytes: 4096,
      sessionMaxBytes: 1024,
      lastSuccessfulScanAt: "2026-07-18T20:00:00.000Z",
    },
    transcode: { active: 0, queued: 0, maxActive: 2, maxQueued: 4 },
  };

  it("shows an unavailable retry screen instead of a login screen after initial network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<AdminPage />);
    expect(await screen.findByRole("heading", { name: "Producer console unavailable" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Producer password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("opens sign-in only when the identity endpoint reports signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ authenticated: false })));
    render(<AdminPage />);
    expect(await screen.findByLabelText("Producer password")).toBeInTheDocument();
  });

  it("keeps the authenticated console visible when logout fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/me") return json({ authenticated: true });
      if (url.startsWith("/api/admin/sessions")) return json({ sessions: [], history: { loaded: 0, total: 0, hasMore: false } });
      if (url === "/api/admin/status") return json(adminStatus);
      if (url === "/api/admin/logout" && init?.method === "POST") return json({ error: "Logout service unavailable" }, 503);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<AdminPage />);
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Logout service unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
  });

  it("preserves the last session list and marks it stale after polling fails", async () => {
    let sessionRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/me") return json({ authenticated: true });
      if (url.startsWith("/api/admin/sessions")) {
        sessionRequests += 1;
        if (sessionRequests > 1) throw new TypeError("network down");
        return json({ sessions: [{ ...session, name: "Preserved session" }], history: { loaded: 6, total: 7, hasMore: true } });
      }
      if (url === "/api/admin/status") return json(adminStatus);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<AdminPage />);
    expect(await screen.findByText("Preserved session")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load older sessions" })); });
    expect(await screen.findByText(/Session list is stale/)).toBeInTheDocument();
    expect(screen.getByText("Preserved session")).toBeInTheDocument();
  });

  it("disables recording and explains manual archive deletion when storage is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/me") return json({ authenticated: true });
      if (url.startsWith("/api/admin/sessions")) return json({ sessions: [], history: { loaded: 0, total: 0, hasMore: false } });
      if (url === "/api/admin/status") return json({ ...adminStatus, recording: { ...adminStatus.recording, state: "blocked" } });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<AdminPage />);
    expect(await screen.findByText("Recording blocked")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Record" })).toBeDisabled();
    expect(screen.getByText(/Delete archived sessions/)).toBeInTheDocument();
  });

  it("maps protected health states to the approved labels", () => {
    expect(runtimeStatusLabel(adminStatus, false).label).toBe("Ready");
    expect(runtimeStatusLabel({ ...adminStatus, mediaMtx: false }, false).label).toBe("Media-relay degraded");
    expect(runtimeStatusLabel({ ...adminStatus, recording: { ...adminStatus.recording, state: "warning" } }, false).label).toBe("Recording-storage warning");
    expect(runtimeStatusLabel(null, true).label).toBe("Unavailable");
  });
});

describe("created-link feedback", () => {
  it("uses contextual button names and an atomic announcement after copying", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    render(<CopyLink label="DJ invite" copyName="DJ link" value="https://example.test/s/dj" />);
    expect(screen.getByRole("link", { name: "Open DJ link in a new tab" })).toHaveAttribute("href", "https://example.test/s/dj");
    expect(screen.getByRole("link", { name: "Open DJ link in a new tab" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Open DJ link in a new tab" })).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Copy DJ link" }));
    expect(await screen.findByRole("button", { name: "DJ link copied" })).toBeInTheDocument();
    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toHaveTextContent("DJ link copied");
  });

  it("shows copy failures as an alert", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    render(<CopyLink label="Listener invite" copyName="listener link" value="https://example.test/s/listener" />);
    expect(screen.getByRole("link", { name: "Open listener link in a new tab" })).toHaveAttribute("href", "https://example.test/s/listener");
    expect(screen.getByRole("link", { name: "Open listener link in a new tab" })).toHaveAttribute("target", "_blank");
    fireEvent.click(screen.getByRole("button", { name: "Copy listener link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the listener link");
  });
});
