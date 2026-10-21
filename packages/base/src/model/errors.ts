import type { ModelDiagnostic } from "./contracts.js";

export type ModelGatewayErrorCategory = "authentication" | "rate_limit" | "server" | "network" | "timeout" | "request" | "context_budget" | "unknown";

const transportCodes = ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"] as const;
const transportNames = ["Error", "TypeError", "AbortError", "TimeoutError"] as const;
export interface ModelTransportFailure {
  readonly stage: "request" | "response_body";
  readonly category: "network" | "timeout" | "unknown";
  readonly name?: typeof transportNames[number];
  readonly code?: typeof transportCodes[number];
  readonly causeCode?: typeof transportCodes[number];
  readonly operationId: string;
  readonly attemptId: string;
  readonly requestId?: string;
  readonly modelRequestId?: string;
}

/** Inspect only stable allowlisted fields; never retain provider text or cause objects. */
export function classifyModelTransportFailure(error: unknown, stage: ModelTransportFailure["stage"], association: Pick<ModelTransportFailure, "operationId" | "attemptId" | "requestId" | "modelRequestId">): ModelGatewayError {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const cause = typeof record.cause === "object" && record.cause !== null ? record.cause as Record<string, unknown> : {};
  const code = transportCodes.find(code => code === record.code);
  const causeCode = transportCodes.find(code => code === cause.code);
  const name = transportNames.find(name => name === record.name);
  const timeout = name === "TimeoutError" || name === "AbortError" || [code, causeCode].some(code => code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT"));
  const category = timeout ? "timeout" : code || causeCode ? "network" : "unknown";
  const transport: ModelTransportFailure = Object.freeze({ ...association, stage, category, ...(name ? { name } : {}), ...(code ? { code } : {}), ...(causeCode ? { causeCode } : {}) });
  return new ModelGatewayError(category, category !== "unknown", undefined, stage, transport);
}

export class ModelGatewayError extends Error {
  constructor(
    readonly category: ModelGatewayErrorCategory = "unknown",
    readonly retryable = false,
    readonly diagnostic?: ModelDiagnostic,
    readonly stage?: "request" | "response_body",
    readonly transport?: ModelTransportFailure,
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
