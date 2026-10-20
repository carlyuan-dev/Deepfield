/** Sanitized resource parsing failure, translated by tool adapters at their boundary. */
export class SearchResourceError extends Error {
  constructor(readonly code: "invalid_input" | "cancelled" | "unsupported_content_type" | "executor_failed") {
    super(code);
    this.name = "SearchResourceError";
  }
}
