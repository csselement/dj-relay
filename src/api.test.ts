import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api errors", () => {
  it("parses machine-readable codes and Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Too many sign-in attempts",
      code: "login_throttled",
    }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "42" },
    })));
    await expect(api("/api/admin/login")).rejects.toMatchObject({
      status: 429,
      code: "login_throttled",
      retryAfterSeconds: 42,
    });
  });
});
