export type LoginLimiterOptions = {
  windowMs: number;
  maxFailuresPerClient: number;
  maxFailuresGlobal: number;
  maxTrackedClients: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now?: () => number;
};

type ClientFailures = {
  failures: number[];
  lastSeenAt: number;
};

export type LoginAdmission =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: "client" | "global" };

export class LoginAttemptLimiter {
  private readonly clients = new Map<string, ClientFailures>();
  private readonly globalFailures: number[] = [];
  private readonly now: () => number;

  constructor(private readonly options: LoginLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  check(clientKey: string): LoginAdmission {
    const now = this.now();
    this.prune(now);
    const client = this.clients.get(clientKey);
    const clientBlocked = (client?.failures.length ?? 0) >= this.options.maxFailuresPerClient;
    const globalBlocked = this.globalFailures.length >= this.options.maxFailuresGlobal;
    if (!clientBlocked && !globalBlocked) return { allowed: true };

    const clientRetryAt = clientBlocked ? (client?.failures[0] ?? now) + this.options.windowMs : Number.POSITIVE_INFINITY;
    const globalRetryAt = globalBlocked ? (this.globalFailures[0] ?? now) + this.options.windowMs : Number.POSITIVE_INFINITY;
    const scope = clientRetryAt <= globalRetryAt ? "client" : "global";
    const retryAt = Math.min(clientRetryAt, globalRetryAt);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      scope,
    };
  }

  recordFailure(clientKey: string): { delayMs: number; clientFailures: number; globalFailures: number } {
    const now = this.now();
    this.prune(now);
    let client = this.clients.get(clientKey);
    if (!client) {
      this.makeRoomForClient();
      client = { failures: [], lastSeenAt: now };
      this.clients.set(clientKey, client);
    }
    client.failures.push(now);
    client.lastSeenAt = now;
    this.globalFailures.push(now);

    const progressiveStep = Math.max(0, client.failures.length - 3);
    const delayMs = client.failures.length < 3 ? 0 : Math.min(
      this.options.maxDelayMs,
      this.options.baseDelayMs * (2 ** progressiveStep),
    );
    return {
      delayMs,
      clientFailures: client.failures.length,
      globalFailures: this.globalFailures.length,
    };
  }

  clearClient(clientKey: string): void {
    this.clients.delete(clientKey);
  }

  snapshot(): { trackedClients: number; globalFailures: number } {
    this.prune(this.now());
    return { trackedClients: this.clients.size, globalFailures: this.globalFailures.length };
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs;
    while (this.globalFailures.length > 0 && (this.globalFailures[0] ?? now) <= cutoff) {
      this.globalFailures.shift();
    }
    for (const [key, client] of this.clients) {
      while (client.failures.length > 0 && (client.failures[0] ?? now) <= cutoff) {
        client.failures.shift();
      }
      if (client.failures.length === 0) this.clients.delete(key);
    }
  }

  private makeRoomForClient(): void {
    if (this.clients.size < this.options.maxTrackedClients) return;
    let oldestKey: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, client] of this.clients) {
      if (client.lastSeenAt < oldestSeenAt) {
        oldestKey = key;
        oldestSeenAt = client.lastSeenAt;
      }
    }
    if (oldestKey) this.clients.delete(oldestKey);
  }
}

export async function delayResponse(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}
