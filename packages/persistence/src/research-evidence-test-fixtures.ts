import type { DatabaseSync } from "node:sqlite";
import type { Repositories } from "./testing/repositories.js";
import { evidenceHash, snapshotManifest, type EvidenceReceipt } from "../../../capabilities/company-research/persistence/research-evidence-data.js";

/** Isolated tests with no tool material still provide an explicit observed zero-material manifest. */
export function installZeroEvidenceRawFixture(db: DatabaseSync, repos: Repositories): void {
  const original = repos.companyResearchRuns.completeRaw;
  repos.companyResearchRuns.completeRaw = (id, text) => {
    const row = db.prepare("SELECT evidence_policy, evidence_attempt_id FROM company_research_runs WHERE id = ?").get(id) as { evidence_policy: string; evidence_attempt_id: string } | undefined;
    if (!row || row.evidence_policy === "legacy_optional") return original(id, text);
    return repos.runInTransaction(() => {
      const receipt: EvidenceReceipt = { sequence: 1, modelRequestId: `fixture-${id}`, requestId: `fixture-${id}`, phase: "ordinary", state: "dispatched", responseState: "succeeded", projections: [] };
      repos.companyResearchEvidence.append(id, row.evidence_attempt_id, receipt);
      const snapshot = repos.companyResearchEvidence.freeze(id, row.evidence_attempt_id, snapshotManifest([receipt]));
      repos.companyResearchEvidence.savePacketOnce(id, row.evidence_attempt_id, { body: "", hash: evidenceHash(""), packetVersion: 1, algorithmVersion: "source-group-v1", snapshotHash: snapshot.manifest.snapshotHash, parameters: { maxCharacters: 24000, maxExcerptCharacters: 2000 }, selected: [], omitted: [], emptyReason: "no_matching_saved_material" });
      return repos.companyResearchRuns.completeRawWithEvidence(id, row.evidence_attempt_id, text, "ready");
    });
  };
}
