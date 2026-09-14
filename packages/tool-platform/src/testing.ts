import type { ToolSyntheticAuditRecord } from "@deepfield/contracts";
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
  | { kind: "finish"; record: ToolAuditFinish }
  | { kind: "synthetic"; record: ToolSyntheticAuditRecord };

/** Deterministic audit double with failure injection and optional start/finish gates. */
export class FakeAuditSink implements ToolAuditSink {
  readonly records: FakeAuditRecord[] = [];
  readonly #failStart: boolean;
  readonly #failFinish: boolean;
  #startGate: { resolve: () => void; promise: Promise<void> } | undefined;
  #finishGate: { resolve: () => void; promise: Promise<void> } | undefined;
  #startSeen: { resolve: () => void; promise: Promise<void> } | undefined;
  #finishSeen: { resolve: () => void; promise: Promise<void> } | undefined;
  #failFinishOnce: boolean;

  constructor(
    options: {
      failStart?: boolean;
      failFinish?: boolean;
      failFinishOnce?: boolean;
      deferStart?: boolean;
      deferFinish?: boolean;
    } = {},
  ) {
    this.#failStart = options.failStart ?? false;
    this.#failFinish = options.failFinish ?? false;
    this.#failFinishOnce = options.failFinishOnce === true;
    if (options.deferStart === true) {
      this.#startGate = deferred();
      this.#startSeen = deferred();
    }
    if (options.deferFinish === true) {
      this.#finishGate = deferred();
      this.#finishSeen = deferred();
    }
  }

  async start(record: ToolAuditStart): Promise<void> {
    if (this.#failStart) {
      throw new Error("audit start failed");
    }
    this.records.push({ kind: "start", record });
    this.#startSeen?.resolve();
    if (this.#startGate !== undefined) {
      await this.#startGate.promise;
    }
  }

  async finish(record: ToolAuditFinish): Promise<void> {
    if (this.#failFinish) {
      throw new Error("audit finish failed");
    }
    if (this.#failFinishOnce) {
      this.#failFinishOnce = false;
      throw new Error("audit finish failed once");
    }
    this.records.push({ kind: "finish", record });
    this.#finishSeen?.resolve();
    if (this.#finishGate !== undefined) {
      await this.#finishGate.promise;
    }
  }

  async recordSynthetic(record: ToolSyntheticAuditRecord): Promise<void> {
    this.records.push({ kind: "synthetic", record });
  }

  startSeen(): Promise<void> {
    return this.#startSeen?.promise ?? Promise.resolve();
  }

  finishSeen(): Promise<void> {
    return this.#finishSeen?.promise ?? Promise.resolve();
  }

  releaseStart(): void {
    this.#startGate?.resolve();
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
