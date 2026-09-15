import { createHash } from "node:crypto";
import {
  TransportError,
  type TransportAdapter,
  type TransportResponse,
} from "./http-transport.js";
import {
  normalizeContentEncoding,
  normalizeMediaType,
  readBoundedBody,
} from "./bounded-reader.js";
import type { UrlPolicy, CheckedTarget, UrlCheckResult } from "./url-policy.js";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_LOCATION_LENGTH = 2048;

/**
 * Runs the redirect loop: policy-check every hop, destroy every redirect
 * response before the next hop, read bodies bounded by the effective limit and
 * hand back the checked final address snapshot for the caller to pin sockets.
 * The caller's deadline/abort is delivered through `controller`.
 */
export async function performFetch(
  policy: UrlPolicy,
  adapter: TransportAdapter,
  urlString: string,
  method: "GET" | "HEAD",
  maxBodyBytes: number,
  maxRedirects: number,
  connectTimeoutMs: number,
  controller: AbortController,
  headers: Record<string, string>,
  onExternalDispatch?: () => void,
): Promise<{
  statusCode: number;
  finalUrl: string;
  contentType: string;
  body: Buffer;
  decompressedBytes: number;
  sha256: string;
}> {
  const first = await policy.check(urlString);
  if (!first.ok) {
    throw new TransportError(first.code);
  }
  let current: CheckedTarget = first.target;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (controller.signal.aborted) {
      throw new TransportError("cancelled");
    }
    let response: TransportResponse;
    try {
      onExternalDispatch?.();
      response = await adapter.request(
        {
          protocol: current.protocol,
          hostname: current.hostname,
          port: current.port,
          path: current.path,
          method,
        },
        {
          headers: { ...headers },
          signal: controller.signal,
          connectTimeoutMs,
        },
        current.addresses,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TransportError("cancelled");
      }
      throw error;
    }
    if (controller.signal.aborted) {
      response.destroy(); // late adapter resolve: destroy immediately
      throw new TransportError("cancelled");
    }
    let location: string | undefined;
    try {
      location = redirectLocation(response);
    } catch (error) {
      response.destroy();
      throw error;
    }
    if (location !== undefined) {
      response.destroy(); // consumed redirect: never leave the body draining
      let next: UrlCheckResult;
      try {
        next = await policy.check(new URL(location, current.href).href);
      } catch {
        throw new TransportError("redirect_blocked"); // invalid Location URL
      }
      if (!next.ok) {
        throw new TransportError(next.code);
      }
      current = next.target;
      continue;
    }
    let buffer: Buffer;
    let decompressedBytes: number;
    try {
      if (method === "HEAD") {
        // HEAD carries no body: decoding is irrelevant (content-encoding is
        // ignored), the would-be body is destroyed, and the result is empty.
        response.destroy();
        buffer = Buffer.alloc(0);
        decompressedBytes = 0;
      } else {
        const encoding = normalizeContentEncoding(response.headers);
        ({ buffer, decompressedBytes } = await readBoundedBody(
          response,
          encoding,
          maxBodyBytes,
          method,
          controller.signal,
        ));
      }
    } catch (error) {
      response.destroy(); // encoding/decoder/overrun/abort paths all clean up
      throw error;
    }
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
}

function redirectLocation(response: TransportResponse): string | undefined {
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
    throw new TransportError("redirect_blocked");
  }
  return undefined;
}
