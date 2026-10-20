export class PiAgentError extends Error {
  constructor(
    readonly code: "provider_failed" | "stream_failed" | "incomplete_lifecycle" | "invalid_final_empty" | "invalid_final_protocol" | "invalid_final_language" | "invalid_final_tool_use",
    message: string,
  ) {
    super(message);
    this.name = "PiAgentError";
  }
}
