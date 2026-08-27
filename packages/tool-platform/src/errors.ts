export type ToolFailureCode =
  | "invalid_input"
  | "tool_not_found"
  | "tool_not_allowed"
  | "permission_denied"
  | "confirmation_required"
  | "budget_exceeded"
  | "timeout"
  | "cancelled"
  | "rate_limited"
  | "authentication_failed"
  | "network_unavailable"
  | "url_blocked"
  | "redirect_blocked"
  | "response_too_large"
  | "unsupported_content_type"
  | "parse_failed"
  | "invalid_output"
  | "executor_failed"
  | "audit_failed";

/** Fixed safe messages: raw exception/provider text never crosses this boundary. */
export const TOOL_FAILURE_MESSAGES: Record<ToolFailureCode, string> = {
  invalid_input: "invalid tool input",
  tool_not_found: "tool not found",
  tool_not_allowed: "tool not allowed",
  permission_denied: "permission denied",
  confirmation_required: "confirmation required",
  budget_exceeded: "budget exceeded",
  timeout: "tool execution timed out",
  cancelled: "tool execution cancelled",
  rate_limited: "rate limited",
  authentication_failed: "authentication failed",
  network_unavailable: "network unavailable",
  url_blocked: "url blocked",
  redirect_blocked: "redirect blocked",
  response_too_large: "response too large",
  unsupported_content_type: "unsupported content type",
  parse_failed: "parse failed",
  invalid_output: "invalid tool output",
  executor_failed: "executor failed",
  audit_failed: "audit failed",
};

export interface ToolFailure {
  code: ToolFailureCode;
  message: string;
  retryable: boolean;
  attempts: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Safe classified failure thrown by executors and the platform. The message is
 * always the fixed message for the stable code; raw causes and enumerable
 * exception properties are never carried.
 */
export class ToolExecutionError extends Error {
  readonly code: ToolFailureCode;
  readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(code: ToolFailureCode, metadata?: Readonly<Record<string, unknown>>) {
    super(TOOL_FAILURE_MESSAGES[code]);
    this.name = "ToolExecutionError";
    this.code = code;
    if (metadata !== undefined) {
      this.metadata = metadata;
    }
  }
}

export function makeToolFailure(
  code: ToolFailureCode,
  attempts: number,
  retryable: boolean,
  metadata?: Readonly<Record<string, unknown>>,
): ToolFailure {
  const failure: ToolFailure = { code, message: TOOL_FAILURE_MESSAGES[code], retryable, attempts };
  if (metadata !== undefined) {
    failure.metadata = metadata;
  }
  return failure;
}
