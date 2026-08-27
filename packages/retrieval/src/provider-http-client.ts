import { Readable } from "node:stream";
import { SearchProviderError } from "./search-provider.js";
import { readBoundedBody, normalizeContentEncoding } from "./bounded-reader.js";
import type { HostTimer } from "./http-transport.js";

export interface ProviderEndpoint {
  /** Fixed https origin (scheme://host[:port]). */
  origin: string;
  /** Fixed path prefix every request path must belong to. */
  pathPrefix: string;
}

/** Validates + normalizes a provider endpoint at client construction time. */
export function validateEndpoint(endpoint: ProviderEndpoint): ProviderEndpoint {
  if (typeof endpoint !== "object" || endpoint === null) {
    throw new Error("invalid provider endpoint");
  }
  if (typeof endpoint.origin !== "string" || endpoint.origin.length === 0) {
    throw new Error("invalid provider endpoint");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint.origin);
  } catch {
    throw new Error("invalid provider endpoint");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("invalid provider endpoint: https only");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("invalid provider endpoint: credentials forbidden");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("invalid provider endpoint: query/hash forbidden");
  }
  if (parsed.pathname !== "/") {
    throw new Error("invalid provider endpoint: path must be empty");
  }
  const prefix = endpoint.pathPrefix;
  if (typeof prefix !== "string" || !prefix.startsWith("/") || prefix === "/") {
    throw new Error("invalid provider pathPrefix");
  }
  if (prefix.includes("..") || /[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new Error("invalid provider pathPrefix");
  }
  return { origin: parsed.origin, pathPrefix: prefix };
}

/** Every request path must belong to the bound prefix; no absolute/scheme-relative URLs. */
export function validateRequestPath(prefix: string, path: unknown): string {
  if (typeof path !== "string") {
    throw new Error("invalid provider path");
  }
  const belongs = path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
  if (!belongs || path.includes("://") || path.startsWith("//") || path.includes("..") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("invalid provider path");
  }
  return path;
}

export interface ProviderHttpRequestOptions {
  method: "GET" | "POST";
  /** Request path belonging to the bound endpoint prefix. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  maxResponseBytes?: number;
}

export interface ProviderHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface ProviderTransportRequest {
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface ProviderTransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
  destroy(): void;
}

export interface ProviderTransport {
  /** Receives ONLY the client's bound (validated) endpoint. */
  request(endpoint: ProviderEndpoint, request: ProviderTransportRequest): Promise<ProviderTransportResponse>;
}

export interface ProviderHttpClientDeps {
  transport: ProviderTransport;
  /** The fixed endpoint is bound AND validated at construction time. */
  endpoint: ProviderEndpoint;
  timer?: (ms: number) => HostTimer;
  maxResponseBytes?: number;
  totalTimeoutMs?: number;
}

function defaultHostTimer(ms: number): HostTimer {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
    if (typeof timeout === "object" && "unref" in timeout) {
      timeout.unref();
    }
  });
  return { promise, cancel: () => (timeout !== undefined ? clearTimeout(timeout) : undefined) };
}

function requirePositiveInt(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`invalid ${name}: must be a positive integer`);
  }
  return resolved;
}

/** Parses Retry-After: valid non-negative integer seconds bounded to one hour. */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 3600) {
    return undefined;
  }
  return seconds * 1000;
}

/**
 * Fixed-origin provider HTTP client. The endpoint is bound and validated at
 * CONSTRUCTION; request() never accepts an origin or path prefix, so no caller
 * can redirect traffic. Redirects are rejected, response bodies are bounded
 * during streaming (decompressed size), and the total deadline/abort races the
 * whole request so a stuck socket can never block the return. Authorization
 * headers never appear in errors or diagnostics.
 */
export class ProviderHttpClient {
  readonly #endpoint: ProviderEndpoint;
  readonly #transport: ProviderTransport;
  readonly #timer: (ms: number) => HostTimer;
  readonly #maxResponseBytes: number;
  readonly #totalTimeoutMs: number;

  constructor(deps: ProviderHttpClientDeps) {
    this.#endpoint = validateEndpoint(deps.endpoint);
    this.#transport = deps.transport;
    this.#timer = deps.timer ?? defaultHostTimer;
    this.#maxResponseBytes = requirePositiveInt(deps.maxResponseBytes, "maxResponseBytes", 2 * 1024 * 1024);
    this.#totalTimeoutMs = requirePositiveInt(deps.totalTimeoutMs, "totalTimeoutMs", 30_000);
  }

  async request(options: ProviderHttpRequestOptions): Promise<ProviderHttpResponse> {
    const path = validateRequestPath(this.#endpoint.pathPrefix, options.path);
    const { signal } = options;
    if (signal.aborted) {
      throw new SearchProviderError("cancelled");
    }
    const deadline = this.#timer(this.#totalTimeoutMs);
    let timedOut = false;
    const controller = new AbortController();
    deadline.promise.then(() => {
      timedOut = true;
      controller.abort();
    });
    const onCallerAbort = (): void => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
    let rejectAbort: (() => void) | undefined;
    const abortDeferred = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new SearchProviderError("cancelled"));
    });
    void abortDeferred.catch(() => {});
    const onAbortDeferred = (): void => rejectAbort?.();
    signal.addEventListener("abort", onAbortDeferred, { once: true });
    const deadlinePromise = deadline.promise.then(() => {
      throw new SearchProviderError("timeout");
    });
    try {
      return await Promise.race([
        this.#perform(path, options, controller),
        deadlinePromise,
        abortDeferred,
      ]);
    } catch (error) {
      if (signal.aborted) {
        throw new SearchProviderError("cancelled");
      }
      if (timedOut) {
        throw new SearchProviderError("timeout");
      }
      if (error instanceof SearchProviderError) {
        throw error;
      }
      throw new SearchProviderError("network_unavailable");
    } finally {
      deadline.cancel();
      controller.abort();
      signal.removeEventListener("abort", onCallerAbort);
      signal.removeEventListener("abort", onAbortDeferred);
    }
  }

  async #perform(
    path: string,
    options: ProviderHttpRequestOptions,
    controller: AbortController,
  ): Promise<ProviderHttpResponse> {
    const response = await this.#transport.request(this.#endpoint, {
      method: options.method,
      path,
      headers: { ...(options.headers ?? {}) },
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      response.destroy();
      throw new SearchProviderError("cancelled");
    }
    const encoding = normalizeContentEncoding(response.headers);
    let body: Buffer;
    try {
      ({ buffer: body } = await readBoundedBody(
        response,
        encoding,
        options.maxResponseBytes ?? this.#maxResponseBytes,
        "GET",
        controller.signal,
      ));
    } catch (error) {
      response.destroy();
      if (controller.signal.aborted) {
        throw new SearchProviderError("cancelled");
      }
      if (error instanceof SearchProviderError) {
        throw error;
      }
      throw new SearchProviderError("response_too_large");
    }
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw new SearchProviderError("redirect_blocked");
    }
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new SearchProviderError("unauthorized");
    }
    if (response.statusCode === 429) {
      throw new SearchProviderError("rate_limited", parseRetryAfter(response.headers["retry-after"]));
    }
    if (response.statusCode >= 400) {
      // non-special 4xx (400/404/422/...) and 5xx: never treated as success JSON
      throw new SearchProviderError("provider_unavailable");
    }
    return {
      statusCode: response.statusCode,
      headers: { ...response.headers },
      body,
    };
  }
}
