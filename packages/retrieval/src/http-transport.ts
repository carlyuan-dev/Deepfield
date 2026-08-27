import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { UrlPolicy, type CheckedTarget, type DnsAnswer } from "./url-policy.js";
import {
  normalizeContentEncoding,
  normalizeMediaType,
  readBoundedBody,
} from "./bounded-reader.js";

export type TransportFailureCode =
  | "url_blocked"
  | "network_unavailable"
  | "redirect_blocked"
  | "response_too_large"
  | "unsupported_content_type"
  | "timeout"
  | "cancelled";

const FIXED_MESSAGES: Record<TransportFailureCode, string> = {
  url_blocked: "url blocked by policy",
  network_unavailable: "network request failed",
  redirect_blocked: "redirect rejected",
  response_too_large: "response too large",
  unsupported_content_type: "unsupported response content",
  timeout: "request timeout",
  cancelled: "request cancelled",
};

export class TransportError extends Error {
  readonly code: TransportFailureCode;

  constructor(code: TransportFailureCode) {
    super(FIXED_MESSAGES[code]);
    this.name = "TransportError";
    this.code = code;
  }
}

export interface RequestTarget {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
  method: "GET" | "HEAD";
}

export interface RequestOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
  connectTimeoutMs: number;
}

export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
  destroy(): void;
}

export interface TransportAdapter {
  request(
    target: RequestTarget,
    options: RequestOptions,
    addresses: readonly DnsAnswer[],
  ): Promise<TransportResponse>;
}

export interface HostTimer {
  promise: Promise<void>;
  cancel(): void;
}

export interface SafeHttpTransportOptions {
  policy: UrlPolicy;
  adapter: TransportAdapter;
  maxBodyBytes: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  timer?: (ms: number) => HostTimer;
}

export interface FetchOptions {
  method?: "GET" | "HEAD";
  signal: AbortSignal;
  maxBodyBytes?: number;
}

export interface FetchResult {
  statusCode: number;
  finalUrl: string;
  contentType: string;
  body: Buffer;
  decompressedBytes: number;
  sha256: string;
}

const USER_AGENT = "deepfield-retrieval/0.1 (public web retrieval)";
const ALLOWED_HEADERS: Record<string, string> = {
  "user-agent": USER_AGENT,
  accept: "*/*",
  "accept-encoding": "gzip, deflate, identity",
};
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_LOCATION_LENGTH = 2048;

function defaultTimer(ms: number): HostTimer {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
    if (typeof timeout === "object" && "unref" in timeout) {
      timeout.unref();
    }
  });
  return {
    promise,
    cancel: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}

export class SafeHttpTransport {
  readonly #policy: UrlPolicy;
  readonly #adapter: TransportAdapter;
  readonly #maxBodyBytes: number;
  readonly #connectTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxRedirects: number;
  readonly #timer: (ms: number) => HostTimer;

  constructor(options: SafeHttpTransportOptions) {
    this.#policy = options.policy;
    this.#adapter = options.adapter;
    this.#maxBodyBytes = options.maxBodyBytes;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#timer = options.timer ?? defaultTimer;
  }

  async fetch(urlString: string, fetchOptions: FetchOptions): Promise<FetchResult> {
    const method = fetchOptions.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      throw new TransportError("url_blocked");
    }
    const { signal } = fetchOptions;
    if (signal.aborted) {
      throw new TransportError("cancelled");
    }
    const maxBodyBytes = fetchOptions.maxBodyBytes ?? this.#maxBodyBytes;
    // The total deadline starts before DNS and is never reset per redirect.
    const deadline = this.#timer(this.#totalTimeoutMs);
    let timedOut = false;
    deadline.promise.then(() => {
      timedOut = true;
      controller.abort();
    });
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
    let current: CheckedTarget | undefined;
    try {
      const first = await this.#policy.check(urlString);
      if (!first.ok) {
        throw new TransportError(first.code);
      }
      current = first.target;
      for (let hop = 0; hop <= this.#maxRedirects; hop += 1) {
        if (controller.signal.aborted) {
          break;
        }
        const response = await this.#adapter.request(
          {
            protocol: current.protocol,
            hostname: current.hostname,
            port: current.port,
            path: current.path,
            method,
          },
          {
            headers: { ...ALLOWED_HEADERS },
            signal: controller.signal,
            connectTimeoutMs: this.#connectTimeoutMs,
          },
          current.addresses,
        );
        const location = this.#redirectLocation(response);
        if (location !== undefined) {
          const next = await this.#policy.check(new URL(location, current.href).href);
          if (!next.ok) {
            throw new TransportError(next.code);
          }
          current = next.target;
          continue;
        }
        const encoding = normalizeContentEncoding(response.headers);
        const { buffer, decompressedBytes } = await readBoundedBody(
          response,
          encoding,
          maxBodyBytes,
          method,
          controller.signal,
        );
        return {
          statusCode: response.statusCode,
          finalUrl: current.href,
          contentType: normalizeMediaType(response.headers["content-type"]),
          body: buffer,
          decompressedBytes,
          sha256: createHash("sha256").update(buffer).digest("hex"),
        };
      }
      throw new TransportError("redirect_blocked");
    } catch (error) {
      if (signal.aborted) {
        throw new TransportError("cancelled");
      }
      if (timedOut || controller.signal.aborted) {
        throw new TransportError("timeout");
      }
      if (error instanceof TransportError) {
        throw error;
      }
      // Any adapter/decoder exception maps to a fixed safe failure; never
      // carry URL/IP/body/raw cause.
      throw new TransportError("network_unavailable");
    } finally {
      deadline.cancel();
      controller.abort();
      signal.removeEventListener("abort", onCallerAbort);
    }
  }

  #redirectLocation(response: TransportResponse): string | undefined {
    if (REDIRECT_CODES.has(response.statusCode)) {
      const location = response.headers["location"];
      if (
        typeof location !== "string" ||
        location.length === 0 ||
        location.length > MAX_LOCATION_LENGTH
      ) {
        throw new TransportError("redirect_blocked");
      }
      return location;
    }
    if (response.statusCode >= 300 && response.statusCode < 400) {
      // 3xx statuses outside the GET/HEAD redirect allowlist are rejected.
      throw new TransportError("redirect_blocked");
    }
    return undefined;
  }
}

export function createSafeHttpTransport(options: SafeHttpTransportOptions): SafeHttpTransport {
  return new SafeHttpTransport(options);
}
