import { describe, expect, it } from "vitest";
import type { RelaySession } from "../types";
import { sessionAudienceLabel } from "./AdminPage";

const session: RelaySession = {
  id: "session-1",
  name: "Monday lunch sesh",
  mediaPath: "session-path",
  state: "live",
  createdAt: "2026-07-13T17:00:00.000Z",
  expiresAt: "2026-07-14T01:00:00.000Z",
  startedAt: "2026-07-13T17:05:00.000Z",
  endedAt: null,
  listenerCount: 3,
  uniqueListenerCount: 5,
  listenerHistoryAvailable: true,
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
