import { describe, expect, it } from "vitest";
import type { RelaySession } from "../types";
import { defaultSessionName, recordingArchiveLabel, sessionAudienceLabel } from "./AdminPage";

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
