import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./db.js";

function testApp() {
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
  return { app: createApp({ config, store }), store, config };
}

describe("DJ Relay API", () => {
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
      .send({ name: "Saturday Night Relay", expiresInHours: 8 })
      .expect(201);

    expect(created.body.djUrl).toMatch(/^https:\/\//);
    expect(created.body.listenerUrl).toMatch(/^https:\/\//);
    expect(created.body.djUrl).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    expect(created.body.listenerUrl).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    expect(created.body.djUrl).not.toBe(created.body.listenerUrl);
    expect(store.list()).toHaveLength(1);
  });

  it("lets an authenticated owner open an active session as a listener", async () => {
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
    await owner.get(`/api/admin/sessions/${sessionId}/listen`).expect(410);
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
