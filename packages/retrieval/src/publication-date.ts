import { createHash } from "node:crypto";
import type { SourceDateMetadata } from "../../capability-sdk/src/model-observation.js";
import { isValidDateString } from "./search-provider.js";

/** Server-only raw metadata capture, before provider date normalization. */
export function publicationDate(provider: string, fieldName: string, value: unknown): SourceDateMetadata {
  if (!((provider === "doubao" && fieldName === "PublishTime") || (provider === "tavily" && fieldName === "published_date"))) return { provider, precision: "unknown", nature: "unknown", evidenceSource: "unknown", status: "unknown" };
  const base = { provider, fieldName, precision: "unknown" as const, nature: "published" as const, evidenceSource: "provider_metadata" as const };
  if (value === undefined) return { ...base, status: "missing" };
  if (typeof value !== "string") return { ...base, status: "invalid_type", rawType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value as "number" | "boolean" | "object" };
  const bytes = Buffer.byteLength(value, "utf8");
  let rawValue = "", used = 0;
  for (const char of value) { const size = Buffer.byteLength(char, "utf8"); if (used + size > 2048) break; rawValue += char; used += size; }
  const raw = bytes > 2048 ? { rawValue, rawValueTruncated: true, rawValueBytes: bytes, rawValueHash: createHash("sha256").update(value, "utf8").digest("hex") } : { rawValue: value };
  const day = value.slice(0, 10);
  const datetime = /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value));
  if (bytes <= 2048 && isValidDateString(day) && (value === day || datetime)) return { ...base, ...raw, status: "valid", normalizedValue: day, precision: datetime ? "datetime" : "day" };
  return { ...base, ...raw, status: "unparseable" };
}
