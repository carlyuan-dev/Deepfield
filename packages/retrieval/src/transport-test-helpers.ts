import { Readable } from "node:stream";
import { SafeHttpTransport, type TransportAdapter, type TransportResponse } from "./http-transport.js";
import { UrlPolicy, type DnsAnswer, type DnsLookup } from "./url-policy.js";

export const PUBLIC_V4: DnsAnswer = { address: "93.184.216.34", family: 4 };

export function publicLookup(): DnsLookup {
  return async () => [PUBLIC_V4];
}

export function makePolicy(): UrlPolicy {
  return new UrlPolicy({ lookup: publicLookup() });
}

/** Alias kept for transport tests. */
export function policy(): UrlPolicy {
  return makePolicy();
}

export function fetchOptions(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  addresses: readonly DnsAnswer[];
}

export function scriptedAdapter(
  script: Array<() => TransportResponse>,
): TransportAdapter & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let index = 0;
  return {
    requests,
    async request(target, options, addresses) {
      requests.push({
        method: target.method,
        path: target.path,
        headers: options.headers,
        addresses,
      });
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error("no more scripted responses");
      }
      return next();
    },
  };
}

export function htmlResponse(
  body: string | Buffer,
  extraHeaders: Record<string, string | string[]> = {},
): TransportResponse {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
    body: Readable.from([buffer]),
    destroy() {},
  };
}

export function pdfResponse(body: string | Buffer): TransportResponse {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    statusCode: 200,
    headers: { "content-type": "application/pdf" },
    body: Readable.from([buffer]),
    destroy() {},
  };
}

export function makeTransport(
  adapter: TransportAdapter,
  options: { maxBodyBytes?: number } = {},
): SafeHttpTransport {
  return new SafeHttpTransport({
    policy: makePolicy(),
    adapter,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
  });
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  addresses: readonly DnsAnswer[];
}

export function adapterFor(
  script: Array<() => TransportResponse>,
): TransportAdapter & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let index = 0;
  return {
    requests,
    async request(target, options, addresses) {
      requests.push({ method: target.method, path: target.path, headers: options.headers, addresses });
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error("no more scripted responses");
      }
      return next();
    },
  };
}

export function redirectResponse(location: string, statusCode = 302): TransportResponse {
  return {
    statusCode,
    headers: { location },
    body: Readable.from([]),
    destroy() {},
  };
}
