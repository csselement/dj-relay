import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import type { AppConfig } from "./config.js";
import { SessionStore, type RelaySession } from "./db.js";
import { safeEqual, signToken, verifyToken, type TokenPayload } from "./security.js";

const ADMIN_COOKIE = "djrelay_admin";
const INVITE_COOKIE = "djrelay_invite";

type AppDependencies = {
  config: AppConfig;
  store: SessionStore;
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
    if (!adminPayload(req, config)) return sendError(res, 401, "Owner sign-in required");
    next();
  };
}

function requireInvite(config: AppConfig, store: SessionStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const payload = invitePayload(req, config);
    if (!payload?.sessionId || !payload.role) return sendError(res, 401, "Invite link required");
    const session = store.get(payload.sessionId);
    if (!session || session.state === "expired") return sendError(res, 410, "This session has expired");
    res.locals.invite = payload;
    res.locals.session = session;
    next();
  };
}

function publicSession(session: RelaySession, listenerCount: number, uniqueListenerCount: number, disconnectGraceMs: number) {
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
  };
}

export function createApp({ config, store }: AppDependencies) {
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
      return sendError(res, 401, "Incorrect owner password");
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

  app.get("/api/admin/sessions", requireAdmin(config), async (_req, res) => {
    store.endStaleSessions(config.djDisconnectGraceMs);
    const sessions = await Promise.all(store.list().map(async (session) => {
      const listenerCount = session.state === "ended" || session.state === "expired" ? 0 :
        await getListenerCount(config, session.mediaPath);
      return publicSession(session, listenerCount, store.uniqueListenerCount(session.id), config.djDisconnectGraceMs);
    }));
    res.json({ sessions });
  });

  app.post("/api/admin/sessions", requireAdmin(config), (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const expiresInHours = Number(req.body?.expiresInHours ?? 8);
    if (name.length < 2 || name.length > 80) return sendError(res, 400, "Session name must be 2–80 characters");
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 72) {
      return sendError(res, 400, "Expiration must be between 1 and 72 hours");
    }

    const session = store.create(name, expiresInHours);
    const origin = `${req.protocol}://${req.get("host")}`;
    res.status(201).json({
      session: publicSession(session, 0, 0, config.djDisconnectGraceMs),
      djUrl: `${origin}/s/${session.djToken}`,
      listenerUrl: `${origin}/s/${session.listenerToken}`,
    });
  });

  app.post("/api/admin/sessions/:id/end", requireAdmin(config), (req, res) => {
    const session = store.setState(String(req.params.id), "ended", "owner");
    if (!session) return sendError(res, 404, "Session not found");
    res.json({ session: publicSession(session, 0, store.uniqueListenerCount(session.id), config.djDisconnectGraceMs) });
  });

  app.get("/api/admin/sessions/:id/listen", requireAdmin(config), (req, res) => {
    const session = store.get(String(req.params.id));
    if (!session) return sendError(res, 404, "Session not found");
    if (session.state === "ended" || session.state === "expired") {
      return sendError(res, 410, "This session is no longer active");
    }

    const exp = Math.floor(new Date(session.expiresAt).getTime() / 1000);
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

  app.post("/api/invite/exchange", (req, res) => {
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

    const exp = Math.floor(new Date(result.session.expiresAt).getTime() / 1000);
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
      session: publicSession(result.session, 0, store.uniqueListenerCount(result.session.id), config.djDisconnectGraceMs),
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
    res.json({ role: invite.role, session: publicSession(session, listenerCount, store.uniqueListenerCount(session.id), config.djDisconnectGraceMs) });
  });

  app.post("/api/session/media-token", requireInvite(config, store), (req, res) => {
    store.endStaleSessions(config.djDisconnectGraceMs);
    const session = store.get((res.locals.session as RelaySession).id) as RelaySession;
    const invite = res.locals.invite as TokenPayload;
    if (session.state === "ended") return sendError(res, 410, "This broadcast has ended");
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

  app.post("/api/session/state", requireInvite(config, store), (req, res) => {
    const session = res.locals.session as RelaySession;
    const invite = res.locals.invite as TokenPayload;
    if (invite.role !== "dj") return sendError(res, 403, "Only the DJ can change broadcast state");
    const requested = req.body?.state;
    if (requested !== "live" && requested !== "interrupted" && requested !== "ended") {
      return sendError(res, 400, "Invalid broadcast state");
    }
    if (requested !== "ended") store.endStaleSessions(config.djDisconnectGraceMs);
    const updated = store.setState(session.id, requested);
    res.json({ session: updated ? publicSession(updated, 0, store.uniqueListenerCount(updated.id), config.djDisconnectGraceMs) : null });
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
