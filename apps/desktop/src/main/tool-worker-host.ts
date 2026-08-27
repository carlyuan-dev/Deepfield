import { Value } from "typebox/value";
import {
  HostRequestSchema,
  type HostReply,
  type HostRequest,
  type HostRpcMethod,
} from "@deepfield/contracts";
import { TOOL_FAILURE_MESSAGES, type ToolAuditSink } from "@deepfield/tool-platform";

export interface ToolWorkerHostOptions {
  audit: ToolAuditSink;
  secrets: { get(name: string): string | undefined };
  postMessage(value: unknown): void;
  /** Bounded tombstone size for completed/late-duplicate host request ids. */
  maxCompletedIds?: number;
}

export interface ToolWorkerHost {
  handleRequest(value: unknown): void;
  dispose(): void;
}

const HOST_RPC_METHODS = new Set<HostRpcMethod>([
  "audit.start",
  "audit.finish",
  "secret.getProviderKey",
]);

function isRpcMethod(value: unknown): value is HostRpcMethod {
  return typeof value === "string" && HOST_RPC_METHODS.has(value as HostRpcMethod);
}

function reply(postMessage: (value: unknown) => void, value: HostReply): void {
  try {
    postMessage(value);
  } catch {
    // postMessage must never produce an unhandled rejection on the caller side.
  }
}

function safeHostRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { hostRequestId?: unknown };
  if (typeof record.hostRequestId === "string" && record.hostRequestId.length > 0) {
    return record.hostRequestId;
  }
  return undefined;
}

function safeMethod(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as { method?: unknown }).method;
}

/**
 * Main-side narrow host RPC. Only three compile-time methods exist:
 * audit.start, audit.finish and secret.getProviderKey (deepseek only).
 * Every reply is schema-valid: valid pending methods receive same-method
 * replies; malformed/unknown-method inputs receive the host.protocol variant.
 */
export function createToolWorkerHost(options: ToolWorkerHostOptions): ToolWorkerHost {
  let disposed = false;
  const active = new Set<string>();
  const completed = new Set<string>();
  const maxCompletedIds = options.maxCompletedIds ?? 256;

  function rememberCompleted(hostRequestId: string): void {
    completed.add(hostRequestId);
    if (completed.size > maxCompletedIds) {
      const oldest = completed.values().next().value;
      if (oldest !== undefined) {
        completed.delete(oldest);
      }
    }
  }

  async function handleValid(request: HostRequest): Promise<void> {
    const { hostRequestId, method } = request;
    try {
      if (method === "audit.start") {
        await options.audit.start({
          executionId: request.payload.executionId,
          traceId: request.payload.traceId,
          ...(request.payload.projectId !== undefined
            ? { projectId: request.payload.projectId }
            : {}),
          actor: request.payload.actor,
          tool: { name: request.payload.toolName, version: request.payload.toolVersion },
          attempts: 0,
        });
        if (!disposed) {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method: "audit.start",
            ok: true,
            payload: { acknowledged: true },
          });
        }
        return;
      }
      if (method === "audit.finish") {
        await options.audit.finish({
          executionId: request.payload.executionId,
          traceId: request.payload.traceId,
          status: request.payload.status,
          attempts: request.payload.attempts,
          ...(request.payload.status === "cancelled" && request.payload.errorCode !== undefined
            ? {
                failure: {
                  code: request.payload.errorCode,
                  message: TOOL_FAILURE_MESSAGES[request.payload.errorCode] ?? "tool failure",
                  retryable: false,
                  attempts: request.payload.attempts,
                },
              }
            : {}),
          ...(request.payload.status === "failed"
            ? {
                failure: {
                  code: request.payload.errorCode,
                  message: TOOL_FAILURE_MESSAGES[request.payload.errorCode] ?? "tool failure",
                  retryable: false,
                  attempts: request.payload.attempts,
                },
              }
            : {}),
          ...(request.payload.durationMs !== undefined
            ? { durationMs: request.payload.durationMs }
            : {}),
        });
        if (!disposed) {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method: "audit.finish",
            ok: true,
            payload: { acknowledged: true },
          });
        }
        return;
      }
      let apiKey: string | null = null;
      try {
        apiKey = options.secrets.get("deepseek.apiKey") ?? null;
      } catch {
        if (!disposed) {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method: "secret.getProviderKey",
            ok: false,
            code: "secret_unavailable",
          });
        }
        return;
      }
      if (!disposed) {
        reply(options.postMessage, {
          hostRequestId,
          kind: "host.reply",
          method: "secret.getProviderKey",
          ok: true,
          payload: { apiKey },
        });
      }
    } catch {
      if (!disposed) {
        reply(options.postMessage, {
          hostRequestId,
          kind: "host.reply",
          method,
          ok: false,
          code: "audit_failed",
        });
      }
    }
  }

  return {
    handleRequest(value: unknown): void {
      const hostRequestId = safeHostRequestId(value);
      if (disposed) {
        if (hostRequestId === undefined) {
          return;
        }
        const method = safeMethod(value);
        if (isRpcMethod(method)) {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method,
            ok: false,
            code: "host_disposed",
          });
        } else {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method: "host.protocol",
            ok: false,
            code: "host_disposed",
          });
        }
        return;
      }
      if (!Value.Check(HostRequestSchema, value)) {
        if (hostRequestId === undefined) {
          return;
        }
        const method = safeMethod(value);
        if (isRpcMethod(method)) {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method,
            ok: false,
            code: "invalid_request",
          });
        } else {
          reply(options.postMessage, {
            hostRequestId,
            kind: "host.reply",
            method: "host.protocol",
            ok: false,
            code: "invalid_request",
          });
        }
        return;
      }
      if (hostRequestId === undefined) {
        return;
      }
      if (active.has(hostRequestId) || completed.has(hostRequestId)) {
        // duplicate active request or late duplicate of a completed one:
        // never a second audit/secret call, never a second terminal reply.
        return;
      }
      active.add(hostRequestId);
      void handleValid(value)
        .catch(() => {
          // fully guarded: never an unhandled rejection
        })
        .finally(() => {
          active.delete(hostRequestId);
          rememberCompleted(hostRequestId);
        });
    },
    dispose() {
      disposed = true;
      active.clear();
    },
  };
}
