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
/** Text actually serialized by a model adapter. This does not imply provider consumption. */
export interface ModelEvidenceSource {
  url: string;
  title: string;
  /** Actual fetch identities; url remains the returned canonical/source URL. */
  requestedUrl?: string;
  finalUrl?: string;
  kind?: "search_snippet" | "page_excerpt";
  sourceDate?: SourceDateMetadata;
}

export interface ModelTextClipping {
  version: string;
  beforeBytes: number;
  beforeHash: string;
  afterBytes: number;
  afterHash: string;
  omittedItems: number | null;
}

export interface ModelToolOrigin {
  toolName: string;
  sources: ModelEvidenceSource[];
  formatting?: ModelTextClipping;
}

/** UTF-16 offsets in one program-produced input message, not generated assistant text. */
export interface ModelRequestOriginRange {
  messageIndex: number;
  toolCallId: string;
  origin: ModelToolOrigin;
  start: number;
  end: number;
  modelClipping?: ModelTextClipping;
  sourceLocatorText?: string;
}

export interface ModelRequestObservationInput {
  requestId: string;
  phase: "ordinary" | "synthesis";
  origins: ModelRequestOriginRange[];
}

export interface EvidenceProjection {
  projectionId: string;
  toolCallId: string;
  /** Position in the serialized adapter messages array. */
  messageIndex: number;
  contentBlockIndex?: number;
  origin: ModelToolOrigin;
  mapping: "mapped" | "unmapped";
  text: string;
  start: number;
  end: number;
  visibleBytes: number;
  visibleHash: string;
  modelClipping?: ModelTextClipping;
  sourceLocatorText?: string;
}

export interface ModelRequestObservation {
  modelRequestId: string;
  requestId: string;
  phase: "ordinary" | "synthesis";
  state: "prepared" | "dispatched" | "failed";
  responseState: "pending" | "succeeded" | "failed" | "not_sent";
  responseStatus?: number;
  projections: EvidenceProjection[];
}

export type ModelRequestObserver = (event: ModelRequestObservation) => void;
