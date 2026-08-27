import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  HostReplySchema,
  type HostReply,
} from "@deepfield/contracts";
import type { ToolAuditFinish, ToolAuditSink, ToolAuditStart } from "@deepfield/tool-platform";

export class HostRpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`host rpc failed: ${code}`);
    this.name = "HostRpcError";
    this.code = code;
  }
}

export class HostRpcTimeoutError extends Error {
  constructor() {
    super("host rpc timed out");
    this.name = "HostRpcTimeoutError";
  }
}

export class HostRpcProtocolError extends Error {
  constructor() {
    super("host sent an invalid rpc reply");
    this.name = "HostRpcProtocolError";
  }
}

export class HostRpcDisposedError extends Error {
  constructor() {
    super("host client is disposed");
    this.name = "HostRpcDisposedError";
  }
}

export interface HostTimer {
  promise: Promise<void>;
  cancel(): void;
}

export interface HostClientOptions {
  postMessage(value: unknown): void;
  timeoutMs?: number;
  timer?: (ms: number) => HostTimer;
}

function defaultTimer(ms: number): HostTimer {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
    if (typeof timeout === "object" && "unref" in timeout) {
      timeout.unref();
    }
  });
  return {
    promise,
    cancel: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}

interface PendingRpc {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: HostTimer;
}

function safeHostRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { hostRequestId?: unknown; kind?: unknown };
  if (typeof record.hostRequestId === "string" && record.hostRequestId.length > 0) {
    return record.hostRequestId;
  }
  return undefined;
}

export class HostClient {
  readonly #pending = new Map<string, PendingRpc>();
  readonly #postMessage: (value: unknown) => void;
  readonly #timeoutMs: number;
  readonly #timer: (ms: number) => HostTimer;
  #disposed = false;

  constructor(options: HostClientOptions) {
    this.#postMessage = options.postMessage;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#timer = options.timer ?? defaultTimer;
  }

  request(method: "audit.start" | "audit.finish" | "secret.getProviderKey", payload: unknown): Promise<unknown> {
    if (this.#disposed) {
      return Promise.reject(new HostRpcDisposedError());
    }
    const hostRequestId = randomUUID();
    this.#postMessage({ hostRequestId, kind: "host.request", method, payload });
    return new Promise((resolve, reject) => {
      const timer = this.#timer(this.#timeoutMs);
      const pending: PendingRpc = { resolve, reject, timer };
      this.#pending.set(hostRequestId, pending);
      timer.promise.then(() => {
        if (this.#pending.get(hostRequestId) === pending) {
          this.#pending.delete(hostRequestId);
          reject(new HostRpcTimeoutError());
        }
      });
    });
  }

  handleReply(value: unknown): void {
    if (this.#disposed) {
      return;
    }
    const hostRequestId = safeHostRequestId(value);
    if (hostRequestId === undefined) {
      return;
    }
    const pending = this.#pending.get(hostRequestId);
    if (!pending) {
      return; // late or duplicate reply: settle nothing
    }
    this.#pending.delete(hostRequestId);
    pending.timer.cancel();
    if (!Value.Check(HostReplySchema, value)) {
      pending.reject(new HostRpcProtocolError());
      return;
    }
    const reply = value as HostReply;
    if (reply.ok) {
      pending.resolve(reply.payload);
    } else {
      pending.reject(new HostRpcError(reply.code));
    }
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const error = new HostRpcDisposedError();
    for (const [hostRequestId, pending] of [...this.#pending]) {
      this.#pending.delete(hostRequestId);
      pending.timer.cancel();
      pending.reject(error);
    }
  }
}

/** Worker-side ToolAuditSink: only safe fields cross the host RPC. */
export class RemoteToolAuditSink implements ToolAuditSink {
  readonly #client: HostClient;

  constructor(client: HostClient) {
    this.#client = client;
  }

  async start(record: ToolAuditStart): Promise<void> {
    await this.#client.request("audit.start", {
      executionId: record.executionId,
      traceId: record.traceId,
      ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
      actor: record.actor,
      toolName: record.tool.name,
      toolVersion: record.tool.version,
    });
  }

  async finish(record: ToolAuditFinish): Promise<void> {
    await this.#client.request("audit.finish", {
      executionId: record.executionId,
      traceId: record.traceId,
      status: record.status,
      attempts: record.attempts,
      ...(record.failure !== undefined ? { errorCode: record.failure.code } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    });
  }
}

export interface ProviderKeyClient {
  getProviderKey(provider: "deepseek"): Promise<string | undefined>;
}

/** Narrow provider-key reader: only the compiled allowlisted provider. */
export function createHostSecretClient(client: HostClient): ProviderKeyClient {
  return {
    async getProviderKey(provider) {
      const reply = await client.request("secret.getProviderKey", { provider });
      const payload = reply as { apiKey: string | null };
      return payload.apiKey === null ? undefined : payload.apiKey;
    },
  };
}
