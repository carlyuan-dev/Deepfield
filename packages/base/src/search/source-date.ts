export interface SourceDateMetadata {
  provider: string;
  fieldName?: string;
  rawValue?: string;
  normalizedValue?: string;
  precision: "day" | "datetime" | "unknown";
  nature: "published" | "unknown";
  evidenceSource: "provider_metadata" | "unknown";
  status: "valid" | "missing" | "unparseable" | "invalid_type" | "unknown";
  rawType?: "null" | "number" | "boolean" | "object" | "array";
  rawValueTruncated?: boolean;
  rawValueBytes?: number;
  rawValueHash?: string;
}
