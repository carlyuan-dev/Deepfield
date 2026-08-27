import { Readable } from "node:stream";
import http from "node:http";
import https from "node:https";
import { SearchProviderError } from "./search-provider.js";
import { readBoundedBody, normalizeContentEncoding } from "./bounded-reader.js";
import type { HostTimer } from "./http-transport.js";

export interface ProviderEndpoint {
  /** Compiled-in fixed origin, e.g. "https://api.search.brave.com". */
  origin: string;
  /** Compiled-in path prefix, e.g. "/res/v1/web/search". */
  pathPrefix: string;
}

export interface ProviderHttpRequestOptions {
  method: "GET" | "POST";
  /** Full request path (prefix + query/body routing); appended to the fixed origin. */
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
  /** Parsed Retry-After in milliseconds (only for valid integer seconds). */
  retryAfterMs?: number;
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
  request(endpoint: ProviderEndpoint, request: ProviderTransportRequest): Promise<ProviderTransportResponse>;
}

export interface ProviderHttpClientDeps {
  transport: ProviderTransport;
  timer?: (ms: number) => HostTimer;
  maxResponseBytes?: number;
  totalTimeoutMs?: number;
  connectTimeoutMs?: number;
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
 * Fixed-origin provider HTTP client. The origin is compiled into adapters —
 * callers never pass arbitrary origins. Redirects are rejected, response
 * bodies are bounded during streaming (decompressed size), and the total
 * deadline/abort races the whole request so a stuck socket can never block
 * the return. Authorization headers never appear in errors or diagnostics.
 */
export class ProviderHttpClient {
  readonly #transport: ProviderTransport;
  readonly #timer: (ms: number) => HostTimer;
  readonly #maxResponseBytes: number;
  readonly #totalTimeoutMs: number;
  readonly #connectTimeoutMs: number;

  constructor(deps: ProviderHttpClientDeps) {
    this.#transport = deps.transport;
    this.#timer = deps.timer ?? defaultHostTimer;
    this.#maxResponseBytes = deps.maxResponseBytes ?? 2 * 1024 * 1024;
    this.#totalTimeoutMs = deps.totalTimeoutMs ?? 30_000;
    this.#connectTimeoutMs = deps.connectTimeoutMs ?? 10_000;
  }

  async request(
    endpoint: ProviderEndpoint,
    options: ProviderHttpRequestOptions,
  ): Promise<ProviderHttpResponse> {
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
        this.#perform(endpoint, options, controller),
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
    endpoint: ProviderEndpoint,
    options: ProviderHttpRequestOptions,
    controller: AbortController,
  ): Promise<ProviderHttpResponse> {
    const response = await this.#transport.request(endpoint, {
      method: options.method,
      path: options.path,
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
    if (response.statusCode >= 500) {
      throw new SearchProviderError("provider_unavailable");
    }
    return {
      statusCode: response.statusCode,
      headers: { ...response.headers },
      body,
    };
  }
}

/** Default transport: node:http/https against the compiled-in endpoint. */
export function createNodeProviderTransport(): ProviderTransport {
  return {
    async request(endpoint, request) {
      const mod = endpoint.origin.startsWith("https:") ? https : http;
      return new Promise<ProviderTransportResponse>((resolve, reject) => {
        const outgoing = mod.request(
          endpoint.origin + request.path,
          {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
          },
          (response) => {
            const headers: Record<string, string | string[] | undefined> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              headers[name] = value as string | string[] | undefined;
            }
            resolve({
              statusCode: response.statusCode ?? 0,
              headers,
              body: response,
              destroy: () => response.destroy(),
            });
          },
        );
        outgoing.on("error", () => reject(new SearchProviderError("network_unavailable")));
        if (request.body !== undefined) {
          outgoing.write(request.body);
        }
        outgoing.end();
      });
    },
  };
}
