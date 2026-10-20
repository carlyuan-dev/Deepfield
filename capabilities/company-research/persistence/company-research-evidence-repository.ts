import type { Database } from "@deepfield/base/database";
import { evidenceBytes, evidenceHash, evidenceMetadataJson, snapshotManifest, validateEvidenceReceipts, type CompanyResearchEvidenceRepository, type EvidenceReceipt, type FrozenSnapshot, type FrozenEvidencePacket } from "./research-evidence-data.js";
import { storedReceiptShape, storedSnapshotShape, storedPacketShape } from "./research-evidence-validation.js";
function parseStoredEvidence<T>(text: string, valid: (value: unknown) => boolean): T {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("evidence_incomplete: malformed stored JSON");
    throw error;
  }
  if (!valid(value)) throw new Error("evidence_incomplete: invalid stored evidence shape");
  return value as T;
}
export function createCompanyResearchEvidenceRepository(db: Database): CompanyResearchEvidenceRepository {
  function requireAttempt(runId: string, attemptId: string, researching = false): void {
    const row = db.prepare("SELECT status, evidence_attempt_id FROM company_research_runs WHERE id = ?").get(runId) as { status: string; evidence_attempt_id: string } | undefined;
    if (!row || row.evidence_attempt_id !== attemptId || researching && row.status !== "researching") throw new Error("evidence_incomplete: attempt/status");
  }
  function readEvents(runId: string, attemptId: string): EvidenceReceipt[] {
    return (db.prepare("SELECT event_json FROM company_research_evidence_events WHERE run_id = ? AND attempt_id = ? ORDER BY sequence").all(runId, attemptId) as { event_json: string }[]).map(row => hydrate(parseStoredEvidence<EvidenceReceipt>(row.event_json, storedReceiptShape), runId, attemptId));
  }
  function hydrate(event: EvidenceReceipt, runId: string, attemptId: string): EvidenceReceipt {
    for (const p of event.projections) {
      const row = db.prepare("SELECT text FROM company_research_evidence_blobs WHERE run_id = ? AND attempt_id = ? AND hash = ?").get(runId, attemptId, p.savedHash) as { text: string } | undefined;
      p.savedText = row?.text ?? "";
      if (evidenceBytes(p.savedText) !== p.savedBytes || evidenceHash(p.savedText) !== p.savedHash) throw new Error("evidence_incomplete: missing blob");
    }
    return event;
  }
  const repository: CompanyResearchEvidenceRepository = {
    append(runId, attemptId, event) {
      requireAttempt(runId, attemptId, true);
      if (repository.getFrozen(runId, attemptId)) throw new Error("evidence_incomplete: frozen");
      for (const p of event.projections) {
        if (p.savedBytes !== evidenceBytes(p.savedText) || p.savedHash !== evidenceHash(p.savedText) || p.savedBytes > 12 * 1024 || p.savedBytes > p.visibleBytes || p.archiveClipping.omittedBytes !== p.visibleBytes - p.savedBytes || (p.savedBytes === p.visibleBytes && p.savedHash !== p.visibleHash)) throw new Error("evidence_incomplete: saved hash/bounds");
      }
      const serialized = evidenceMetadataJson(event);
      const existing = db.prepare("SELECT event_json FROM company_research_evidence_events WHERE run_id = ? AND attempt_id = ? AND sequence = ?").get(runId, attemptId, event.sequence) as { event_json: string } | undefined;
      if (existing) { if (existing.event_json !== serialized) throw new Error("evidence_incomplete: duplicate mismatch"); return; }
      const events = readEvents(runId, attemptId);
      if (event.sequence !== events.length + 1) throw new Error("evidence_incomplete: sequence");
      const all = [...events, event];
      validateEvidenceReceipts(all);
      // Leave room for the frozen manifest instead of duplicating all receipt metadata.
      if (evidenceBytes(evidenceMetadataJson(all)) > 1024 * 1024 - 4096) throw new Error("evidence_incomplete: metadata bounds");
      const blobs = new Map(all.flatMap(e => e.projections).filter(p => p.savedBytes > 0).map(p => [p.savedHash, p.savedBytes]));
      if (blobs.size > 200 || [...blobs.values()].reduce((a, b) => a + b, 0) > 512 * 1024) throw new Error("evidence_incomplete: archive bounds");
      for (const p of event.projections) if (p.savedBytes) db.prepare("INSERT OR IGNORE INTO company_research_evidence_blobs(run_id, attempt_id, hash, text) VALUES (?, ?, ?, ?)").run(runId, attemptId, p.savedHash, p.savedText);
      db.prepare("INSERT INTO company_research_evidence_events(run_id, attempt_id, sequence, event_json) VALUES (?, ?, ?, ?)").run(runId, attemptId, event.sequence, serialized);
    },
    readStaging(runId, attemptId) { requireAttempt(runId, attemptId); const events = readEvents(runId, attemptId); return { version: 1, runId, attemptId, events, manifest: snapshotManifest(events) }; },
    freeze(runId, attemptId, manifest) {
      requireAttempt(runId, attemptId, true); const snapshot = repository.readStaging(runId, attemptId);
      validateEvidenceReceipts(snapshot.events);
      const latest = new Map(snapshot.events.map(event => [event.modelRequestId, event]));
      if ([...latest.values()].some(event => event.responseState === "pending")) throw new Error("evidence_incomplete: unfinished request");
      if (JSON.stringify(snapshot.manifest) !== JSON.stringify(manifest) || snapshot.events.some(e => e.projections.some(p => p.mapping !== "mapped"))) throw new Error("evidence_incomplete: manifest");
      const existing = repository.getFrozen(runId, attemptId);
      if (existing) { if (existing.manifest.snapshotHash !== manifest.snapshotHash) throw new Error("evidence_incomplete: frozen mismatch"); return existing; }
      const frozen: FrozenSnapshot = { ...snapshot, frozen: true };
      if (evidenceBytes(evidenceMetadataJson(snapshot.events)) + evidenceBytes(evidenceMetadataJson({ ...frozen, events: [] })) > 1024 * 1024) throw new Error("evidence_incomplete: metadata bounds");
      db.prepare("INSERT INTO company_research_evidence_snapshots(run_id, attempt_id, snapshot_json) VALUES (?, ?, ?)").run(runId, attemptId, evidenceMetadataJson({ ...frozen, events: [] })); return frozen;
    },
    getFrozen(runId, attemptId) {
      const row = db.prepare("SELECT snapshot_json FROM company_research_evidence_snapshots WHERE run_id = ? AND attempt_id = ?").get(runId, attemptId) as { snapshot_json: string } | undefined;
      if (!row) return undefined; const snapshot = parseStoredEvidence<FrozenSnapshot>(row.snapshot_json, storedSnapshotShape);
      if (snapshot.version !== 1 || snapshot.frozen !== true || snapshot.runId !== runId || snapshot.attemptId !== attemptId) throw new Error("evidence_incomplete: snapshot identity");
      snapshot.events = readEvents(runId, attemptId);
      validateEvidenceReceipts(snapshot.events);
      if (JSON.stringify(snapshot.manifest) !== JSON.stringify(snapshotManifest(snapshot.events))) throw new Error("evidence_incomplete: snapshot hash"); return snapshot;
    },
    savePacketOnce(runId, attemptId, packet) {
      requireAttempt(runId, attemptId); const snapshot = repository.getFrozen(runId, attemptId);
      if ([...packet.body].length > 24000 || packet.selected.length > 200 || packet.omitted.length > 1000 || evidenceBytes(JSON.stringify(packet)) > 1024 * 1024) throw new Error("evidence_incomplete: packet bounds");
      if (!snapshot || packet.snapshotHash !== snapshot.manifest.snapshotHash || packet.hash !== evidenceHash(packet.body)) throw new Error("evidence_incomplete: packet hash");
      const existing = repository.getPacket(runId, attemptId);
      if (existing) { if (JSON.stringify(existing) !== JSON.stringify(packet)) throw new Error("evidence_incomplete: packet immutable"); return; }
      db.prepare("INSERT INTO company_research_evidence_packets(run_id, attempt_id, packet_json) VALUES (?, ?, ?)").run(runId, attemptId, JSON.stringify(packet));
    },
    getPacket(runId, attemptId) {
      const row = db.prepare("SELECT packet_json FROM company_research_evidence_packets WHERE run_id = ? AND attempt_id = ?").get(runId, attemptId) as { packet_json: string } | undefined;
      if (!row) return undefined; const packet = parseStoredEvidence<FrozenEvidencePacket>(row.packet_json, storedPacketShape);
      if (packet.hash !== evidenceHash(packet.body)) throw new Error("evidence_incomplete: packet corrupt"); return packet;
    },
    deleteByRunId(runId) { for (const table of ["company_research_evidence_events", "company_research_evidence_packets", "company_research_evidence_snapshots", "company_research_evidence_blobs"]) db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId); },
  }; return repository;
}
