export interface ModelTextClipping {
  version: string;
  beforeBytes: number;
  beforeHash: string;
  afterBytes: number;
  afterHash: string;
  omittedItems: number | null;
}

/** UTF-16 offsets in one program-produced input message, not generated assistant text. */
export interface ModelRequestOriginRange<Origin> {
  messageIndex: number;
  toolCallId: string;
  origin: Origin;
  start: number;
  end: number;
  modelClipping?: ModelTextClipping;
  sourceLocatorText?: string;
}

export interface ModelRequestObservationInput<Origin, Phase extends string> {
  requestId: string;
  phase: Phase;
  origins: ModelRequestOriginRange<Origin>[];
}

export interface EvidenceProjection<Origin> {
  projectionId: string;
  toolCallId: string;
  /** Position in the serialized adapter messages array. */
  messageIndex: number;
  contentBlockIndex?: number;
  origin: Origin;
  mapping: "mapped" | "unmapped";
  text: string;
  start: number;
  end: number;
  visibleBytes: number;
  visibleHash: string;
  modelClipping?: ModelTextClipping;
  sourceLocatorText?: string;
}

export interface ModelRequestObservation<Origin, Phase extends string> {
  modelRequestId: string;
  requestId: string;
  phase: Phase;
  state: "prepared" | "dispatched" | "failed";
  responseState: "pending" | "succeeded" | "failed" | "not_sent";
  responseStatus?: number;
  projections: EvidenceProjection<Origin>[];
}

export type ModelRequestObserver<Origin, Phase extends string> = (event: ModelRequestObservation<Origin, Phase>) => void;
