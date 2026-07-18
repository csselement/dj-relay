import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./db.js";
import type { DiscordSessionAnnouncement } from "./discord.js";
import type { RecordingBackend, RecordingPart } from "./recordings.js";

function testApp(
  discordNotifier?: (announcement: DiscordSessionAnnouncement) => Promise<void>,
  recordings?: RecordingBackend,
) {
  const config = loadConfig({
    databasePath: ":memory:",
    adminPassword: "owner-test-password",
    tokenSecret: "unit-test-token-secret-with-more-than-32-bytes",
    mediaAuthSecret: "unit-test-media-auth-secret",
    publicMediaBase: "/media",
    mediaMtxApiUrl: "http://127.0.0.1:1",
    secureCookies: false,
  });
  const store = new SessionStore(":memory:");
  return { app: createApp({ config, store, discordNotifier, recordings }), store, config };
}

function recordingBackend(parts: RecordingPart[] = []) {
  const deleted: string[] = [];
  const backend: RecordingBackend = {
    listParts: async () => parts,
    fetchPart: async () => new Response(Uint8Array.from([1, 2, 3, 4]), { headers: { "Content-Type": "video/mp4" } }),
    deleteAll: async (path) => { deleted.push(path); },
  };
  return { backend, deleted };
}

describe("Discus API", () => {
  const stores: SessionStore[] = [];
  afterEach(() => stores.splice(0).forEach((store) => store.close()));

  it("requires owner authentication and creates private role links", async () => {
    const { app, store } = testApp(); stores.push(store);
    await request(app).get("/api/admin/sessions").expect(401);
    await request(app).post("/api/admin/login").send({ password: "wrong" }).expect(401);

    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" }).expect(200);
    const created = await owner.post("/api/admin/sessions")
      .set("X-Forwarded-Proto", "https")
      .send({ name: "Saturday Night Relay" })
      .expect(201);

    expect(created.body.djUrl).toMatch(/^https:\/\//);
    expect(created.body.listenerUrl).toMatch(/^https:\/\//);
    expect(created.body.djUrl).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    expect(new Date(created.body.session.expiresAt).getTime() - new Date(created.body.session.createdAt).getTime()).toBe(8 * 60 * 60 * 1000);
    expect(created.body.listenerUrl).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    expect(created.body.djUrl).not.toBe(created.body.listenerUrl);
    expect(store.list()).toHaveLength(1);
    expect(created.body.session.recording).toEqual({ requested: false, status: "off", durationSeconds: null, partCount: 0 });
  });

  it("records opted-in sessions and serves replay through the original listener link", async () => {
    const media = recordingBackend([
      { start: "2026-07-17T20:00:00Z", durationSeconds: 12.5 },
      { start: "2026-07-17T20:01:00Z", durationSeconds: 8.25 },
    ]);
    const { app, store } = testApp(undefined, media.backend); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    await owner.post("/api/admin/sessions").send({ name: "Invalid recording", recordingRequested: "yes" }).expect(400);
    const created = await owner.post("/api/admin/sessions")
      .send({ name: "Recorded relay", recordingRequested: true })
      .expect(201);
    expect(created.body.session.mediaPath).toMatch(/^recording-session-/);
    expect(created.body.session.recording.status).toBe("scheduled");

    const dj = request.agent(app);
    await dj.post("/api/invite/exchange").send({ token: created.body.djUrl.split("/").at(-1) }).expect(200);
    await dj.post("/api/session/state").send({ state: "live" }).expect(200);
    await owner.delete(`/api/admin/recordings/${created.body.session.id}`).expect(409);

    const listenerToken = created.body.listenerUrl.split("/").at(-1);
    await dj.post("/api/session/state").send({ state: "ended" }).expect(200);
    await request(app).post("/api/invite/exchange").send({ token: created.body.djUrl.split("/").at(-1) }).expect(404);

    const replay = request.agent(app);
    await replay.post("/api/invite/exchange").send({ token: listenerToken }).expect(200);
    await replay.get("/api/session/recording").expect(200).expect(({ body }) => {
      expect(body.recording).toEqual({ requested: true, status: "ready", durationSeconds: 20.75, partCount: 2 });
      expect(body.parts.map((part: { url: string }) => part.url)).toEqual([
        "/api/session/recording/parts/0",
        "/api/session/recording/parts/1",
      ]);
      expect(body.parts.map((part: { downloadUrl: string }) => part.downloadUrl)).toEqual([
        "/api/session/recording/parts/0?download=1",
        "/api/session/recording/parts/1?download=1",
      ]);
    });
    await replay.get("/api/session/recording/parts/0").expect(200).expect("Content-Type", /video\/mp4/);
    await replay.get("/api/session/recording/parts/0?download=1")
      .expect(200)
      .expect("Content-Disposition", "attachment; filename=\"Recorded-relay-part-1.mp4\"");
    await owner.get(`/api/admin/sessions/${created.body.session.id}/listen`).expect(302).expect("Location", "/listen");
    await owner.get("/api/admin/recordings?limit=12").expect(200).expect(({ body }) => {
      expect(body.recordings).toHaveLength(1);
      expect(body.recordings[0].recording).toMatchObject({ status: "ready", partCount: 2 });
    });

    await owner.delete(`/api/admin/recordings/${created.body.session.id}`).expect(204);
    expect(media.deleted).toEqual([created.body.session.mediaPath]);
    expect(store.get(created.body.session.id)?.recordingDeletedAt).toBeTruthy();
    await owner.delete(`/api/admin/recordings/${created.body.session.id}`).expect(204);
    await replay.get("/api/session/recording").expect(200).expect(({ body }) => {
      expect(body.recording.status).toBe("deleted");
    });
    await replay.get("/api/session/recording/parts/0").expect(410);
  });

  it("allows an ended recording invite to show unavailable even if broadcasting never started", async () => {
    const media = recordingBackend();
    const { app, store } = testApp(undefined, media.backend); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions")
      .send({ name: "Unstarted recording", recordingRequested: true })
      .expect(201);
    await owner.post(`/api/admin/sessions/${created.body.session.id}/end`).expect(200);

    const replay = request.agent(app);
    await replay.post("/api/invite/exchange")
      .send({ token: created.body.listenerUrl.split("/").at(-1) })
      .expect(200);
    await replay.get("/api/session/recording").expect(200).expect(({ body }) => {
      expect(body.recording.status).toBe("finalizing");
    });
  });

  it("lets an authenticated producer open active and archived sessions in the listener module", async () => {
    const { app, store } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Owner preview", expiresInHours: 4 });
    const sessionId = created.body.session.id;

    await request(app).get(`/api/admin/sessions/${sessionId}/listen`).expect(401);
    await owner.get(`/api/admin/sessions/${sessionId}/listen`).expect(302).expect("Location", "/listen");
    await owner.get("/api/session").expect(200).expect(({ body }) => {
      expect(body.role).toBe("listener");
      expect(body.session.id).toBe(sessionId);
    });

    await owner.post(`/api/admin/sessions/${sessionId}/end`).expect(200);
    await owner.get(`/api/admin/sessions/${sessionId}/listen`).expect(302).expect("Location", "/listen");
    await owner.get("/api/session").expect(200).expect(({ body }) => {
      expect(body.role).toBe("listener");
      expect(body.session).toMatchObject({ id: sessionId, state: "ended" });
    });

    const expired = await owner.post("/api/admin/sessions").send({ name: "Expired producer preview", expiresInHours: 4 });
    store.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), expired.body.session.id);
    await owner.get(`/api/admin/sessions/${expired.body.session.id}/listen`).expect(302).expect("Location", "/listen");
    await owner.get("/api/session").expect(200).expect(({ body }) => {
      expect(body.role).toBe("listener");
      expect(body.session).toMatchObject({ id: expired.body.session.id, state: "expired" });
    });
  });

  it("exchanges invites and limits media actions by role and path", async () => {
    const { app, store, config } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Relay", expiresInHours: 4 });
    const djToken = created.body.djUrl.split("/").at(-1);
    const listenerToken = created.body.listenerUrl.split("/").at(-1);

    const dj = request.agent(app);
    await dj.post("/api/invite/exchange").send({ token: djToken }).expect(200).expect(({ body }) => {
      expect(body.role).toBe("dj");
      expect(body.destination).toBe("/broadcast");
    });
    const djMedia = await dj.post("/api/session/media-token").expect(200);
    expect(djMedia.body.endpoint).toMatch(/\/media\/session-.+\/whip$/);

    const listener = request.agent(app);
    await listener.post("/api/invite/exchange").send({ token: listenerToken }).expect(200);
    const listenerMedia = await listener.post("/api/session/media-token").expect(200);
    expect(listenerMedia.body.endpoint).toMatch(/\/media\/session-.+\/whep$/);
    expect(store.uniqueListenerCount(created.body.session.id)).toBe(0);

    const authUrl = `/internal/mediamtx-auth?secret=${config.mediaAuthSecret}`;
    await request(app).post(authUrl).send({ token: djMedia.body.token, action: "publish", path: djMedia.body.path }).expect(200);
    await request(app).post(authUrl).send({ token: djMedia.body.token, action: "read", path: djMedia.body.path }).expect(403);
    await request(app).post(authUrl).send({ token: listenerMedia.body.token, action: "read", path: listenerMedia.body.path }).expect(200);
    await request(app).post(authUrl).send({ token: listenerMedia.body.token, action: "read", path: listenerMedia.body.path }).expect(200);
    expect(store.uniqueListenerCount(created.body.session.id)).toBe(1);

    const secondListener = request.agent(app);
    await secondListener.post("/api/invite/exchange").send({ token: listenerToken }).expect(200);
    const secondListenerMedia = await secondListener.post("/api/session/media-token").expect(200);
    await request(app).post(authUrl)
      .send({ token: secondListenerMedia.body.token, action: "read", path: secondListenerMedia.body.path })
      .expect(200);
    expect(store.uniqueListenerCount(created.body.session.id)).toBe(2);

    const sessions = await owner.get("/api/admin/sessions").expect(200);
    expect(sessions.body.sessions[0]).toMatchObject({ uniqueListenerCount: 2, listenerHistoryAvailable: true });
    await request(app).post(authUrl).send({ token: listenerMedia.body.token, action: "publish", path: listenerMedia.body.path }).expect(403);
    await request(app).post(authUrl).send({ token: listenerMedia.body.token, action: "read", path: "another-path" }).expect(403);
  });

  it("rejects listener state changes and revokes media after ending", async () => {
    const { app, store, config } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Relay", expiresInHours: 4 });
    const listenerToken = created.body.listenerUrl.split("/").at(-1);
    const listener = request.agent(app);
    await listener.post("/api/invite/exchange").send({ token: listenerToken });
    const media = await listener.post("/api/session/media-token");

    await listener.post("/api/session/state").send({ state: "ended" }).expect(403);
    await owner.post(`/api/admin/sessions/${created.body.session.id}/end`).expect(200);
    await request(app).post(`/internal/mediamtx-auth?secret=${config.mediaAuthSecret}`)
      .send({ token: media.body.token, action: "read", path: media.body.path }).expect(403);
  });

  it("lets the DJ end an active session immediately", async () => {
    const { app, store } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "DJ ending", expiresInHours: 4 });
    const djToken = created.body.djUrl.split("/").at(-1);
    const dj = request.agent(app);
    await dj.post("/api/invite/exchange").send({ token: djToken }).expect(200);

    await dj.post("/api/session/state").send({ state: "live" }).expect(200);
    expect(store.get(created.body.session.id)?.state).toBe("live");

    await dj.post("/api/session/state").send({ state: "ended" }).expect(200);
    expect(store.get(created.body.session.id)).toMatchObject({ state: "ended", endedReason: "dj" });
  });

  it("announces the first live transition once with a usable listener invite", async () => {
    const announcements: DiscordSessionAnnouncement[] = [];
    const { app, store, config } = testApp(async (announcement) => { announcements.push(announcement); });
    stores.push(store);
    config.discordWebhookUrl = "https://discord.com/api/webhooks/test/secret";
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Discord Relay", expiresInHours: 4 });
    const djToken = created.body.djUrl.split("/").at(-1);
    const dj = request.agent(app);
    await dj.post("/api/invite/exchange").send({ token: djToken }).expect(200);

    await dj.post("/api/session/state")
      .set("Host", "relay.example")
      .set("X-Forwarded-Proto", "https")
      .send({ state: "live" })
      .expect(200);

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({
      webhookUrl: config.discordWebhookUrl,
      sessionId: created.body.session.id,
      sessionName: "Discord Relay",
    });
    expect(announcements[0].listenerUrl).toMatch(/^https:\/\/relay\.example\/s\/[A-Za-z0-9_.-]+$/);

    const listener = request.agent(app);
    await listener.post("/api/invite/exchange")
      .send({ token: announcements[0].listenerUrl.split("/").at(-1) })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ role: "listener", destination: "/listen" });
        expect(body.session.id).toBe(created.body.session.id);
      });

    await dj.post("/api/session/state").send({ state: "live" }).expect(200);
    await dj.post("/api/session/state").send({ state: "interrupted" }).expect(200);
    await dj.post("/api/session/state").send({ state: "live" }).expect(200);
    expect(announcements).toHaveLength(1);
  });

  it("keeps the session live when the Discord notifier fails", async () => {
    const { app, store } = testApp(async () => { throw new Error("Discord unavailable"); });
    stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Fail-open relay", expiresInHours: 4 });
    const dj = request.agent(app);
    await dj.post("/api/invite/exchange").send({ token: created.body.djUrl.split("/").at(-1) });

    await dj.post("/api/session/state").send({ state: "live" }).expect(200).expect(({ body }) => {
      expect(body.session.state).toBe("live");
    });
    expect(store.get(created.body.session.id)?.state).toBe("live");
  });

  it("ends a stale active session when the owner list refreshes", async () => {
    const { app, store, config } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Disconnected DJ", expiresInHours: 4 });
    store.setState(created.body.session.id, "live");
    store.touchDj(created.body.session.id, new Date(Date.now() - config.djDisconnectGraceMs - 1));

    await owner.get("/api/admin/sessions").expect(200).expect(({ body }) => {
      expect(body.sessions[0]).toMatchObject({ id: created.body.session.id, state: "ended" });
    });
  });

  it("returns active sessions with a bounded page of inactive history", async () => {
    const { app, store } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    store.create("Active session", 4);
    for (let index = 0; index < 9; index += 1) {
      const inactive = store.create(`Ended session ${index + 1}`, 4);
      store.setState(inactive.id, "ended");
    }

    await owner.get("/api/admin/sessions?historyLimit=3").expect(200).expect(({ body }) => {
      expect(body.sessions.filter((session: { state: string }) => session.state === "ready")).toHaveLength(1);
      expect(body.sessions.filter((session: { state: string }) => session.state === "ended")).toHaveLength(3);
      expect(body.history).toEqual({ loaded: 3, total: 9, hasMore: true });
    });

    await owner.get("/api/admin/sessions?historyLimit=12").expect(200).expect(({ body }) => {
      expect(body.sessions).toHaveLength(10);
      expect(body.history).toEqual({ loaded: 9, total: 9, hasMore: false });
    });
  });

  it("lets a listener create and share a session-scoped listener invite", async () => {
    const { app, store } = testApp(); stores.push(store);
    const owner = request.agent(app);
    await owner.post("/api/admin/login").send({ password: "owner-test-password" });
    const created = await owner.post("/api/admin/sessions").send({ name: "Shared relay", expiresInHours: 4 });
    const listenerToken = created.body.listenerUrl.split("/").at(-1);
    const djToken = created.body.djUrl.split("/").at(-1);

    const listener = request.agent(app);
    await listener.post("/api/invite/exchange").send({ token: listenerToken }).expect(200);
    const shared = await listener.post("/api/session/share-link").expect(200);
    expect(shared.body.url).toMatch(/\/s\/[A-Za-z0-9_.-]+$/);

    const invitedListener = request.agent(app);
    const sharedToken = shared.body.url.split("/").at(-1);
    await invitedListener.post("/api/invite/exchange").send({ token: sharedToken }).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ role: "listener", destination: "/listen" });
      expect(body.session.id).toBe(created.body.session.id);
    });

    const dj = request.agent(app);
    await dj.post("/api/invite/exchange").send({ token: djToken }).expect(200);
    await dj.post("/api/session/share-link").expect(403);
  });
});
