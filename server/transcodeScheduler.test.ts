import { describe, expect, it } from "vitest";
import { TranscodeScheduler } from "./transcodeScheduler.js";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("TranscodeScheduler", () => {
  it("never runs more than two jobs and admits queued work in FIFO order", async () => {
    const scheduler = new TranscodeScheduler({ maxActive: 2, maxQueued: 4, queueTimeoutMs: 1_000, jobTimeoutMs: 5_000 });
    const releases = Array.from({ length: 4 }, deferred);
    const started: number[] = [];
    const jobs = releases.map((release, index) => scheduler.run(new AbortController().signal, async () => {
      started.push(index);
      await release.promise;
    }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(scheduler.status()).toMatchObject({ active: 2, queued: 2 });
    releases[0]?.resolve();
    await jobs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    releases.slice(1).forEach((release) => release.resolve());
    await Promise.all(jobs);
    expect(scheduler.status()).toMatchObject({ active: 0, queued: 0 });
  });

  it("rejects work beyond the approved queue bound", async () => {
    const scheduler = new TranscodeScheduler({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 1_000, jobTimeoutMs: 5_000 });
    const release = deferred();
    const active = scheduler.run(new AbortController().signal, () => release.promise);
    const queued = scheduler.run(new AbortController().signal, async () => undefined);
    await expect(scheduler.run(new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "queue_full" });
    release.resolve();
    await Promise.all([active, queued]);
  });

  it("removes a canceled queued request", async () => {
    const scheduler = new TranscodeScheduler({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 1_000, jobTimeoutMs: 5_000 });
    const release = deferred();
    const active = scheduler.run(new AbortController().signal, () => release.promise);
    const queuedController = new AbortController();
    const queued = scheduler.run(queuedController.signal, async () => undefined);
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ code: "aborted" });
    expect(scheduler.status().queued).toBe(0);
    release.resolve();
    await active;
  });

  it("aborts an active job at its deadline and releases the worker", async () => {
    const events: string[] = [];
    const scheduler = new TranscodeScheduler({
      maxActive: 1,
      maxQueued: 1,
      queueTimeoutMs: 1_000,
      jobTimeoutMs: 10,
      onEvent: (event) => events.push(event.type),
    });
    await expect(scheduler.run(new AbortController().signal, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    })).rejects.toThrow("deadline");
    expect(events).toContain("job_timeout");
    expect(scheduler.status()).toMatchObject({ active: 0, queued: 0 });
  });
});
