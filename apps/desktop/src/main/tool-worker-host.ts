import { Value } from "typebox/value";
import { HostRequestSchema, type HostRequest } from "@deepfield/contracts";
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

function reply(
  postMessage: (value: unknown) => void,
  hostRequestId: string,
  value: { method: string; ok: boolean; code?: string; payload?: unknown },
): void {
  try {
    postMessage({ hostRequestId, kind: "host.reply", ...value });
  } catch {
    // postMessage must never produce an unhandled rejection on the caller side.
  }
}

/**
 * Main-side narrow host RPC. Only three compile-time methods exist:
 * audit.start, audit.finish and secret.getProviderKey (deepseek only).
 * No generic secret names, SQL, repository methods, URLs or Renderer senders.
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
    const { hostRequestId } = request;
    try {
      if (request.method === "audit.start") {
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
          reply(options.postMessage, hostRequestId, {
            method: "audit.start",
            ok: true,
            payload: { acknowledged: true },
          });
        }
        return;
      }
      if (request.method === "audit.finish") {
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
          reply(options.postMessage, hostRequestId, {
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
          reply(options.postMessage, hostRequestId, {
            method: "secret.getProviderKey",
            ok: false,
            code: "secret_unavailable",
          });
        }
        return;
      }
      if (!disposed) {
        reply(options.postMessage, hostRequestId, {
          method: "secret.getProviderKey",
          ok: true,
          payload: { apiKey },
        });
      }
    } catch {
      if (!disposed) {
        reply(options.postMessage, hostRequestId, {
          method: request.method,
          ok: false,
          code: "audit_failed",
        });
      }
    }
  }

  return {
    handleRequest(value: unknown): void {
      if (disposed) {
        const hostRequestId =
          typeof value === "object" && value !== null
            ? (value as { hostRequestId?: unknown }).hostRequestId
            : undefined;
        if (typeof hostRequestId === "string" && hostRequestId.length > 0) {
          reply(options.postMessage, hostRequestId, {
            method: "host_protocol_error",
            ok: false,
            code: "host_disposed",
          });
        }
        return;
      }
      if (!Value.Check(HostRequestSchema, value)) {
        const hostRequestId =
          typeof value === "object" && value !== null
            ? (value as { hostRequestId?: unknown }).hostRequestId
            : undefined;
        if (typeof hostRequestId === "string" && hostRequestId.length > 0) {
          reply(options.postMessage, hostRequestId, {
            method: "host_protocol_error",
            ok: false,
            code: "invalid_request",
          });
        }
        return;
      }
      const { hostRequestId } = value;
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
