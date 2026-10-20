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

/**
 * Whitelisted failure metadata: only the stable numeric fields the Runner
 * explicitly needs survive. Provider messages, secrets, headers, causes,
 * stacks and arbitrary nested values are never forwarded.
 */
export interface ToolFailureMetadata {
  httpStatus?: number;
}

export interface ToolFailure {
  code: ToolFailureCode;
  message: string;
  retryable: boolean;
  attempts: number;
  metadata?: Readonly<ToolFailureMetadata>;
}

export function sanitizeFailureMetadata(
  metadata: unknown,
): Readonly<ToolFailureMetadata> | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  const status = record["httpStatus"];
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return Object.freeze({ httpStatus: status });
  }
  return undefined;
}

/**
 * Safe classified failure thrown by executors and the platform. The message is
 * always the fixed message for the stable code; raw causes and enumerable
 * exception properties are never carried. Metadata is defensively copied and
 * whitelisted at construction so later caller mutation cannot change it.
 */
export class ToolExecutionError extends Error {
  readonly code: ToolFailureCode;
  readonly metadata?: Readonly<ToolFailureMetadata>;

  constructor(code: ToolFailureCode, metadata?: unknown) {
    super(TOOL_FAILURE_MESSAGES[code]);
    this.name = "ToolExecutionError";
    this.code = code;
    const safe = sanitizeFailureMetadata(metadata);
    if (safe !== undefined) {
      this.metadata = safe;
    }
  }
}

export function makeToolFailure(
  code: ToolFailureCode,
  attempts: number,
  retryable: boolean,
  metadata?: unknown,
): ToolFailure {
  const failure: ToolFailure = {
    code,
    message: TOOL_FAILURE_MESSAGES[code],
    retryable,
    attempts,
  };
  const safe = sanitizeFailureMetadata(metadata);
  if (safe !== undefined) {
    failure.metadata = safe;
  }
  return Object.freeze(failure);
}
