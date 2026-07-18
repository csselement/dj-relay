import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import type { AppConfig } from "./config.js";
import { SessionStore, type RelaySession } from "./db.js";
import { announceDiscordSession, type DiscordSessionAnnouncement } from "./discord.js";
import {
  isReplaySession,
  MediaMtxRecordingBackend,
  recordingDetails,
  type RecordingBackend,
  type RecordingSummary,
} from "./recordings.js";
import { safeEqual, signToken, verifyToken, type TokenPayload } from "./security.js";

const ADMIN_COOKIE = "djrelay_admin";
const INVITE_COOKIE = "djrelay_invite";

type AppDependencies = {
  config: AppConfig;
  store: SessionStore;
  discordNotifier?: (announcement: DiscordSessionAnnouncement) => Promise<void>;
  recordings?: RecordingBackend;
};

function expiresIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function cookieOptions(config: AppConfig, maxAge: number) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

function sendError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

async function getListenerCount(config: AppConfig, path: string): Promise<number> {
  try {
    const response = await fetch(`${config.mediaMtxApiUrl}/v3/paths/list`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return 0;
    const payload = await response.json() as { items?: Array<{ name?: string; readers?: unknown[] }> };
    const activePath = payload.items?.find((item) => item.name === path);
    return Array.isArray(activePath?.readers) ? activePath.readers.length : 0;
  } catch {
    return 0;
  }
}

function adminPayload(req: Request, config: AppConfig): TokenPayload | null {
  const payload = verifyToken(req.cookies?.[ADMIN_COOKIE], config.tokenSecret);
  return payload?.kind === "admin" ? payload : null;
}

function invitePayload(req: Request, config: AppConfig): TokenPayload | null {
  const payload = verifyToken(req.cookies?.[INVITE_COOKIE], config.tokenSecret);
  return payload?.kind === "invite" ? payload : null;
}

function requireAdmin(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!adminPayload(req, config)) return sendError(res, 401, "Producer sign-in required");
    next();
  };
}

function requireInvite(config: AppConfig, store: SessionStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const payload = invitePayload(req, config);
    if (!payload?.sessionId || !payload.role) return sendError(res, 401, "Invite link required");
    const session = store.get(payload.sessionId);
    if (!session || (session.state === "expired" && !isReplaySession(session))) {
      return sendError(res, 410, "This session has expired");
    }
    res.locals.invite = payload;
    res.locals.session = session;
    next();
  };
}

function publicSession(
  session: RelaySession,
  listenerCount: number,
  uniqueListenerCount: number,
  disconnectGraceMs: number,
  recording: RecordingSummary,
) {
  const disconnectStartedAt = session.state === "interrupted" ? session.interruptedAt :
    session.state === "live" ? session.djLastSeenAt : null;
  return {
    id: session.id,
    name: session.name,
    mediaPath: session.mediaPath,
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endedReason: session.endedReason,
    listenerHistoryAvailable: session.listenerHistoryAvailable,
    listenerCount,
    uniqueListenerCount,
    disconnectDeadline: disconnectStartedAt ?
      new Date(new Date(disconnectStartedAt).getTime() + disconnectGraceMs).toISOString() : null,
    recording,
  };
}

function encodeCursor(session: RelaySession): string {
  return Buffer.from(JSON.stringify({ createdAt: session.createdAt, id: session.id })).toString("base64url");
}

function decodeCursor(raw: unknown): { createdAt: string; id: string } | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || !Number.isFinite(new Date(parsed.createdAt).getTime()) || typeof parsed.id !== "string") {
      return undefined;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

export function createApp({
  config,
  store,
  discordNotifier = announceDiscordSession,
  recordings = new MediaMtxRecordingBackend(config.mediaMtxPlaybackUrl, config.mediaMtxApiUrl),
}: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(self)");
    next();
  });

  async function serializeSession(session: RelaySession, listenerCount = 0) {
    const { summary } = await recordingDetails(session, recordings);
    return publicSession(
      session,
      listenerCount,
      store.uniqueListenerCount(session.id),
      config.djDisconnectGraceMs,
      summary,
    );
  }

  async function streamRecordingPart(session: RelaySession, index: number, download: boolean, res: Response): Promise<void> {
    const parts = await recordings.listParts(session.mediaPath);
    const part = parts[index];
    if (!part) return sendError(res, 404, "Recording part not found");

    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const upstream = await recordings.fetchPart(session.mediaPath, part, controller.signal);
      if (!upstream.ok || !upstream.body) return sendError(res, 502, "Recording playback is temporarily unavailable");
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "video/mp4");
      res.setHeader("Cache-Control", "private, no-store");
      const safeName = session.name.normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "discus-recording";
      const filename = parts.length > 1 ? `${safeName}-part-${index + 1}.mp4` : `${safeName}.mp4`;
      res.setHeader("Content-Disposition", download ? `attachment; filename="${filename}"` : "inline");
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);
      await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>), res);
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) {
        sendError(res, 502, error instanceof Error ? error.message : "Recording playback failed");
      }
    } finally {
      res.removeListener("close", abort);
    }
  }

  app.get("/api/health", async (_req, res) => {
    let mediaMtx = false;
    try {
      const response = await fetch(`${config.mediaMtxApiUrl}/v3/info`, {
        signal: AbortSignal.timeout(1200),
      });
      mediaMtx = response.ok;
    } catch {
      mediaMtx = false;
    }
    res.json({ ok: true, mediaMtx });
  });

  app.post("/api/admin/login", (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || !safeEqual(password, config.adminPassword)) {
      return sendError(res, 401, "Incorrect producer password");
    }
    const token = signToken({ kind: "admin", exp: expiresIn(12 * 60 * 60) }, config.tokenSecret);
    res.cookie(ADMIN_COOKIE, token, cookieOptions(config, 12 * 60 * 60 * 1000));
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/admin/me", (req, res) => {
    res.json({ authenticated: Boolean(adminPayload(req, config)) });
  });

  app.get("/api/admin/sessions", requireAdmin(config), async (req, res) => {
    store.endStaleSessions(config.djDisconnectGraceMs);
    const requestedHistoryLimit = Number(req.query.historyLimit ?? 20);
    const historyLimit = Number.isSafeInteger(requestedHistoryLimit) && requestedHistoryLimit > 0 ?
      requestedHistoryLimit : 20;
    const page = store.listAdminPage(historyLimit);
    const sessions = await Promise.all([...page.active, ...page.history].map(async (session) => {
      const listenerCount = session.state === "ended" || session.state === "expired" ? 0 :
        await getListenerCount(config, session.mediaPath);
      return serializeSession(session, listenerCount);
    }));
    res.json({
      sessions,
      history: {
        loaded: page.history.length,
        total: page.historyTotal,
        hasMore: page.history.length < page.historyTotal,
      },
    });
  });

  app.post("/api/admin/sessions", requireAdmin(config), async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const expiresInHours = Number(req.body?.expiresInHours ?? 8);
    const recordingRequested = req.body?.recordingRequested ?? false;
    if (name.length < 2 || name.length > 80) return sendError(res, 400, "Session name must be 2–80 characters");
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 72) {
      return sendError(res, 400, "Expiration must be between 1 and 72 hours");
    }
    if (typeof recordingRequested !== "boolean") return sendError(res, 400, "Recording selection must be true or false");

    const session = store.create(name, expiresInHours, recordingRequested);
    const origin = `${req.protocol}://${req.get("host")}`;
    res.status(201).json({
      session: await serializeSession(session),
      djUrl: `${origin}/s/${session.djToken}`,
      listenerUrl: `${origin}/s/${session.listenerToken}`,
    });
  });

  app.post("/api/admin/sessions/:id/end", requireAdmin(config), async (req, res) => {
    const session = store.setState(String(req.params.id), "ended", "owner");
    if (!session) return sendError(res, 404, "Session not found");
    res.json({ session: await serializeSession(session) });
  });

  app.get("/api/admin/sessions/:id/listen", requireAdmin(config), (req, res) => {
    const session = store.get(String(req.params.id));
    if (!session) return sendError(res, 404, "Session not found");
    const replay = isReplaySession(session);
    if ((session.state === "ended" || session.state === "expired") && !replay) {
      return sendError(res, 410, "This session is no longer active");
    }

    const exp = replay ? expiresIn(12 * 60 * 60) : Math.floor(new Date(session.expiresAt).getTime() / 1000);
    const cookie = signToken({
      kind: "invite",
      role: "listener",
      sessionId: session.id,
      listenerId: randomUUID(),
      exp,
    }, config.tokenSecret);
    res.cookie(INVITE_COOKIE, cookie, cookieOptions(config, Math.max(0, exp * 1000 - Date.now())));
    res.redirect("/listen");
  });

  app.get("/api/admin/recordings", requireAdmin(config), async (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 12);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
      return sendError(res, 400, "Recording page size must be between 1 and 50");
    }
    const cursor = decodeCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) return sendError(res, 400, "Invalid recording cursor");
    const page = store.listRecordingPage(requestedLimit, cursor);
    const sessions = await Promise.all(page.sessions.map(async (session) => {
      const listenerCount = session.state === "ended" || session.state === "expired" ? 0 :
        await getListenerCount(config, session.mediaPath);
      return serializeSession(session, listenerCount);
    }));
    res.json({
      recordings: sessions,
      nextCursor: page.hasMore && page.sessions.length > 0 ? encodeCursor(page.sessions.at(-1) as RelaySession) : null,
    });
  });

  app.delete("/api/admin/recordings/:sessionId", requireAdmin(config), async (req, res) => {
    const session = store.get(String(req.params.sessionId));
    if (!session || !session.recordingRequested) return sendError(res, 404, "Recording not found");
    if (session.recordingDeletedAt) return res.sendStatus(204);
    if (!isReplaySession(session)) return sendError(res, 409, "Active recordings cannot be deleted");
    try {
      const { summary } = await recordingDetails(session, recordings);
      if (summary.status === "finalizing") return sendError(res, 409, "This recording is still finalizing");
      await recordings.deleteAll(session.mediaPath);
      store.markRecordingDeleted(session.id);
      res.sendStatus(204);
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : "Recording deletion failed");
    }
  });

  app.post("/api/invite/exchange", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    let result = store.exchangeInvite(token);
    if (!result) {
      const sharedInvite = verifyToken(token, config.tokenSecret);
      if (sharedInvite?.kind === "share" && sharedInvite.role === "listener" && sharedInvite.sessionId) {
        const session = store.get(sharedInvite.sessionId);
        if (session && session.state !== "ended" && session.state !== "expired") {
          result = { session, role: "listener" };
        }
      }
    }
    if (!result) return sendError(res, 404, "This invite is invalid, expired, or ended");

    const replay = isReplaySession(result.session);
    const exp = replay ? expiresIn(12 * 60 * 60) : Math.floor(new Date(result.session.expiresAt).getTime() / 1000);
    const existingInvite = invitePayload(req, config);
    const listenerId = result.role === "listener" ?
      (existingInvite?.role === "listener" && existingInvite.sessionId === result.session.id && existingInvite.listenerId ?
        existingInvite.listenerId : randomUUID()) : undefined;
    const cookie = signToken({
      kind: "invite",
      role: result.role,
      sessionId: result.session.id,
      listenerId,
      exp,
    }, config.tokenSecret);
    res.cookie(INVITE_COOKIE, cookie, cookieOptions(config, Math.max(0, exp * 1000 - Date.now())));
    res.json({
      role: result.role,
      session: await serializeSession(result.session),
      destination: result.role === "dj" ? "/broadcast" : "/listen",
    });
  });

  app.get("/api/session", requireInvite(config, store), async (_req, res) => {
    const invite = res.locals.invite as TokenPayload;
    store.endStaleSessions(config.djDisconnectGraceMs);
    let session = store.get((res.locals.session as RelaySession).id) as RelaySession;
    if (invite.role === "dj" && session.state !== "ended" && session.state !== "expired") {
      store.touchDj(session.id);
      session = store.get(session.id) as RelaySession;
    }
    const listenerCount = await getListenerCount(config, session.mediaPath);
    res.json({ role: invite.role, session: await serializeSession(session, listenerCount) });
  });

  app.post("/api/session/media-token", requireInvite(config, store), (req, res) => {
    store.endStaleSessions(config.djDisconnectGraceMs);
    const session = store.get((res.locals.session as RelaySession).id) as RelaySession;
    const invite = res.locals.invite as TokenPayload;
    if (session.state === "ended" || session.state === "expired") return sendError(res, 410, "This broadcast has ended");
    const sessionExp = Math.floor(new Date(session.expiresAt).getTime() / 1000);
    let listenerId = invite.listenerId;
    if (invite.role === "listener" && !listenerId) {
      listenerId = randomUUID();
      const upgradedInvite = signToken({ ...invite, listenerId }, config.tokenSecret);
      res.cookie(INVITE_COOKIE, upgradedInvite, cookieOptions(config, Math.max(0, invite.exp * 1000 - Date.now())));
    }
    const token = signToken({
      kind: "media",
      role: invite.role,
      sessionId: session.id,
      listenerId,
      path: session.mediaPath,
      exp: Math.min(sessionExp, expiresIn(12 * 60 * 60)),
    }, config.tokenSecret);
    res.json({
      token,
      path: session.mediaPath,
      endpoint: `${config.publicMediaBase.replace(/\/$/, "")}/${session.mediaPath}/${invite.role === "dj" ? "whip" : "whep"}`,
    });
  });

  app.post("/api/session/share-link", requireInvite(config, store), (req, res) => {
    const invite = res.locals.invite as TokenPayload;
    if (invite.role !== "listener") return sendError(res, 403, "Only listeners can create a listener invite");
    store.endStaleSessions(config.djDisconnectGraceMs);
    const session = store.get((res.locals.session as RelaySession).id);
    if (!session || session.state === "ended" || session.state === "expired") {
      return sendError(res, 410, "This broadcast has ended");
    }

    const token = signToken({
      kind: "share",
      role: "listener",
      sessionId: session.id,
      exp: Math.floor(new Date(session.expiresAt).getTime() / 1000),
    }, config.tokenSecret);
    const origin = `${req.protocol}://${req.get("host")}`;
    res.json({ url: `${origin}/s/${token}` });
  });

  app.get("/api/session/recording", requireInvite(config, store), async (_req, res) => {
    const invite = res.locals.invite as TokenPayload;
    if (invite.role !== "listener") return sendError(res, 403, "Listener access required");
    const session = store.get((res.locals.session as RelaySession).id);
    if (!session || !isReplaySession(session)) return sendError(res, 409, "This session does not have a replay");
    const { summary, parts } = await recordingDetails(session, recordings);
    res.json({
      recording: summary,
      parts: parts.map((part, index) => ({
        index,
        start: part.start,
        durationSeconds: part.durationSeconds,
        url: `/api/session/recording/parts/${index}`,
        downloadUrl: `/api/session/recording/parts/${index}?download=1`,
      })),
    });
  });

  app.get("/api/session/recording/parts/:index", requireInvite(config, store), async (req, res) => {
    const invite = res.locals.invite as TokenPayload;
    if (invite.role !== "listener") return sendError(res, 403, "Listener access required");
    const session = store.get((res.locals.session as RelaySession).id);
    if (!session || !isReplaySession(session) || session.recordingDeletedAt) {
      return sendError(res, 410, "This recording is no longer available");
    }
    const index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 0) return sendError(res, 404, "Recording part not found");
    await streamRecordingPart(session, index, req.query.download === "1", res);
  });

  app.post("/api/session/state", requireInvite(config, store), async (req, res) => {
    const session = res.locals.session as RelaySession;
    const invite = res.locals.invite as TokenPayload;
    if (invite.role !== "dj") return sendError(res, 403, "Only the DJ can change broadcast state");
    const requested = req.body?.state;
    if (requested !== "live" && requested !== "interrupted" && requested !== "ended") {
      return sendError(res, 400, "Invalid broadcast state");
    }
    if (requested !== "ended") store.endStaleSessions(config.djDisconnectGraceMs);
    const updated = store.setState(session.id, requested);
    if (requested === "live" && !session.startedAt && updated?.startedAt) {
      const token = signToken({
        kind: "share",
        role: "listener",
        sessionId: updated.id,
        exp: Math.floor(new Date(updated.expiresAt).getTime() / 1000),
      }, config.tokenSecret);
      const origin = `${req.protocol}://${req.get("host")}`;
      try {
        await discordNotifier({
          webhookUrl: config.discordWebhookUrl,
          sessionId: updated.id,
          sessionName: updated.name,
          listenerUrl: `${origin}/s/${token}`,
        });
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "Discord session notifier failed unexpectedly",
          sessionId: updated.id,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
      }
    }
    res.json({ session: updated ? await serializeSession(updated) : null });
  });

  app.post("/internal/mediamtx-auth", (req, res) => {
    const secret = typeof req.query.secret === "string" ? req.query.secret : "";
    if (!safeEqual(secret, config.mediaAuthSecret)) return res.sendStatus(403);

    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const action = req.body?.action;
    const path = req.body?.path;
    const payload = verifyToken(token, config.tokenSecret);
    if (!payload || payload.kind !== "media" || payload.path !== path || !payload.sessionId) return res.sendStatus(403);

    store.endStaleSessions(config.djDisconnectGraceMs);
    const session = store.get(payload.sessionId);
    if (!session || session.state === "ended" || session.state === "expired") return res.sendStatus(403);
    const allowed = (payload.role === "dj" && action === "publish") ||
      (payload.role === "listener" && action === "read");
    if (allowed && payload.role === "dj") store.touchDj(session.id);
    if (allowed && payload.role === "listener" && payload.listenerId) {
      store.recordListener(session.id, payload.listenerId);
    }
    return res.sendStatus(allowed ? 200 : 403);
  });

  return app;
}
