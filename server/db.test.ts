import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./db.js";

describe("SessionStore migrations and lifecycle", () => {
  it("preserves legacy sessions and tracks new listeners once per browser identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "dj-relay-db-"));
    const path = join(directory, "relay.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        media_path TEXT NOT NULL UNIQUE,
        dj_token_hash TEXT NOT NULL UNIQUE,
        listener_token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('ready', 'live', 'interrupted', 'ended')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT
      ) STRICT;
      INSERT INTO sessions VALUES (
        'legacy-ended', 'Legacy ended session', 'legacy-ended-path', 'dj-ended', 'listener-ended',
        'ended', '2026-07-13T08:00:00.000Z', '2026-07-13T12:00:00.000Z',
        '2026-07-13T08:05:00.000Z', '2026-07-13T09:00:00.000Z'
      );
      INSERT INTO sessions VALUES (
        'legacy-ready', 'Legacy ready session', 'legacy-ready-path', 'dj-ready', 'listener-ready',
        'ready', '2026-07-13T16:00:00.000Z', '2099-07-14T00:00:00.000Z', NULL, NULL
      );
      INSERT INTO sessions VALUES (
        'legacy-expired', 'Legacy expired session', 'legacy-expired-path', 'dj-expired', 'listener-expired',
        'ready', '2026-07-12T08:00:00.000Z', '2026-07-13T12:00:00.000Z', NULL, NULL
      );
    `);
    legacy.close();

    const store = new SessionStore(path);
    try {
      expect(store.get("legacy-ended")?.listenerHistoryAvailable).toBe(false);
      expect(store.get("legacy-ready")?.listenerHistoryAvailable).toBe(true);
      expect(store.get("legacy-expired")).toMatchObject({ state: "expired", listenerHistoryAvailable: false });

      const created = store.create("Tracked session", 4);
      expect(created.listenerHistoryAvailable).toBe(true);
      store.recordListener(created.id, "listener-browser-1");
      store.recordListener(created.id, "listener-browser-1");
      store.recordListener(created.id, "listener-browser-2");
      expect(store.uniqueListenerCount(created.id)).toBe(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an active session during the 60-second DJ disconnect grace period", () => {
    const store = new SessionStore(":memory:");
    try {
      const session = store.create("Grace period", 4);
      store.setState(session.id, "live");
      const disconnectedAt = new Date();
      store.touchDj(session.id, disconnectedAt);

      expect(store.endStaleSessions(60_000, new Date(disconnectedAt.getTime() + 59_999))).toBe(0);
      expect(store.get(session.id)?.state).toBe("live");

      expect(store.endStaleSessions(60_000, new Date(disconnectedAt.getTime() + 60_000))).toBe(1);
      expect(store.get(session.id)).toMatchObject({ state: "ended", endedReason: "timeout" });
    } finally {
      store.close();
    }
  });

  it("does not let heartbeats extend an interrupted stream countdown", () => {
    const store = new SessionStore(":memory:");
    try {
      const session = store.create("Interrupted grace period", 4);
      store.setState(session.id, "live");
      const interrupted = store.setState(session.id, "interrupted");
      const interruptedAt = new Date(interrupted?.interruptedAt ?? 0);
      store.touchDj(session.id, new Date(interruptedAt.getTime() + 45_000));

      expect(store.endStaleSessions(60_000, new Date(interruptedAt.getTime() + 59_999))).toBe(0);
      expect(store.endStaleSessions(60_000, new Date(interruptedAt.getTime() + 60_000))).toBe(1);
      expect(store.get(session.id)).toMatchObject({ state: "ended", endedReason: "timeout" });
    } finally {
      store.close();
    }
  });
});
