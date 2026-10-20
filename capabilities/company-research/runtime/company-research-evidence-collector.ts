import type { ModelRequestObservation } from "@deepfield/capability-sdk";
import { evidenceBytes, evidenceHash, snapshotManifest, validateEvidenceReceipts, utf8Prefix, type ArchivedProjection, type EvidenceReceipt, type EvidenceManifest } from "../persistence/research-evidence-data.js";

/** One tool-result group is saved once; sources describe association, not isolated supporting quotations. */
export class ResearchEvidenceCollector {
  private events: EvidenceReceipt[] = [];
  private blobs = new Map<string, string>();
  private archivedTexts = new Map<string, string>();
  private archiveReasons = new Map<string, ArchivedProjection["archiveClipping"]["reason"]>();
  private projections = new Map<string, ArchivedProjection>();
  private totalBytes = 0;
  constructor(private requestId: string, private emit: (receipt: EvidenceReceipt) => void) {}
  observe = (observation: ModelRequestObservation): void => {
    if (observation.requestId !== this.requestId) throw new Error("evidence_incomplete: foreign request");
    const projections = observation.projections.map(projection => {
      if (evidenceBytes(projection.text) !== projection.visibleBytes || evidenceHash(projection.text) !== projection.visibleHash) throw new Error("evidence_incomplete: projection hash");
      const existing = this.projections.get(projection.projectionId);
      if (existing) {
        if (existing.visibleHash !== projection.visibleHash || existing.visibleBytes !== projection.visibleBytes || existing.toolCallId !== projection.toolCallId || existing.messageIndex !== projection.messageIndex || existing.contentBlockIndex !== projection.contentBlockIndex || existing.mapping !== projection.mapping || existing.toolName !== projection.origin.toolName || JSON.stringify(existing.sources) !== JSON.stringify(projection.origin.sources) || JSON.stringify(existing.formatting) !== JSON.stringify(projection.origin.formatting) || JSON.stringify(existing.modelClipping) !== JSON.stringify(projection.modelClipping)) throw new Error("evidence_incomplete: changed projection");
        return existing;
      }
      const priorBlob = this.archivedTexts.get(projection.visibleHash);
      const remaining = Math.max(0, 512 * 1024 - this.totalBytes);
      const reason = this.archiveReasons.get(projection.visibleHash) ?? (this.blobs.size >= 200 ? "entry_limit" : remaining === 0 ? "total_limit" : projection.visibleBytes > Math.min(12 * 1024, remaining) ? remaining < 12 * 1024 ? "total_limit" : "item_limit" : "none");
      const savedText = priorBlob ?? utf8Prefix(projection.text, reason === "entry_limit" ? 0 : Math.min(12 * 1024, remaining));
      if (priorBlob === undefined && savedText) {
        this.archivedTexts.set(projection.visibleHash, savedText);
        this.archiveReasons.set(projection.visibleHash, reason);
        const savedHash = evidenceHash(savedText);
        if (!this.blobs.has(savedHash)) { this.blobs.set(savedHash, savedText); this.totalBytes += evidenceBytes(savedText); }
      }
      const value: ArchivedProjection = { evidenceId: projection.projectionId, toolCallId: projection.toolCallId, messageIndex: projection.messageIndex,
        ...(projection.contentBlockIndex === undefined ? {} : { contentBlockIndex: projection.contentBlockIndex }),
        mapping: projection.mapping, sources: projection.origin.sources, toolName: projection.origin.toolName,
        savedText, visibleBytes: projection.visibleBytes, visibleHash: projection.visibleHash, savedBytes: evidenceBytes(savedText), savedHash: evidenceHash(savedText), capturedAt: new Date().toISOString(),
        ...(projection.modelClipping ? { modelClipping: projection.modelClipping } : {}), ...(projection.origin.formatting ? { formatting: projection.origin.formatting } : {}),
        archiveClipping: { reason: savedText === projection.text ? "none" : reason === "none" ? "item_limit" : reason, omittedBytes: projection.visibleBytes - evidenceBytes(savedText) } };
      this.projections.set(projection.projectionId, value); return value;
    });
    const receipt: EvidenceReceipt = { sequence: this.events.length + 1, modelRequestId: observation.modelRequestId, requestId: observation.requestId,
      phase: observation.phase, state: observation.state, responseState: observation.responseState, ...(observation.responseStatus === undefined ? {} : { responseStatus: observation.responseStatus }), projections };
    const metadata = JSON.stringify([...this.events, receipt], (key, value) => key === "savedText" ? undefined : value);
    validateEvidenceReceipts([...this.events, receipt]);
    if (evidenceBytes(metadata) > 1024 * 1024 - 4096) throw new Error("evidence_incomplete: metadata limit");
    this.events.push(receipt); this.emit(receipt);
  };
  manifest(): EvidenceManifest {
    if (!this.events.length) throw new Error("evidence_incomplete: no request observation");
    const manifest = snapshotManifest(this.events);
    if (this.events.some(event => event.projections.some(projection => projection.mapping === "unmapped"))) throw new Error("evidence_incomplete: unmapped projection");
    return manifest;
  }
}
