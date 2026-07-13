import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { randomToken, tokenHash } from "./security.js";

export type SessionState = "ready" | "live" | "interrupted" | "ended" | "expired";
export type SessionEndReason = "dj" | "owner" | "timeout";

export type RelaySession = {
  id: string;
  name: string;
  mediaPath: string;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: SessionEndReason | null;
  djLastSeenAt: string | null;
  interruptedAt: string | null;
  listenerHistoryAvailable: boolean;
};

type SessionRow = {
  id: string;
  name: string;
  media_path: string;
  state: SessionState;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  ended_at: string | null;
  ended_reason: SessionEndReason | null;
  listener_tracking_started_at: string | null;
  dj_last_seen_at: string | null;
  interrupted_at: string | null;
  dj_token_hash: string;
  listener_token_hash: string;
};

export type CreatedSession = RelaySession & {
  djToken: string;
  listenerToken: string;
};

export type AdminSessionPage = {
  active: RelaySession[];
  history: RelaySession[];
  historyTotal: number;
};

function mapSession(row: SessionRow): RelaySession {
  const expired = row.state !== "ended" && new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: row.id,
    name: row.name,
    mediaPath: row.media_path,
    state: expired ? "expired" : row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedReason: row.ended_reason,
    djLastSeenAt: row.dj_last_seen_at,
    interruptedAt: row.interrupted_at,
    listenerHistoryAvailable: Boolean(row.listener_tracking_started_at),
  };
}

export class SessionStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        media_path TEXT NOT NULL UNIQUE,
        dj_token_hash TEXT NOT NULL UNIQUE,
        listener_token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('ready', 'live', 'interrupted', 'ended')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        ended_reason TEXT CHECK (ended_reason IN ('dj', 'owner', 'timeout')),
        listener_tracking_started_at TEXT,
        dj_last_seen_at TEXT,
        interrupted_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions(created_at DESC);
      CREATE TABLE IF NOT EXISTS session_listeners (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        listener_id TEXT NOT NULL,
        first_listened_at TEXT NOT NULL,
        PRIMARY KEY (session_id, listener_id)
      ) STRICT;
    `);
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "listener_tracking_started_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN listener_tracking_started_at TEXT;");
      const trackingStartedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE sessions SET listener_tracking_started_at = ?
        WHERE state = 'ready' AND started_at IS NULL AND expires_at > ?
      `).run(trackingStartedAt, trackingStartedAt);
    }
    if (!sessionColumns.some((column) => column.name === "dj_last_seen_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN dj_last_seen_at TEXT;");
      const migrationTime = new Date().toISOString();
      this.db.prepare(`
        UPDATE sessions SET dj_last_seen_at = ?
        WHERE state IN ('live', 'interrupted')
      `).run(migrationTime);
    }
    if (!sessionColumns.some((column) => column.name === "interrupted_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN interrupted_at TEXT;");
      const migrationTime = new Date().toISOString();
      this.db.prepare(`
        UPDATE sessions SET interrupted_at = ?
        WHERE state = 'interrupted'
      `).run(migrationTime);
    }
    if (!sessionColumns.some((column) => column.name === "ended_reason")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN ended_reason TEXT;");
    }
    this.db.exec(`
      UPDATE sessions SET listener_tracking_started_at = NULL
      WHERE state = 'ready' AND started_at IS NULL
        AND expires_at <= listener_tracking_started_at
    `);
  }

  close(): void {
    this.db.close();
  }

  create(name: string, expiresInHours: number): CreatedSession {
    const id = randomUUID();
    const djToken = randomToken();
    const listenerToken = randomToken();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + expiresInHours * 60 * 60 * 1000);
    const mediaPath = `session-${randomToken().slice(0, 24)}`;

    this.db.prepare(`
      INSERT INTO sessions (
        id, name, media_path, dj_token_hash, listener_token_hash,
        state, created_at, expires_at, started_at, ended_at, ended_reason,
        listener_tracking_started_at, dj_last_seen_at, interrupted_at
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, NULL, NULL, NULL, ?, ?, NULL)
    `).run(
      id,
      name,
      mediaPath,
      tokenHash(djToken),
      tokenHash(listenerToken),
      createdAt.toISOString(),
      expiresAt.toISOString(),
      createdAt.toISOString(),
      createdAt.toISOString(),
    );

    return {
      id,
      name,
      mediaPath,
      state: "ready",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      startedAt: null,
      endedAt: null,
      endedReason: null,
      djLastSeenAt: createdAt.toISOString(),
      interruptedAt: null,
      listenerHistoryAvailable: true,
      djToken,
      listenerToken,
    };
  }

  list(): RelaySession[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as SessionRow[];
    return rows.map(mapSession);
  }

  listAdminPage(historyLimit: number, now = new Date()): AdminSessionPage {
    const nowIso = now.toISOString();
    const activeRows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE state != 'ended' AND expires_at > ?
      ORDER BY created_at DESC
    `).all(nowIso) as SessionRow[];
    const historyRows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE state = 'ended' OR expires_at <= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(nowIso, historyLimit) as SessionRow[];
    const count = this.db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE state = 'ended' OR expires_at <= ?
    `).get(nowIso) as { count: number };

    return {
      active: activeRows.map(mapSession),
      history: historyRows.map(mapSession),
      historyTotal: count.count,
    };
  }

  get(id: string): RelaySession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  findByPath(path: string): RelaySession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE media_path = ?").get(path) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  recordListener(sessionId: string, listenerId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO session_listeners (session_id, listener_id, first_listened_at)
      VALUES (?, ?, ?)
    `).run(sessionId, listenerId, new Date().toISOString());
  }

  uniqueListenerCount(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM session_listeners WHERE session_id = ?
    `).get(sessionId) as { count: number };
    return row.count;
  }

  touchDj(sessionId: string, seenAt = new Date()): void {
    this.db.prepare(`
      UPDATE sessions SET dj_last_seen_at = ?
      WHERE id = ? AND state IN ('ready', 'live', 'interrupted')
    `).run(seenAt.toISOString(), sessionId);
  }

  endStaleSessions(graceMs: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - graceMs).toISOString();
    const result = this.db.prepare(`
      UPDATE sessions SET state = 'ended', ended_at = ?, ended_reason = 'timeout'
      WHERE (
        state = 'live' AND (dj_last_seen_at IS NULL OR dj_last_seen_at <= ?)
      ) OR (
        state = 'interrupted' AND (COALESCE(interrupted_at, dj_last_seen_at) IS NULL OR COALESCE(interrupted_at, dj_last_seen_at) <= ?)
      )
    `).run(now.toISOString(), cutoff, cutoff);
    return Number(result.changes);
  }

  exchangeInvite(token: string): { session: RelaySession; role: "dj" | "listener" } | null {
    const hash = tokenHash(token);
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE dj_token_hash = ? OR listener_token_hash = ?
    `).get(hash, hash) as SessionRow | undefined;
    if (!row) return null;

    const session = mapSession(row);
    if (session.state === "expired" || session.state === "ended") return null;
    return { session, role: row.dj_token_hash === hash ? "dj" : "listener" };
  }

  setState(id: string, state: Exclude<SessionState, "expired">, endedReason: SessionEndReason = "dj"): RelaySession | null {
    const current = this.get(id);
    if (!current || current.state === "ended" || current.state === "expired") return current;
    const now = new Date().toISOString();
    if (state === "live") {
      this.db.prepare(`
        UPDATE sessions
        SET state = 'live', started_at = COALESCE(started_at, ?), dj_last_seen_at = ?, interrupted_at = NULL
        WHERE id = ?
      `).run(now, now, id);
    } else if (state === "ended") {
      this.db.prepare("UPDATE sessions SET state = 'ended', ended_at = ?, ended_reason = ? WHERE id = ?").run(now, endedReason, id);
    } else {
      this.db.prepare(`
        UPDATE sessions
        SET state = 'interrupted', dj_last_seen_at = ?, interrupted_at = COALESCE(interrupted_at, ?)
        WHERE id = ?
      `).run(now, now, id);
    }
    return this.get(id);
  }
}
