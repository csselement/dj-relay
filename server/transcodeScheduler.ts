export type TranscodeSchedulerOptions = {
  maxActive: number;
  maxQueued: number;
  queueTimeoutMs: number;
  jobTimeoutMs: number;
  onEvent?: (event: TranscodeSchedulerEvent) => void;
};

export type TranscodeSchedulerEvent = {
  type: "queue_rejected" | "queue_timeout" | "job_timeout";
  active: number;
  queued: number;
};

export class TranscodeCapacityError extends Error {
  constructor(readonly code: "queue_full" | "queue_timeout" | "aborted") {
    super(code === "queue_full" ? "Replay conversion is busy" : code === "queue_timeout" ? "Replay conversion queue timed out" : "Replay conversion was canceled");
  }
}

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  timer: NodeJS.Timeout;
  abort: () => void;
};

export class TranscodeScheduler {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: TranscodeSchedulerOptions) {}

  status(): { active: number; queued: number; maxActive: number; maxQueued: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      maxActive: this.options.maxActive,
      maxQueued: this.options.maxQueued,
    };
  }

  async run<T>(requestSignal: AbortSignal, task: (jobSignal: AbortSignal) => Promise<T>): Promise<T> {
    await this.acquire(requestSignal);
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(new Error("Replay conversion exceeded its deadline"));
      this.emit("job_timeout");
    }, this.options.jobTimeoutMs);
    timeout.unref();
    const jobSignal = AbortSignal.any([requestSignal, timeoutController.signal]);
    try {
      const result = await task(jobSignal);
      if (timedOut) throw timeoutController.signal.reason;
      return result;
    } finally {
      clearTimeout(timeout);
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new TranscodeCapacityError("aborted");
    if (this.active < this.options.maxActive) {
      this.active += 1;
      return;
    }
    if (this.queue.length >= this.options.maxQueued) {
      this.emit("queue_rejected");
      throw new TranscodeCapacityError("queue_full");
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = {} as Waiter;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        signal.removeEventListener("abort", waiter.abort);
      };
      waiter.signal = signal;
      waiter.resolve = () => {
        cleanup();
        resolve();
      };
      waiter.reject = (error) => {
        cleanup();
        reject(error);
      };
      waiter.abort = () => {
        this.removeWaiter(waiter);
        waiter.reject(new TranscodeCapacityError("aborted"));
      };
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        this.emit("queue_timeout");
        waiter.reject(new TranscodeCapacityError("queue_timeout"));
      }, this.options.queueTimeoutMs);
      waiter.timer.unref();
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.signal.aborted) continue;
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private emit(type: TranscodeSchedulerEvent["type"]): void {
    this.options.onEvent?.({ type, active: this.active, queued: this.queue.length });
  }
}
