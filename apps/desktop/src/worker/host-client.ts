import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  HostReplySchema,
  type HostConversationDetail,
  type HostConversationSearchResult,
  type HostConversationSummary,
  type HostReply,
  type HostRpcMethod,
  type ToolSyntheticAuditRecord,
} from "@deepfield/contracts";
import type { ToolAuditFinish, ToolAuditSink, ToolAuditStart } from "@deepfield/tool-platform";
import type { ConversationReader } from "@deepfield/utility-tools";

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
  method: HostRpcMethod;
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

  request(method: HostRpcMethod, payload: unknown): Promise<unknown> {
    if (this.#disposed) {
      return Promise.reject(new HostRpcDisposedError());
    }
    const hostRequestId = randomUUID();
    // Timer + pending are registered BEFORE postMessage so a synchronous reply
    // delivered during post() can never be lost.
    return new Promise((resolve, reject) => {
      const timer = this.#timer(method === "capability.call" ? Math.max(this.#timeoutMs, 30_000) : this.#timeoutMs);
      const pending: PendingRpc = { method, resolve, reject, timer };
      this.#pending.set(hostRequestId, pending);
      timer.promise.then(() => {
        if (this.#pending.get(hostRequestId) === pending) {
          this.#pending.delete(hostRequestId);
          reject(new HostRpcTimeoutError());
        }
      });
      try {
        this.#postMessage({ hostRequestId, kind: "host.request", method, payload });
      } catch (error) {
        this.#pending.delete(hostRequestId);
        timer.cancel();
        reject(
          error instanceof Error
            ? new HostRpcDisposedError()
            : new HostRpcProtocolError(),
        );
      }
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
    if (reply.method === "host.protocol") {
      pending.reject(new HostRpcProtocolError());
      return;
    }
    if (reply.method !== pending.method) {
      pending.reject(new HostRpcProtocolError());
      return;
    }
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
      ...(record.agentTurnIndex !== undefined ? { agentTurnIndex: record.agentTurnIndex } : {}),
      ...(record.batchId !== undefined ? { batchId: record.batchId } : {}),
      ...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
    });
  }

  async finish(record: ToolAuditFinish): Promise<void> {
    await this.#client.request("audit.finish", {
      executionId: record.executionId,
      traceId: record.traceId,
      status: record.status,
      attempts: record.attempts,
      budgetConsumed: record.budgetConsumed,
      ...(record.failure !== undefined ? { errorCode: record.failure.code } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    });
  }

  async recordSynthetic(record: ToolSyntheticAuditRecord): Promise<void> {
    await this.#client.request("audit.synthetic", {
      executionId: record.executionId,
      traceId: record.traceId,
      ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
      actor: record.actor,
      toolName: record.tool.name,
      toolVersion: record.tool.version,
      status: record.status,
      ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      agentTurnIndex: record.agentTurnIndex,
      batchId: record.batchId,
      toolCallId: record.toolCallId,
      attempts: 0,
      budgetConsumed: false,
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
      // The reply is schema-validated by the client: only a secret method can
      // carry an apiKey payload.
      const reply = await client.request("secret.getProviderKey", { provider });
      const payload = reply as { apiKey: string | null };
      return payload.apiKey === null ? undefined : payload.apiKey;
    },
  };
}

/** Typed read-only conversation client; no SQL or generic database method is exposed. */
export function createHostConversationReader(client: HostClient): ConversationReader {
  return {
    async listRecent(limit): Promise<HostConversationSummary[]> {
      const payload = (await client.request("conversation.listRecent", { limit })) as {
        conversations: HostConversationSummary[];
      };
      return payload.conversations;
    },
    async read(conversationId, limit): Promise<HostConversationDetail | undefined> {
      const payload = (await client.request("conversation.read", {
        conversationId,
        limit,
      })) as { conversation: HostConversationDetail | null };
      return payload.conversation ?? undefined;
    },
    async search(query, maxResults): Promise<HostConversationSearchResult[]> {
      const payload = (await client.request("conversation.search", {
        query,
        maxResults,
      })) as { results: HostConversationSearchResult[] };
      return payload.results;
    },
  };
}
