import type { ModelDiagnostic } from "./contracts.js";

export type ModelGatewayErrorCategory = "authentication" | "rate_limit" | "server" | "network" | "timeout" | "request" | "context_budget" | "unknown";

export class ModelGatewayError extends Error {
  constructor(
    readonly category: ModelGatewayErrorCategory = "unknown",
    readonly retryable = false,
    readonly diagnostic?: ModelDiagnostic,
    readonly stage?: "response_body",
  ) {
    super("model request failed");
    this.name = "ModelGatewayError";
  }
}

export function classifyModelGatewayError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) return error;
  if (typeof error !== "object" || error === null) return new ModelGatewayError();
  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && /context[_ ]?(?:length|window)|maximum context|too many tokens|prompt is too long/i.test(record.message)) return new ModelGatewayError("context_budget", false);
  const status = typeof record.status === "number"
    ? record.status
    : typeof record.statusCode === "number" ? record.statusCode : undefined;
  if (status === 401 || status === 403) return new ModelGatewayError("authentication", false);
  if (status === 429) return new ModelGatewayError("rate_limit", true);
  if (status !== undefined && status >= 500 && status <= 599) return new ModelGatewayError("server", true);
  if (status !== undefined && status >= 400 && status <= 499) return new ModelGatewayError("request", false);
  if (record.name === "AbortError" || record.name === "TimeoutError") return new ModelGatewayError("timeout", true);
  const retryableNetworkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
  if (typeof record.code === "string" && retryableNetworkCodes.has(record.code)) {
    return new ModelGatewayError("network", true);
  }
  if (typeof record.cause === "object" && record.cause !== null) {
    const causeCode = (record.cause as Record<string, unknown>).code;
    if (typeof causeCode === "string" && retryableNetworkCodes.has(causeCode)) {
      return new ModelGatewayError("network", true);
    }
  }
  return new ModelGatewayError();
}
