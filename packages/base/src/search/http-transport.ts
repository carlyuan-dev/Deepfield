import { Readable } from "node:stream";
import { UrlPolicy, type CheckedTarget, type DnsAnswer, type UrlCheckResult } from "./url-policy.js";
import { performFetch } from "./transport-loop.js";

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
  /** Called only after policy/abort checks, immediately before transport I/O. */
  onExternalDispatch?: () => void;
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

export function defaultHostTimer(ms: number): HostTimer {
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

function assertFinitePositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`invalid ${name}`);
  }
}

export class SafeHttpTransport {
  readonly #policy: UrlPolicy;
  readonly #adapter: TransportAdapter;
  readonly #hardMaxBodyBytes: number;
  readonly #connectTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxRedirects: number;
  readonly #timer: (ms: number) => HostTimer;

  constructor(options: SafeHttpTransportOptions) {
    this.#policy = options.policy;
    this.#adapter = options.adapter;
    this.#hardMaxBodyBytes = options.maxBodyBytes;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#timer = options.timer ?? defaultHostTimer;
    assertFinitePositiveInteger(this.#hardMaxBodyBytes, "maxBodyBytes");
    assertFinitePositiveInteger(this.#connectTimeoutMs, "connectTimeoutMs");
    assertFinitePositiveInteger(this.#totalTimeoutMs, "totalTimeoutMs");
    if (options.maxRedirects !== undefined) {
      if (
        !Number.isFinite(options.maxRedirects) ||
        !Number.isInteger(options.maxRedirects) ||
        options.maxRedirects < 0
      ) {
        throw new TypeError("invalid maxRedirects");
      }
    }
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
    const maxBodyBytes = this.#effectiveMaxBytes(
      fetchOptions.maxBodyBytes ?? this.#hardMaxBodyBytes,
    );
    // The total deadline is created once, before DNS, and crosses every
    // redirect; it is never reset per hop.
    const deadline = this.#timer(this.#totalTimeoutMs);
    let timedOut = false;
    const controller = new AbortController();
    deadline.promise.then(() => {
      timedOut = true;
      controller.abort();
    });
    const onCallerAbort = (): void => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
    // Both the deadline and the caller abort RACE the whole operation so a
    // stuck DNS/adapter (that ignores the signal) can never block the return.
    const deadlinePromise = deadline.promise.then(() => {
      throw new TransportError("timeout");
    });
    let rejectCancelled: () => void = () => {};
    const abortPromise = new Promise<never>((_, reject) => {
      rejectCancelled = () => reject(new TransportError("cancelled"));
      if (signal.aborted) {
        rejectCancelled();
        return;
      }
      signal.addEventListener("abort", rejectCancelled, { once: true });
    });
    try {
      return await Promise.race([
        this.#run(
          urlString,
          method,
          maxBodyBytes,
          controller,
          fetchOptions.onExternalDispatch,
        ),
        deadlinePromise,
        abortPromise,
      ]);
    } catch (error) {
      if (signal.aborted) {
        throw new TransportError("cancelled"); // cancel wins over timeout
      }
      if (timedOut) {
        throw new TransportError("timeout");
      }
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError("network_unavailable");
    } finally {
      deadline.cancel();
      controller.abort();
      signal.removeEventListener("abort", onCallerAbort);
      signal.removeEventListener("abort", rejectCancelled);
    }
  }

  async #run(
    urlString: string,
    method: "GET" | "HEAD",
    maxBodyBytes: number,
    controller: AbortController,
    onExternalDispatch?: () => void,
  ): Promise<FetchResult> {
    return performFetch(
      this.#policy,
      this.#adapter,
      urlString,
      method,
      maxBodyBytes,
      this.#maxRedirects,
      this.#connectTimeoutMs,
      controller,
      { ...ALLOWED_HEADERS },
      onExternalDispatch,
    );
  }

  #effectiveMaxBytes(requested: number): number {
    if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested < 0) {
      // invalid per-call config fails closed; 0 is legal (HEAD)
      throw new TransportError("url_blocked");
    }
    return Math.min(requested, this.#hardMaxBodyBytes);
  }
}

export function createSafeHttpTransport(options: SafeHttpTransportOptions): SafeHttpTransport {
  return new SafeHttpTransport(options);
}
