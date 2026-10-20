import type * as BaseModel from "@deepfield/base/model";

import type { SourceDateMetadata } from "@deepfield/base/search";
export type { SourceDateMetadata } from "@deepfield/base/search";
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

export type ModelTextClipping = BaseModel.ModelTextClipping;

export interface ModelToolOrigin {
  toolName: string;
  sources: ModelEvidenceSource[];
  formatting?: ModelTextClipping;
}

export type ModelRequestOriginRange = BaseModel.ModelRequestOriginRange<ModelToolOrigin>;
export type ModelRequestObservationInput = BaseModel.ModelRequestObservationInput<ModelToolOrigin, "ordinary" | "synthesis">;
export type EvidenceProjection = BaseModel.EvidenceProjection<ModelToolOrigin>;
export type ModelRequestObservation = BaseModel.ModelRequestObservation<ModelToolOrigin, "ordinary" | "synthesis">;
export type ModelRequestObserver = BaseModel.ModelRequestObserver<ModelToolOrigin, "ordinary" | "synthesis">;
