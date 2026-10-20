import { createHash } from "node:crypto";
import type { SourceDateMetadata } from "@deepfield/capability-sdk/model-observation";

export const evidenceHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const evidenceBytes = (text: string): number => Buffer.byteLength(text, "utf8");
export const evidenceMetadataJson = (value: unknown): string => JSON.stringify(value, (key, item) => key === "savedText" ? undefined : item);
export function utf8Prefix(text: string, limit: number): string {
  let bytes = 0; let result = "";
  for (const char of text) { const size = evidenceBytes(char); if (bytes + size > limit) break; result += char; bytes += size; }
  return result;
}
export interface EvidenceSource { url: string; title: string; requestedUrl?: string; finalUrl?: string; kind?: "search_snippet" | "page_excerpt"; sourceDate?: SourceDateMetadata }
export interface EvidenceClipping { version: string; beforeBytes: number; beforeHash: string; afterBytes: number; afterHash: string; omittedItems: number | null }
export interface ArchivedProjection {
  evidenceId: string; toolCallId: string; messageIndex: number; contentBlockIndex?: number;
  mapping: "mapped" | "unmapped"; sources: EvidenceSource[]; toolName: string;
  savedText: string; visibleBytes: number; visibleHash: string; savedBytes: number; savedHash: string;
  capturedAt: string; modelClipping?: EvidenceClipping; formatting?: EvidenceClipping;
  archiveClipping: { reason: "none" | "item_limit" | "total_limit" | "entry_limit"; omittedBytes: number };
}
export interface EvidenceReceipt {
  sequence: number; modelRequestId: string; requestId: string; phase: "ordinary" | "synthesis";
  state: "prepared" | "dispatched" | "failed"; responseState: "not_sent" | "pending" | "succeeded" | "failed";
  responseStatus?: number; projections: ArchivedProjection[];
}
export interface EvidenceManifest {
  version: 1; lastSequence: number; snapshotHash: string; receipts: number; dispatched: number; prepared: number;
  visibleEntries: number; savedEntries: number; visibleBytes: number; savedBytes: number; omittedEntries: number; omittedBytes: number;
}
export interface EvidenceSnapshot { version: 1; runId: string; attemptId: string; events: EvidenceReceipt[]; manifest: EvidenceManifest }
export interface FrozenSnapshot extends EvidenceSnapshot { frozen: true }
export interface FrozenEvidencePacket {
  body: string; hash: string; packetVersion: 1; algorithmVersion: string; snapshotHash: string;
  parameters: { maxCharacters: number; maxExcerptCharacters: number };
  selected: Array<{ evidenceId: string; modelRequestId: string; start: number; end: number; visibleBytes: number; savedBytes: number; includedBytes: number; includedHash: string }>;
  omitted: Array<{ evidenceId: string; reason: string }>; emptyReason?: "no_matching_saved_material";
}
export function validateEvidenceReceipts(events: EvidenceReceipt[]): void {
  const latest = new Map<string, EvidenceReceipt>();
  const projections = new Map<string, string>();
  for (const [index, event] of events.entries()) {
    const invalid = () => { throw new Error("evidence_incomplete: receipt lifecycle"); };
    if (event.sequence !== index + 1 || event.requestId !== events[0]!.requestId) invalid();
    if ((event.state === "prepared" && event.responseState !== "not_sent") ||
        (event.state === "dispatched" && !["pending", "succeeded", "failed"].includes(event.responseState)) ||
        (event.state === "failed" && !["not_sent", "failed"].includes(event.responseState))) invalid();
    const prior = latest.get(event.modelRequestId);
    if (prior) {
      if (prior.phase !== event.phase || evidenceMetadataJson(prior.projections) !== evidenceMetadataJson(event.projections)) invalid();
      if (prior.state === "failed" || ["succeeded", "failed"].includes(prior.responseState)) {
        if (prior.state !== event.state || prior.responseState !== event.responseState || prior.responseStatus !== event.responseStatus) invalid();
      } else if (prior.state === "dispatched" && event.responseState === "not_sent") invalid();
    }
    const ids = new Set<string>();
    for (const projection of event.projections) {
      if (ids.has(projection.evidenceId) || (projection.mapping === "mapped" && projection.messageIndex < 0)) invalid();
      ids.add(projection.evidenceId);
      const identity = evidenceMetadataJson(projection);
      const previous = projections.get(projection.evidenceId);
      if (previous !== undefined && previous !== identity) invalid();
      projections.set(projection.evidenceId, identity);
    }
    latest.set(event.modelRequestId, event);
  }
}
export function snapshotManifest(events: EvidenceReceipt[]): EvidenceManifest {
  const latest = new Map<string, EvidenceReceipt>();
  for (const event of events) latest.set(event.modelRequestId, event);
  let visibleEntries = 0, savedEntries = 0, visibleBytes = 0, savedBytes = 0, omittedEntries = 0, omittedBytes = 0;
  let dispatched = 0, prepared = 0;
  for (const receipt of latest.values()) {
    if (receipt.responseState === "not_sent") { prepared++; continue; }
    dispatched++;
    for (const projection of receipt.projections) {
      visibleEntries++; visibleBytes += projection.visibleBytes; savedBytes += projection.savedBytes;
      if (projection.savedBytes > 0) savedEntries++; else omittedEntries++;
      omittedBytes += projection.archiveClipping.omittedBytes;
    }
  }
  return { version: 1, lastSequence: events.length, snapshotHash: evidenceHash(evidenceMetadataJson(events)), receipts: latest.size,
    dispatched, prepared, visibleEntries, savedEntries, visibleBytes, savedBytes, omittedEntries, omittedBytes };
}
export interface CompanyResearchEvidenceRepository {
  append(runId: string, attemptId: string, event: EvidenceReceipt): void;
  readStaging(runId: string, attemptId: string): EvidenceSnapshot;
  freeze(runId: string, attemptId: string, manifest: EvidenceManifest): FrozenSnapshot;
  getFrozen(runId: string, attemptId: string): FrozenSnapshot | undefined;
  savePacketOnce(runId: string, attemptId: string, packet: FrozenEvidencePacket): void;
  getPacket(runId: string, attemptId: string): FrozenEvidencePacket | undefined;
  deleteByRunId(runId: string): void;
}
