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
import { delayResponse, LoginAttemptLimiter } from "./loginLimiter.js";
import { MediaMtxControlClient, type MediaMtxControl, type RecordingStorageStatus } from "./recordingWatchdog.js";
import { TranscodeCapacityError, TranscodeScheduler } from "./transcodeScheduler.js";
import { transcodeToMp3, type Mp3Transcoder } from "./transcoding.js";

const ADMIN_COOKIE = "djrelay_admin";
const LEGACY_INVITE_COOKIE = "djrelay_invite";
const PREVIOUS_DJ_INVITE_COOKIE = "djrelay_dj_invite";
const PREVIOUS_LISTENER_INVITE_COOKIE = "djrelay_listener_invite";
const DJ_INVITE_COOKIE = "djrelay_dj_invite_v2";
const LISTENER_INVITE_COOKIE = "djrelay_listener_invite_v2";
type InviteTokenPayload = Extract<TokenPayload, { kind: "invite" }>;

type AppDependencies = {
  config: AppConfig;
  store: SessionStore;
  discordNotifier?: (announcement: DiscordSessionAnnouncement) => Promise<void>;
  recordings?: RecordingBackend;
  mp3Transcoder?: Mp3Transcoder;
  loginLimiter?: LoginAttemptLimiter;
  transcodeScheduler?: TranscodeScheduler;
  recordingGuard?: {
    canCreateRecording(): boolean;
    getStatus(): RecordingStorageStatus;
  };
  mediaMtx?: MediaMtxControl;
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

function sendError(res: Response, status: number, error: string, code?: string, retryAfterSeconds?: number): void {
  if (retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(status).json({ error, ...(code ? { code } : {}) });
}

async function mediaMtxAvailable(config: AppConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.mediaMtxApiUrl}/v3/info`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
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

function roleCookie(role: "dj" | "listener"): string {
  return role === "dj" ? DJ_INVITE_COOKIE : LISTENER_INVITE_COOKIE;
}

function previousRoleCookie(role: "dj" | "listener"): string {
  return role === "dj" ? PREVIOUS_DJ_INVITE_COOKIE : PREVIOUS_LISTENER_INVITE_COOKIE;
}

function verifiedInviteCookie(req: Request, config: AppConfig, name: string): InviteTokenPayload | null {
  const payload = verifyToken(req.cookies?.[name], config.tokenSecret);
  return payload?.kind === "invite" ? payload : null;
}

function invitePayload(req: Request, config: AppConfig, expectedRole?: "dj" | "listener"): InviteTokenPayload | null {
  if (expectedRole) {
    const roleInvite = verifiedInviteCookie(req, config, roleCookie(expectedRole));
    if (roleInvite?.role === expectedRole) return roleInvite;
    const previousRoleInvite = verifiedInviteCookie(req, config, previousRoleCookie(expectedRole));
    if (previousRoleInvite?.role === expectedRole) return previousRoleInvite;
    const legacyInvite = verifiedInviteCookie(req, config, LEGACY_INVITE_COOKIE);
    return legacyInvite?.role === expectedRole ? legacyInvite : null;
  }

  const requestedRole = req.get("X-Discus-Role");
  if (requestedRole === "dj" || requestedRole === "listener") {
    return invitePayload(req, config, requestedRole);
  }
  const djInvite = verifiedInviteCookie(req, config, DJ_INVITE_COOKIE);
  const listenerInvite = verifiedInviteCookie(req, config, LISTENER_INVITE_COOKIE);
  if (djInvite && !listenerInvite) return djInvite;
  if (listenerInvite && !djInvite) return listenerInvite;
  const previousDjInvite = verifiedInviteCookie(req, config, PREVIOUS_DJ_INVITE_COOKIE);
  const previousListenerInvite = verifiedInviteCookie(req, config, PREVIOUS_LISTENER_INVITE_COOKIE);
  if (previousDjInvite && !previousListenerInvite) return previousDjInvite;
  if (previousListenerInvite && !previousDjInvite) return previousListenerInvite;
  return verifiedInviteCookie(req, config, LEGACY_INVITE_COOKIE);
}

function requireAdmin(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!adminPayload(req, config)) return sendError(res, 401, "Producer sign-in required");
    next();
  };
}

function requireInvite(config: AppConfig, store: SessionStore, expectedRole?: "dj" | "listener") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const payload = invitePayload(req, config, expectedRole);
    if (!payload?.sessionId || !payload.role) return sendError(res, 401, "Invite link required");
    const session = store.get(payload.sessionId);
    if (!session || (session.state === "expired" && payload.role === "dj" && !payload.producerPreview)) {
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
    terminationCode: session.terminationCode,
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
  recordings = new MediaMtxRecordingBackend(
    config.mediaMtxPlaybackUrl,
    config.mediaMtxApiUrl,
    config.recordingsPath,
    config.recordingPlaybackPath,
  ),
  mp3Transcoder = transcodeToMp3,
  loginLimiter = new LoginAttemptLimiter({
    windowMs: config.loginWindowMs,
    maxFailuresPerClient: config.loginClientFailureLimit,
    maxFailuresGlobal: config.loginGlobalFailureLimit,
    maxTrackedClients: config.loginTrackedClientLimit,
    baseDelayMs: 250,
    maxDelayMs: 4_000,
  }),
  transcodeScheduler = new TranscodeScheduler({
    maxActive: config.transcodeMaxActive,
    maxQueued: config.transcodeMaxQueued,
    queueTimeoutMs: config.transcodeQueueWaitMs,
    jobTimeoutMs: config.transcodeTimeoutMs,
    onEvent: (event) => console.log(JSON.stringify({ level: "warn", event: `transcode_${event.type}`, ...event })),
  }),
  recordingGuard = {
    canCreateRecording: () => true,
    getStatus: () => ({
      state: "ok", initialized: true, usedBytes: 0, maxBytes: config.recordingArchiveMaxBytes,
      freeBytes: null, sessionMaxBytes: config.recordingSessionMaxBytes, lastSuccessfulScanAt: null,
    }),
  },
  mediaMtx = new MediaMtxControlClient(config.mediaMtxApiUrl),
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
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
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

  async function endSessionsWithoutPublishers(): Promise<number> {
    const cutoff = Date.now() - config.djDisconnectGraceMs;
    const hasStaleSession = store.list().some((session) => {
      if (session.state !== "live" && session.state !== "interrupted") return false;
      const lastLiveAt = session.state === "interrupted" ? session.interruptedAt ?? session.djLastSeenAt : session.djLastSeenAt;
      return !lastLiveAt || new Date(lastLiveAt).getTime() <= cutoff;
    });
    if (!hasStaleSession) return 0;
    try {
      const paths = await mediaMtx.listPaths();
      const activePublisherPaths = new Set(paths
        .filter((path) => Boolean(path.sourceType && path.sourceId))
        .map((path) => path.name));
      return store.endStaleSessions(config.djDisconnectGraceMs, new Date(), activePublisherPaths);
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        event: "session_liveness_scan_failed",
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      return 0;
    }
  }

  async function streamRecordingPart(
    session: RelaySession,
    index: number,
    mp3Mode: "none" | "playback" | "download",
    requestedRange: string | undefined,
    res: Response,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", abort);
    try {
      const stream = async (signal: AbortSignal) => {
        const parts = await recordings.listParts(session.mediaPath);
        const part = parts[index];
        if (!part) return sendError(res, 404, "Recording part not found");
        const upstream = await recordings.fetchPart(
          session.mediaPath,
          part,
          signal,
          mp3Mode === "none" ? requestedRange : undefined,
        );
        const acceptRanges = upstream.headers.get("accept-ranges");
        const contentRange = upstream.headers.get("content-range");
        if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
        if (contentRange) res.setHeader("Content-Range", contentRange);
        if (upstream.status === 416) {
          res.status(416).end();
          return;
        }
        if (!upstream.ok || !upstream.body) return sendError(res, 502, "Recording playback is temporarily unavailable");
        res.status(upstream.status);
        res.setHeader("Cache-Control", "private, no-store");
        const safeName = session.name.normalize("NFKD")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "discus-recording";
        const input = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>);
        const upstreamType = upstream.headers.get("content-type") ?? "video/mp4";
        const finalizedMp3 = upstreamType.toLowerCase().startsWith("audio/mpeg");
        if (mp3Mode !== "none" && !finalizedMp3) {
          const filename = parts.length > 1 ? `${safeName}-part-${index + 1}.mp3` : `${safeName}.mp3`;
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader(
            "Content-Disposition",
            mp3Mode === "download" ? `attachment; filename="${filename}"` : "inline",
          );
          await mp3Transcoder(input, res, signal);
          return;
        }
        res.setHeader("Content-Type", upstreamType);
        if (mp3Mode === "download") {
          const filename = parts.length > 1 ? `${safeName}-part-${index + 1}.mp3` : `${safeName}.mp3`;
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        } else {
          res.setHeader("Content-Disposition", "inline");
        }
        const contentLength = upstream.headers.get("content-length");
        if (contentLength) res.setHeader("Content-Length", contentLength);
        await pipeline(input, res);
      };
      if (mp3Mode !== "none") await transcodeScheduler.run(controller.signal, stream);
      else await stream(controller.signal);
    } catch (error) {
      if (error instanceof TranscodeCapacityError && error.code !== "aborted" && !res.headersSent) {
        return sendError(res, 503, error.message, `transcode_${error.code}`, 10);
      }
      if (!controller.signal.aborted && !res.headersSent) {
        sendError(res, 502, error instanceof Error ? error.message : "Recording playback failed");
      } else if (!controller.signal.aborted && !res.writableEnded) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      res.removeListener("close", abort);
    }
  }

  app.get("/api/health", async (_req, res) => {
    const mediaMtx = await mediaMtxAvailable(config);
    res.json({ ok: true, mediaMtx });
  });

  app.post("/api/admin/login", async (req, res) => {
    const clientKey = req.ip || "unknown";
    const admission = loginLimiter.check(clientKey);
    if (!admission.allowed) {
      console.log(JSON.stringify({
        level: "warn",
        event: "producer_login_throttled",
        scope: admission.scope,
        retryAfterSeconds: admission.retryAfterSeconds,
      }));
      return sendError(res, 429, "Too many sign-in attempts. Try again later.", "login_throttled", admission.retryAfterSeconds);
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || !safeEqual(password, config.adminPassword)) {
      const failure = loginLimiter.recordFailure(clientKey);
      await delayResponse(failure.delayMs);
      return sendError(res, 401, "Incorrect producer password");
    }
    loginLimiter.clearClient(clientKey);
    const token = signToken({ kind: "admin", exp: expiresIn(12 * 60 * 60) }, config.tokenSecret);
    res.cookie(ADMIN_COOKIE, token, cookieOptions(config, 12 * 60 * 60 * 1000));
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", requireAdmin(config), (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/admin/me", (req, res) => {
    res.json({ authenticated: Boolean(adminPayload(req, config)) });
  });

  app.get("/api/admin/status", requireAdmin(config), async (_req, res) => {
    const storage = recordingGuard.getStatus();
    res.json({
      mediaMtx: await mediaMtxAvailable(config),
      recording: {
        state: storage.state,
        usedBytes: storage.usedBytes,
        maxBytes: storage.maxBytes,
        freeBytes: storage.freeBytes,
        sessionMaxBytes: storage.sessionMaxBytes,
        lastSuccessfulScanAt: storage.lastSuccessfulScanAt,
      },
      transcode: transcodeScheduler.status(),
    });
  });

  app.get("/api/admin/sessions", requireAdmin(config), async (req, res) => {
    await endSessionsWithoutPublishers();
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
    if (recordingRequested && !recordingGuard.canCreateRecording()) {
      return sendError(
        res,
        503,
        "Recording is unavailable. Delete archived sessions to restore recording capacity, or create an unrecorded session.",
        "recording_unavailable",
      );
    }

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
    const archived = session.state === "ended" || session.state === "expired";
    const exp = archived ? expiresIn(12 * 60 * 60) : Math.floor(new Date(session.expiresAt).getTime() / 1000);
    const cookie = signToken({
      kind: "invite",
      role: "listener",
      sessionId: session.id,
      listenerId: randomUUID(),
      producerPreview: true,
      exp,
    }, config.tokenSecret);
    res.cookie(LISTENER_INVITE_COOKIE, cookie, cookieOptions(config, Math.max(0, exp * 1000 - Date.now())));
    res.redirect("/listen");
  });

  app.delete("/api/admin/sessions/:id", requireAdmin(config), async (req, res) => {
    const session = store.get(String(req.params.id));
    if (!session) return sendError(res, 404, "Session not found");
    if (session.state !== "ended" && session.state !== "expired") {
      return sendError(res, 409, "Active sessions must be ended before deletion");
    }

    try {
      if (session.recordingRequested && !session.recordingDeletedAt) {
        const { summary } = await recordingDetails(session, recordings);
        if (summary.status === "finalizing") return sendError(res, 409, "This recording is still finalizing");
        await recordings.deleteAll(session.mediaPath);
      }
      store.remove(session.id);
      res.sendStatus(204);
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : "Session deletion failed");
    }
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

  app.post("/api/invite/exchange", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    let result = store.exchangeInvite(token);
    if (!result) {
      const sharedInvite = verifyToken(token, config.tokenSecret);
      if (sharedInvite?.kind === "share" && sharedInvite.role === "listener" && sharedInvite.sessionId) {
        const session = store.get(sharedInvite.sessionId);
        if (session) result = { session, role: "listener" };
      }
    }
    if (!result) return sendError(res, 404, "This invite is invalid or no longer available");

    const concluded = result.session.state === "ended" || result.session.state === "expired";
    const exp = concluded ? expiresIn(12 * 60 * 60) : Math.floor(new Date(result.session.expiresAt).getTime() / 1000);
    const existingInvite = invitePayload(req, config, result.role);
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
    res.cookie(roleCookie(result.role), cookie, cookieOptions(config, Math.max(0, exp * 1000 - Date.now())));
    res.json({
      role: result.role,
      session: await serializeSession(result.session),
      destination: result.role === "dj" ? "/broadcast" : "/listen",
    });
  });

  app.get("/api/session", requireInvite(config, store), async (_req, res) => {
    const invite = res.locals.invite as InviteTokenPayload;
    await endSessionsWithoutPublishers();
    let session = store.get((res.locals.session as RelaySession).id) as RelaySession;
    if (invite.role === "dj" && session.state !== "ended" && session.state !== "expired") {
      store.touchDj(session.id);
      session = store.get(session.id) as RelaySession;
    }
    const listenerCount = await getListenerCount(config, session.mediaPath);
    res.json({ role: invite.role, session: await serializeSession(session, listenerCount) });
  });

  app.post("/api/session/media-token", requireInvite(config, store), async (req, res) => {
    await endSessionsWithoutPublishers();
    const session = store.get((res.locals.session as RelaySession).id) as RelaySession;
    const invite = res.locals.invite as InviteTokenPayload;
    if (session.state === "ended" || session.state === "expired") return sendError(res, 410, "This broadcast has ended");
    const sessionExp = Math.floor(new Date(session.expiresAt).getTime() / 1000);
    let listenerId = invite.listenerId;
    if (invite.role === "listener" && !listenerId) {
      listenerId = randomUUID();
      const upgradedInvite = signToken({ ...invite, listenerId }, config.tokenSecret);
      res.cookie(LISTENER_INVITE_COOKIE, upgradedInvite, cookieOptions(config, Math.max(0, invite.exp * 1000 - Date.now())));
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

  app.post("/api/session/share-link", requireInvite(config, store), async (req, res) => {
    const invite = res.locals.invite as InviteTokenPayload;
    if (invite.role !== "listener" && invite.role !== "dj") {
      return sendError(res, 403, "DJ or listener access required");
    }
    await endSessionsWithoutPublishers();
    const session = store.get((res.locals.session as RelaySession).id);
    if (!session) return sendError(res, 410, "This session is no longer available");

    const token = signToken({
      kind: "share",
      role: "listener",
      sessionId: session.id,
    }, config.tokenSecret);
    const origin = `${req.protocol}://${req.get("host")}`;
    res.json({ url: `${origin}/s/${token}` });
  });

  app.get("/api/session/recording", requireInvite(config, store, "listener"), async (_req, res) => {
    const invite = res.locals.invite as InviteTokenPayload;
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
        downloadUrl: `/api/session/recording/parts/${index}?download=mp3`,
      })),
    });
  });

  app.get("/api/session/recording/parts/:index", requireInvite(config, store, "listener"), async (req, res) => {
    const invite = res.locals.invite as InviteTokenPayload;
    if (invite.role !== "listener") return sendError(res, 403, "Listener access required");
    const session = store.get((res.locals.session as RelaySession).id);
    if (!session || !isReplaySession(session) || session.recordingDeletedAt) {
      return sendError(res, 410, "This recording is no longer available");
    }
    const index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 0) return sendError(res, 404, "Recording part not found");
    const downloadMp3 = req.query.download === "mp3" || req.query.download === "1";
    const playbackMp3 = req.query.format === "mp3";
    await streamRecordingPart(
      session,
      index,
      downloadMp3 ? "download" : playbackMp3 ? "playback" : "none",
      req.get("range"),
      res,
    );
  });

  app.post("/api/session/state", requireInvite(config, store), async (req, res) => {
    const session = res.locals.session as RelaySession;
    const invite = res.locals.invite as InviteTokenPayload;
    if (invite.role !== "dj") return sendError(res, 403, "Only the DJ can change broadcast state");
    const requested = req.body?.state;
    if (requested !== "live" && requested !== "interrupted" && requested !== "ended") {
      return sendError(res, 400, "Invalid broadcast state");
    }
    if (requested !== "ended") await endSessionsWithoutPublishers();
    const updated = store.setState(session.id, requested);
    if (requested === "live" && !session.startedAt && updated?.startedAt) {
      const token = signToken({
        kind: "share",
        role: "listener",
        sessionId: updated.id,
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

  app.post("/internal/mediamtx-auth", async (req, res) => {
    const secret = typeof req.query.secret === "string" ? req.query.secret : "";
    if (!safeEqual(secret, config.mediaAuthSecret)) return res.sendStatus(403);

    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const action = req.body?.action;
    const path = req.body?.path;
    const payload = verifyToken(token, config.tokenSecret);
    if (!payload || payload.kind !== "media" || payload.path !== path || !payload.sessionId) return res.sendStatus(403);

    await endSessionsWithoutPublishers();
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
