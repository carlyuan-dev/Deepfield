export class ToolExecutionError extends Error {
  readonly code: "invalid_input" | "duplicate" | "not_found" | "already_finished" | "persistence";

  constructor(code: ToolExecutionError["code"], message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

/**
 * Local stable failure-code allowlist mirroring @deepfield/tool-platform's
 * public codes (alignment is asserted by tool-failure-codes.test.ts). A Set is
 * used so prototype keys like __proto__/constructor are never treated as codes.
 */
export const TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_input",
  "tool_not_found",
  "tool_not_allowed",
  "permission_denied",
  "confirmation_required",
  "budget_exceeded",
  "timeout",
  "cancelled",
  "rate_limited",
  "authentication_failed",
  "network_unavailable",
  "url_blocked",
  "redirect_blocked",
  "response_too_large",
  "unsupported_content_type",
  "parse_failed",
  "invalid_output",
  "executor_failed",
  "audit_failed",
]);
