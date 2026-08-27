import { Readable } from "node:stream";
import { createGunzip, createInflate } from "node:zlib";
import { TransportError, type TransportResponse } from "./http-transport.js";

export type ContentEncoding = "identity" | "gzip" | "deflate";

export function normalizeContentEncoding(
  headers: TransportResponse["headers"],
): ContentEncoding {
  const raw = headers["content-encoding"];
  if (raw === undefined) {
    return "identity";
  }
  if (Array.isArray(raw)) {
    throw new TransportError("unsupported_content_type");
  }
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "identity") {
    return "identity";
  }
  if (value === "gzip") {
    return "gzip";
  }
  if (value === "deflate") {
    return "deflate";
  }
  throw new TransportError("unsupported_content_type");
}

export function normalizeMediaType(value: string | string[] | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * Streams the response body with the limit applied to DECOMPRESSED bytes, so a
 * compression bomb is destroyed the moment the decoded size crosses the cap —
 * never buffered whole first. Unsupported/malformed encodings fail safely and
 * an abort destroys the response and the decoder.
 */
export async function readBoundedBody(
  response: TransportResponse,
  encoding: ContentEncoding,
  maxBytes: number,
  method: "GET" | "HEAD",
  signal: AbortSignal,
): Promise<{ buffer: Buffer; decompressedBytes: number }> {
  if (method === "HEAD") {
    // A HEAD response carries no body; content-length describes the would-be
    // GET body and must not trip the size limit.
    return { buffer: Buffer.alloc(0), decompressedBytes: 0 };
  }
  const declared = response.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > maxBytes) {
    response.destroy();
    throw new TransportError("response_too_large");
  }
  let stream: Readable = response.body;
  if (encoding === "gzip") {
    stream = response.body.pipe(createGunzip());
  } else if (encoding === "deflate") {
    stream = response.body.pipe(createInflate());
  }
  const onAbort = (): void => {
    response.destroy();
    stream.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        stream.destroy();
        throw new TransportError("response_too_large");
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), decompressedBytes: total };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
