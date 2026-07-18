import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./security.js";

const secret = "test-token-secret-with-more-than-32-bytes";

describe("token lifecycle", () => {
  it("keeps legacy listener share links valid after their old expiration", () => {
    const token = signToken({
      kind: "share",
      role: "listener",
      sessionId: "session-1",
      exp: Math.floor(Date.now() / 1000) - 60,
    }, secret);

    expect(verifyToken(token, secret)).toMatchObject({
      kind: "share",
      role: "listener",
      sessionId: "session-1",
    });
  });

  it("still rejects expired admin, invite, and media credentials", () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const tokens = [
      signToken({ kind: "admin", exp: expiredAt }, secret),
      signToken({ kind: "invite", role: "listener", sessionId: "session-1", exp: expiredAt }, secret),
      signToken({ kind: "media", role: "listener", sessionId: "session-1", path: "session-path", exp: expiredAt }, secret),
    ];

    expect(tokens.map((token) => verifyToken(token, secret))).toEqual([null, null, null]);
  });
});
