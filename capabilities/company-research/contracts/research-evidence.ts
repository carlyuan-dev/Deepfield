import { Type, type Static } from "typebox";
import { SourceDateSchema } from "../../../packages/retrieval/src/output-contracts.js";
export type { ArchivedProjection, EvidenceReceipt, EvidenceManifest, EvidenceSnapshot, FrozenSnapshot, FrozenEvidencePacket } from "../../../packages/persistence/src/research-evidence-data.js";
const id = Type.String({ minLength: 1, maxLength: 200 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const count = Type.Integer({ minimum: 0, maximum: 100_000_000 });
const clipping = Type.Object({ version: id, beforeBytes: count, beforeHash: hash, afterBytes: count, afterHash: hash, omittedItems: Type.Union([count, Type.Null()]) }, { additionalProperties: false });
export const ArchivedProjectionSchema = Type.Object({
  evidenceId: id, toolCallId: id, messageIndex: Type.Integer({ minimum: -1 }), contentBlockIndex: Type.Optional(count),
  mapping: Type.Union([Type.Literal("mapped"), Type.Literal("unmapped")]),
  sources: Type.Array(Type.Object({ url: Type.String({ maxLength: 4000 }), title: Type.String({ maxLength: 2000 }),
    requestedUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, pattern: "^https?://" })),
    finalUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, pattern: "^https?://" })),
    sourceDate: Type.Optional(SourceDateSchema), kind: Type.Optional(Type.Union([Type.Literal("search_snippet"), Type.Literal("page_excerpt")])) }, { additionalProperties: false }), { maxItems: 200 }),
  toolName: id, savedText: Type.String({ maxLength: 12_288 }), visibleBytes: count, visibleHash: hash, savedBytes: count, savedHash: hash,
  capturedAt: Type.String({ maxLength: 64 }), modelClipping: Type.Optional(clipping), formatting: Type.Optional(clipping),
  archiveClipping: Type.Object({ reason: Type.Union([Type.Literal("none"), Type.Literal("item_limit"), Type.Literal("total_limit"), Type.Literal("entry_limit")]), omittedBytes: count }, { additionalProperties: false }),
}, { additionalProperties: false });
export const EvidenceReceiptSchema = Type.Object({ sequence: Type.Integer({ minimum: 1 }), modelRequestId: id, requestId: id,
  phase: Type.Union([Type.Literal("ordinary"), Type.Literal("synthesis")]), state: Type.Union([Type.Literal("prepared"), Type.Literal("dispatched"), Type.Literal("failed")]),
  responseState: Type.Union([Type.Literal("not_sent"), Type.Literal("pending"), Type.Literal("succeeded"), Type.Literal("failed")]), responseStatus: Type.Optional(count),
  projections: Type.Array(ArchivedProjectionSchema, { maxItems: 1000 }),
}, { additionalProperties: false });
export const EvidenceManifestSchema = Type.Object({ version: Type.Literal(1), lastSequence: count, snapshotHash: hash, receipts: count, dispatched: count, prepared: count,
  visibleEntries: count, savedEntries: count, visibleBytes: count, savedBytes: count, omittedEntries: count, omittedBytes: count }, { additionalProperties: false });
export const FrozenEvidencePacketSchema = Type.Object({ body: Type.String({ maxLength: 48_000 }), hash, packetVersion: Type.Literal(1), algorithmVersion: id, snapshotHash: hash,
  parameters: Type.Object({ maxCharacters: count, maxExcerptCharacters: count }, { additionalProperties: false }),
  selected: Type.Array(Type.Object({ evidenceId: id, modelRequestId: id, start: count, end: count, visibleBytes: count, savedBytes: count, includedBytes: count, includedHash: hash }, { additionalProperties: false }), { maxItems: 200 }),
  omitted: Type.Array(Type.Object({ evidenceId: id, reason: id }, { additionalProperties: false }), { maxItems: 1000 }), emptyReason: Type.Optional(Type.Literal("no_matching_saved_material")),
}, { additionalProperties: false });
export const EvidencePolicySchema = Type.Union([Type.Literal("required_v1"), Type.Literal("legacy_optional")]);
export const ResearchEvidenceViewSchema = Type.Union([
  Type.Object({ status: Type.Literal("evidence_incomplete") }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("legacy_missing") }, { additionalProperties: false }),
  Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
    counts: Type.Pick(EvidenceManifestSchema, ["visibleEntries", "savedEntries", "visibleBytes", "savedBytes", "omittedEntries", "omittedBytes", "prepared", "dispatched"]),
    groups: Type.Array(Type.Object({ modelRequestId: id, phase: EvidenceReceiptSchema.properties.phase,
      responseState: EvidenceReceiptSchema.properties.responseState,
      projections: Type.Array(Type.Pick(ArchivedProjectionSchema, ["evidenceId", "mapping", "sources", "toolName", "savedText", "visibleBytes", "savedBytes", "capturedAt", "modelClipping", "formatting", "archiveClipping"]), { maxItems: 1000 }),
    }, { additionalProperties: false }), { maxItems: 1000 }),
  }, { additionalProperties: false }),
]);
export type ResearchEvidenceView = Static<typeof ResearchEvidenceViewSchema>;
