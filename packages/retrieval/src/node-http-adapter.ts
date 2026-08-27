import http from "node:http";
import https from "node:https";
import {
  TransportError,
  type RequestOptions,
  type RequestTarget,
  type TransportAdapter,
  type TransportResponse,
} from "./http-transport.js";
import type { DnsAnswer } from "./url-policy.js";

/**
 * Production adapter: binds node:http/node:https sockets to the exact
 * policy-checked addresses via a pinned lookup. The hostname passed by Node is
 * verified against the validated target, so a second DNS resolution can never
 * happen behind the policy's back.
 */
export function createNodeHttpAdapter(): TransportAdapter {
  return {
    async request(
      target: RequestTarget,
      options: RequestOptions,
      addresses: readonly DnsAnswer[],
    ): Promise<TransportResponse> {
      const mod = target.protocol === "https:" ? https : http;
      const lookup = (
        hostname: string,
        _opts: unknown,
        callback: (error: Error | null, address?: string, family?: number) => void,
      ): void => {
        if (hostname.toLowerCase() !== target.hostname.toLowerCase()) {
          callback(new Error("pinned hostname mismatch"));
          return;
        }
        if (addresses.length === 0) {
          callback(new Error("no pinned addresses"));
          return;
        }
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      };
      return new Promise<TransportResponse>((resolve, reject) => {
        const request = mod.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: target.path,
            method: target.method,
            headers: options.headers,
            lookup: lookup as never,
            signal: options.signal,
            timeout: options.connectTimeoutMs,
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
        request.on("error", () => reject(new TransportError("network_unavailable")));
        request.on("timeout", () => {
          request.destroy();
          reject(new TransportError("network_unavailable"));
        });
      });
    },
  };
}
