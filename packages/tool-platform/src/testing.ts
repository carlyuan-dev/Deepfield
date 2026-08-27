import type { ToolAuditFinish, ToolAuditSink, ToolAuditStart } from "./audit.js";
import type { RetryClock } from "./retry.js";

export class FakeClockAbortError extends Error {
  constructor() {
    super("fake clock wait aborted");
    this.name = "FakeClockAbortError";
  }
}

interface PendingWait {
  until: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/** Deterministic virtual clock: no real timers, waits resolved by advance(). */
export class FakeRetryClock implements RetryClock {
  #now = 0;
  #waits: PendingWait[] = [];

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
    this.#flush();
  }

  async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new FakeClockAbortError();
    }
    await new Promise<void>((resolve, reject) => {
      let entry: PendingWait | undefined;
      const onAbort = () => {
        if (entry !== undefined) {
          this.#waits = this.#waits.filter((wait) => wait !== entry);
        }
        signal.removeEventListener("abort", onAbort);
        reject(new FakeClockAbortError());
      };
      entry = { until: this.#now + ms, resolve, reject, signal, onAbort };
      this.#waits.push(entry);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#flush();
    });
  }

  #flush(): void {
    const due = this.#waits.filter((wait) => wait.until <= this.#now);
    this.#waits = this.#waits.filter((wait) => wait.until > this.#now);
    for (const wait of due) {
      wait.signal.removeEventListener("abort", wait.onAbort);
      wait.resolve();
    }
  }
}

export type FakeAuditRecord =
  | { kind: "start"; record: ToolAuditStart }
  | { kind: "finish"; record: ToolAuditFinish };

/** Deterministic audit double with failure injection and an optional finish gate. */
export class FakeAuditSink implements ToolAuditSink {
  readonly records: FakeAuditRecord[] = [];
  readonly #failStart: boolean;
  readonly #failFinish: boolean;
  #finishGate: { resolve: () => void; promise: Promise<void> } | undefined;

  constructor(
    options: { failStart?: boolean; failFinish?: boolean; deferFinish?: boolean } = {},
  ) {
    this.#failStart = options.failStart ?? false;
    this.#failFinish = options.failFinish ?? false;
    if (options.deferFinish === true) {
      this.#finishGate = deferred();
    }
  }

  async start(record: ToolAuditStart): Promise<void> {
    if (this.#failStart) {
      throw new Error("audit start failed");
    }
    this.records.push({ kind: "start", record });
  }

  async finish(record: ToolAuditFinish): Promise<void> {
    if (this.#failFinish) {
      throw new Error("audit finish failed");
    }
    this.records.push({ kind: "finish", record });
    if (this.#finishGate !== undefined) {
      await this.#finishGate.promise;
    }
  }

  releaseFinish(): void {
    this.#finishGate?.resolve();
  }
}

function deferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
