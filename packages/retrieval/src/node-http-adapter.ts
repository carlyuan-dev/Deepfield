import http from "node:http";
import https from "node:https";
import {
  TransportError,
  defaultHostTimer,
  type HostTimer,
  type RequestOptions,
  type RequestTarget,
  type TransportAdapter,
  type TransportResponse,
} from "./http-transport.js";
import type { DnsAnswer } from "./url-policy.js";

export interface NodeLookupOptions {
  all?: boolean;
  family?: number;
  verbatim?: boolean;
}

type LookupCallback = (
  error: Error | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * Pinned lookup: serves ONLY the policy-checked address snapshot and never
 * re-resolves. Node 24's autoSelectFamily calls the lookup with all:true and
 * requires the array form; single mode returns the first address matching the
 * requested family. Hostname is verified against the validated target so a
 * socket can never bind to an unvalidated address.
 */
export function createPinnedLookup(
  targetHostname: string,
  addresses: readonly DnsAnswer[],
): (hostname: string, options: NodeLookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    if (typeof hostname !== "string" || hostname.toLowerCase() !== targetHostname.toLowerCase()) {
      callback(new Error("pinned hostname mismatch"));
      return;
    }
    if (addresses.length === 0) {
      callback(new Error("no pinned addresses"));
      return;
    }
    if (options.all === true) {
      // Full validated snapshot (every entry already passed the public check).
      callback(
        null,
        addresses.map((answer) => ({ address: answer.address, family: answer.family })),
      );
      return;
    }
    const family = options.family ?? 0;
    const match = addresses.find((answer) => family === 0 || answer.family === family);
    if (match === undefined) {
      callback(new Error("no pinned address for the requested family"));
      return;
    }
    callback(null, match.address, match.family);
  };
}

export interface NodeSocketLike {
  on(event: "connect" | "secureConnect" | "error", listener: () => void): unknown;
  removeListener(event: "connect" | "secureConnect" | "error", listener: () => void): unknown;
  destroy(): void;
}

export interface NodeClientRequestLike {
  on(event: "socket" | "response" | "error", listener: (...args: never[]) => void): unknown;
  destroy(): void;
}

export interface NodeRequestFactory {
  (
    options: Record<string, unknown>,
    responseListener: (response: unknown) => void,
  ): NodeClientRequestLike;
}

export interface NodeHttpAdapterOptions {
  /** Inject the client-request factory (tests); defaults to node:http/https. */
  request?: NodeRequestFactory;
  timer?: (ms: number) => HostTimer;
}

function defaultRequestFactory(
  options: Record<string, unknown>,
  responseListener: (response: unknown) => void,
): NodeClientRequestLike {
  const mod = options.protocol === "https:" ? https : http;
  const request = mod.request(options as never, (response) => responseListener(response));
  return {
    on: (event: string, listener: (...args: never[]) => void) => request.on(event, listener as never),
    destroy: () => request.destroy(),
  } as unknown as NodeClientRequestLike;
}

/**
 * Production adapter: pins the socket to the policy-checked addresses and
 * enforces a connect/TLS-handshake timeout via the socket lifecycle (connect
 * for http, secureConnect for https). The connect timer is cancelled once the
 * socket connects or the response starts, so it can never kill a live read;
 * connect timeout maps to TransportError("timeout").
 */
export function createNodeHttpAdapter(options: NodeHttpAdapterOptions = {}): TransportAdapter {
  const requestFactory = options.request ?? defaultRequestFactory;
  const timer = options.timer ?? defaultHostTimer;
  return {
    async request(
      target: RequestTarget,
      requestOptions: RequestOptions,
      addresses: readonly DnsAnswer[],
    ): Promise<TransportResponse> {
      const lookup = createPinnedLookup(target.hostname, addresses);
      return new Promise<TransportResponse>((resolve, reject) => {
        let finished = false;
        const cleanups: Array<() => void> = [];
        const finish = (): void => {
          for (const cleanup of cleanups.splice(0)) {
            cleanup();
          }
        };
        const request = requestFactory(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: target.path,
            method: target.method,
            headers: requestOptions.headers,
            lookup: lookup as never,
            signal: requestOptions.signal,
          },
          (response) => {
            if (finished) {
              return;
            }
            finish(); // response started: the connect timer must not kill reads
            const headers: Record<string, string | string[] | undefined> = {};
            const raw = (response as { headers?: Record<string, unknown> }).headers;
            if (raw !== undefined) {
              for (const [name, value] of Object.entries(raw)) {
                headers[name] = value as string | string[] | undefined;
              }
            }
            resolve({
              statusCode: (response as { statusCode?: number }).statusCode ?? 0,
              headers,
              body: response as never,
              destroy: () => (response as { destroy?: () => void }).destroy?.(),
            });
          },
        );
        request.on("error", () => {
          if (finished) {
            return;
          }
          finished = true;
          finish();
          request.destroy(); // symmetric cleanup for fake and real transports
          reject(new TransportError("network_unavailable"));
        });
        request.on("socket", (socket) => {
          const socketLike = socket as NodeSocketLike;
          const connectTimer = timer(requestOptions.connectTimeoutMs);
          let cleared = false;
          const clear = (): void => {
            if (cleared) {
              return;
            }
            cleared = true;
            connectTimer.cancel();
            socketLike.removeListener("connect", clear);
            socketLike.removeListener("secureConnect", clear);
            socketLike.removeListener("error", clear);
          };
          cleanups.push(clear);
          socketLike.on("connect", clear);
          socketLike.on("secureConnect", clear);
          socketLike.on("error", clear);
          connectTimer.promise.then(() => {
            if (finished || cleared) {
              return;
            }
            finished = true;
            clear();
            request.destroy();
            reject(new TransportError("timeout"));
          });
        });
      });
    },
  };
}
