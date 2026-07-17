import { describe, expect, it, vi } from "vitest";
import { announceDiscordSession } from "./discord.js";

const announcement = {
  webhookUrl: "https://discord.com/api/webhooks/test/secret",
  sessionId: "session-1",
  sessionName: "Saturday Night Relay @everyone",
  listenerUrl: "https://relay.example/s/private-listener-token",
};

describe("Discord session announcements", () => {
  it("posts a plain announcement with mentions disabled", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    const logger = { log: vi.fn(), error: vi.fn() };

    await announceDiscordSession(announcement, { fetchImpl, logger });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(announcement.webhookUrl);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      content: `🎧 **${announcement.sessionName} is live on Discus**\nListen now: ${announcement.listenerUrl}`,
      allowed_mentions: { parse: [] },
    });
    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not make a request when the webhook is unconfigured", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204 }));

    await announceDiscordSession({ ...announcement, webhookUrl: null }, { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["network rejection", vi.fn(async () => { throw new Error("connection refused"); })],
    ["non-2xx response", vi.fn(async () => new Response(null, { status: 429 }))],
  ])("logs %s without exposing secrets", async (_label, fetchImpl) => {
    const logger = { log: vi.fn(), error: vi.fn() };

    await expect(announceDiscordSession(announcement, { fetchImpl, logger })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledOnce();
    const logged = String(logger.error.mock.calls[0][0]);
    expect(logged).toContain(announcement.sessionId);
    expect(logged).not.toContain(announcement.webhookUrl);
    expect(logged).not.toContain("private-listener-token");
  });
});
