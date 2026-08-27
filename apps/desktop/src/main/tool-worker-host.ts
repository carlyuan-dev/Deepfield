import { Value } from "typebox/value";
import { HostRequestSchema, type HostRequest } from "@deepfield/contracts";
import {
  TOOL_FAILURE_MESSAGES,
  type ToolAuditSink,
  type ToolFailureCode,
} from "@deepfield/tool-platform";

export interface ToolWorkerHostOptions {
  audit: ToolAuditSink;
  secrets: { get(name: string): string | undefined };
  postMessage(value: unknown): void;
}

export interface ToolWorkerHost {
  handleRequest(value: unknown): void;
  dispose(): void;
}

function reply(
  postMessage: (value: unknown) => void,
  hostRequestId: string,
  value: { ok: boolean; code?: string; payload?: unknown },
): void {
  postMessage({ hostRequestId, kind: "host.reply", ...value });
}

/**
 * Main-side narrow host RPC. Only three compile-time methods exist:
 * audit.start, audit.finish and secret.getProviderKey (deepseek only).
 * No generic secret names, SQL, repository methods, URLs or Renderer senders.
 */
export function createToolWorkerHost(options: ToolWorkerHostOptions): ToolWorkerHost {
  let disposed = false;

  async function handleValid(request: HostRequest): Promise<void> {
    if (request.method === "audit.start") {
      try {
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
        reply(options.postMessage, request.hostRequestId, {
          ok: true,
          payload: { acknowledged: true },
        });
      } catch {
        reply(options.postMessage, request.hostRequestId, { ok: false, code: "audit_failed" });
      }
      return;
    }
    if (request.method === "audit.finish") {
      try {
        const code = request.payload.errorCode as ToolFailureCode | undefined;
        await options.audit.finish({
          executionId: request.payload.executionId,
          traceId: request.payload.traceId,
          status: request.payload.status,
          attempts: request.payload.attempts,
          ...(code !== undefined
            ? {
                failure: {
                  code,
                  message: TOOL_FAILURE_MESSAGES[code] ?? "tool failure",
                  retryable: false,
                  attempts: request.payload.attempts,
                },
              }
            : {}),
          ...(request.payload.durationMs !== undefined
            ? { durationMs: request.payload.durationMs }
            : {}),
        });
        reply(options.postMessage, request.hostRequestId, {
          ok: true,
          payload: { acknowledged: true },
        });
      } catch {
        reply(options.postMessage, request.hostRequestId, { ok: false, code: "audit_failed" });
      }
      return;
    }
    // secret.getProviderKey: schema already allowlists deepseek only.
    const apiKey = options.secrets.get("deepseek.apiKey");
    reply(options.postMessage, request.hostRequestId, {
      ok: true,
      payload: { apiKey: apiKey ?? null },
    });
  }

  return {
    handleRequest(value: unknown): void {
      if (disposed) {
        const hostRequestId =
          typeof value === "object" && value !== null
            ? (value as { hostRequestId?: unknown }).hostRequestId
            : undefined;
        if (typeof hostRequestId === "string" && hostRequestId.length > 0) {
          reply(options.postMessage, hostRequestId, { ok: false, code: "host_disposed" });
        }
        return;
      }
      if (!Value.Check(HostRequestSchema, value)) {
        const hostRequestId =
          typeof value === "object" && value !== null
            ? (value as { hostRequestId?: unknown }).hostRequestId
            : undefined;
        if (typeof hostRequestId === "string" && hostRequestId.length > 0) {
          reply(options.postMessage, hostRequestId, { ok: false, code: "invalid_request" });
        }
        return;
      }
      void handleValid(value);
    },
    dispose() {
      disposed = true;
    },
  };
}
