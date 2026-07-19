import { describe, expect, it } from "vitest";
import { LoginAttemptLimiter } from "./loginLimiter.js";

function limiter(now: () => number, overrides: Partial<ConstructorParameters<typeof LoginAttemptLimiter>[0]> = {}) {
  return new LoginAttemptLimiter({
    windowMs: 15 * 60_000,
    maxFailuresPerClient: 10,
    maxFailuresGlobal: 200,
    maxTrackedClients: 10_000,
    baseDelayMs: 250,
    maxDelayMs: 4_000,
    now,
    ...overrides,
  });
}

describe("LoginAttemptLimiter", () => {
  it("adds the approved progressive delay and blocks before the eleventh comparison", () => {
    let now = 1_000;
    const attempts = limiter(() => now);
    const delays: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      expect(attempts.check("client-a")).toEqual({ allowed: true });
      delays.push(attempts.recordFailure("client-a").delayMs);
      now += 1;
    }
    expect(delays).toEqual([0, 0, 250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000]);
    expect(attempts.check("client-a")).toMatchObject({ allowed: false, scope: "client", retryAfterSeconds: 900 });
  });

  it("applies the global backstop across distinct clients", () => {
    let now = 5_000;
    const attempts = limiter(() => now, { maxFailuresGlobal: 3 });
    attempts.recordFailure("client-a");
    attempts.recordFailure("client-b");
    attempts.recordFailure("client-c");
    expect(attempts.check("client-d")).toMatchObject({ allowed: false, scope: "global" });
    now += 15 * 60_000 + 1;
    expect(attempts.check("client-d")).toEqual({ allowed: true });
  });

  it("clears a successful client without clearing the global backstop", () => {
    const attempts = limiter(() => 10_000);
    attempts.recordFailure("client-a");
    attempts.recordFailure("client-a");
    attempts.clearClient("client-a");
    expect(attempts.check("client-a")).toEqual({ allowed: true });
    expect(attempts.snapshot()).toEqual({ trackedClients: 0, globalFailures: 2 });
  });

  it("bounds tracked client memory by evicting the least recently seen entry", () => {
    let now = 0;
    const attempts = limiter(() => now, { maxTrackedClients: 2 });
    attempts.recordFailure("oldest");
    now += 1;
    attempts.recordFailure("middle");
    now += 1;
    attempts.recordFailure("newest");
    expect(attempts.snapshot().trackedClients).toBe(2);
    expect(attempts.check("oldest")).toEqual({ allowed: true });
  });
});
