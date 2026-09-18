import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolExecutionBatchScope } from "@deepfield/contracts/tools";

export interface CachedPiToolOutcome {
  status: "completed" | "failed";
  result?: AgentToolResult<unknown>;
  error?: unknown;
  errorCode?: string;
  retryable?: boolean;
  budgetConsumed?: boolean;
}

export function parseToolFailure(error: unknown): {
  code?: string;
  retryable?: boolean;
  budgetConsumed?: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return {};
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as {
      code?: unknown;
      retryable?: unknown;
      budgetConsumed?: unknown;
    };
    return {
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
      ...(typeof parsed.retryable === "boolean" ? { retryable: parsed.retryable } : {}),
      ...(typeof parsed.budgetConsumed === "boolean"
        ? { budgetConsumed: parsed.budgetConsumed }
        : {}),
    };
  } catch {
    return {};
  }
}

export function resultBudgetConsumed(result: AgentToolResult<unknown>): boolean | undefined {
  if (typeof result.details !== "object" || result.details === null) return undefined;
  const value = (result.details as Record<string, unknown>).budgetConsumed;
  return typeof value === "boolean" ? value : undefined;
}

export function scopedActivityCallKey(
  requestId: string,
  scope: ToolExecutionBatchScope,
): string {
  return `tool-${createHash("sha256")
    .update(`${requestId}\0${scope.batchId}\0${scope.toolCallId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function reusedToolResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  const details =
    typeof result.details === "object" && result.details !== null
      ? result.details as Record<string, unknown>
      : {};
  return { ...result, details: { ...details, budgetConsumed: false } };
}

export function reusedToolFailure(outcome: CachedPiToolOutcome): Error {
  const raw = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  const jsonStart = raw.indexOf("{");
  let parsed: Record<string, unknown> = {};
  if (jsonStart >= 0) {
    try {
      const candidate = JSON.parse(raw.slice(jsonStart)) as unknown;
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Fall back to a fixed safe failure below.
    }
  }
  return new Error(`tool_failed ${JSON.stringify({
    code: outcome.errorCode ?? "tool_error",
    message: typeof parsed.message === "string" ? parsed.message : "tool execution failed",
    retryable: outcome.retryable ?? false,
    attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
    budgetConsumed: false,
  })}`);
}

export function toolResultFailureCode(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const match = text.match(/"code":"([a-z_]+)"/);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export function usableUrlsInText(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const candidate = match[0].replace(/[),.;!?，。；！？]+$/u, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.add(parsed.href);
    } catch {
      // Ignore malformed URL-shaped text.
    }
  }
  return [...urls];
}

export function parsedToolResult(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) =>
    typeof part === "object" && part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  ).join("");
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export const NETWORK_TOOL_NAMES = new Set(["web_search", "read_webpage"]);

export function filterRuntimeTools(
  tools: AgentTool<any>[],
  availableNetworkTools: readonly string[],
): AgentTool<any>[] {
  const available = new Set(availableNetworkTools);
  return tools.filter((tool) => !NETWORK_TOOL_NAMES.has(tool.name) || available.has(tool.name));
}
