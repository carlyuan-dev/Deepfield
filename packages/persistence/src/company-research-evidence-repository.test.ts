import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createRepositories, migrate } from "./index.js";
import { getCompanyResearchTemplate } from "../../../capabilities/company-research/contracts/index.js";
import { evidenceHash, snapshotManifest, type EvidenceReceipt } from "./research-evidence-data.js";
import { ResearchEvidenceCollector } from "../../../capabilities/company-research/runtime/company-research-evidence-collector.js";
import { installZeroEvidenceRawFixture } from "./research-evidence-test-fixtures.js";
import { Value } from "typebox/value";
import { EvidenceReceiptSchema } from "../../../capabilities/company-research/contracts/research-evidence.js";
function lifecycleFixture() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); migrate(db); const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "主题" }); const company = repos.companies.upsert({ name: "公司" }); repos.itemCompanies.add(item.id, company.id);
  const input = { direction: "product_and_technology" as const, asOfDate: "2026-10-09" };
  const create = () => repos.companyResearchRuns.createResearching(item.id, company.id, input, { ...input, currentDate: input.asOfDate, companyName: company.name, topicName: item.industry }, getCompanyResearchTemplate(input.direction));
  const run = create();
  const receipt: EvidenceReceipt = { sequence: 1, modelRequestId: "model", requestId: "request", phase: "ordinary", state: "prepared", responseState: "not_sent", projections: [] };
  return { db, repos, item, company, input, run, create, receipt };
}
function interruptedPair() {
  const f = lifecycleFixture(); installZeroEvidenceRawFixture(f.db, f.repos);
  f.repos.companyResearchRuns.completeRaw(f.run.id, "保留原始报告"); f.repos.companyResearchRuns.failStructuring(f.run.id);
  const peer = f.create();
  f.repos.companyResearchEvidence.append(peer.id, peer.attemptId!, f.receipt);
  // Simulate an interrupted/corrupt historical database with two abandoned rows;
  // normal runtime admission retains the one-active-run unique index.
  f.db.exec("DROP INDEX idx_company_research_one_active");
  f.db.prepare("UPDATE company_research_runs SET status = 'structuring', last_failure_code = NULL WHERE id = ?").run(f.run.id);
  return { ...f, peer };
}
function retainedEvidence(db: DatabaseSync) {
  return {
    raw: db.prepare("SELECT id, raw_report_text FROM company_research_runs ORDER BY id").all(),
    events: db.prepare("SELECT * FROM company_research_evidence_events ORDER BY run_id, sequence").all(),
    snapshots: db.prepare("SELECT * FROM company_research_evidence_snapshots ORDER BY run_id").all(),
    packets: db.prepare("SELECT * FROM company_research_evidence_packets ORDER BY run_id").all(),
    blobs: db.prepare("SELECT * FROM company_research_evidence_blobs ORDER BY run_id, hash").all(),
  };
}
it.each(["packet_null", "packet_empty", "packet_numeric_body", "snapshot_null", "event_missing_projections"] as const)("isolates structurally corrupt %s while recovering a healthy interrupted peer", failure => {
  const f = interruptedPair();
  if (failure === "snapshot_null") f.db.prepare("UPDATE company_research_evidence_snapshots SET snapshot_json = 'null' WHERE run_id = ?").run(f.run.id);
  else if (failure === "event_missing_projections") f.db.prepare("UPDATE company_research_evidence_events SET event_json = '{}' WHERE run_id = ?").run(f.run.id);
  else f.db.prepare("UPDATE company_research_evidence_packets SET packet_json = ? WHERE run_id = ?").run(failure === "packet_null" ? "null" : failure === "packet_empty" ? "{}" : '{"body":42,"hash":"abc"}', f.run.id);
  const before = retainedEvidence(f.db);
  expect(f.repos.companyResearchRuns.recoverAbandoned()).toEqual({ failedResearching: 1, failedStructuring: 1 });
  expect(f.repos.companyResearchRuns.getByIdForTarget(f.item.id, f.company.id, f.run.id)).toMatchObject({ status: "structure_failed", lastFailureCode: "evidence_incomplete", rawReportText: "保留原始报告" });
  expect(f.repos.companyResearchRuns.getByIdForTarget(f.item.id, f.company.id, f.peer.id)).toMatchObject({ status: "research_failed", lastFailureCode: "incomplete_response" });
  expect(retainedEvidence(f.db)).toEqual(before);
  expect(f.repos.companyResearchRuns.recoverAbandoned()).toEqual({ failedResearching: 0, failedStructuring: 0 }); f.db.close();
});
it("rolls recovery back on a real SQLite failure after classifying structurally corrupt evidence", () => {
  const f = interruptedPair(); f.db.prepare("UPDATE company_research_evidence_packets SET packet_json = 'null' WHERE run_id = ?").run(f.run.id);
  const material = retainedEvidence(f.db); const runs = f.db.prepare("SELECT * FROM company_research_runs ORDER BY id").all();
  f.db.exec("CREATE TRIGGER recovery_fault BEFORE UPDATE OF status ON company_research_runs WHEN NEW.status = 'research_failed' BEGIN SELECT RAISE(ABORT, 'injected sqlite recovery failure'); END");
  expect(() => f.repos.companyResearchRuns.recoverAbandoned()).toThrow("injected sqlite recovery failure");
  expect(f.db.prepare("SELECT * FROM company_research_runs ORDER BY id").all()).toEqual(runs); expect(retainedEvidence(f.db)).toEqual(material); f.db.close();
});
it.each(["bytes", "entries", "metadata"] as const)("bounds aggregate %s while retaining an honest omission ledger", bound => {
  const f = lifecycleFixture();
  const collector = new ResearchEvidenceCollector("request", receipt => f.repos.companyResearchEvidence.append(f.run.id, f.run.attemptId!, receipt));
  const count = bound === "entries" ? 202 : bound === "bytes" ? 46 : 2;
  for (let index = 0; index < count; index++) {
    const text = bound === "bytes" ? `${index}:` + "文🌱".repeat(3000) : `${index}`;
    const observation = { requestId: "request", modelRequestId: `m${index}`, phase: "ordinary" as const, state: "dispatched" as const, responseState: "succeeded" as const, projections: [{ projectionId: `p${index}`, toolCallId: `t${index}`, messageIndex: 0, origin: { toolName: "web_search", sources: [{ title: bound === "metadata" ? "x".repeat(600000) : "来源", url: "https://a.test" }] }, mapping: "mapped" as const, text, start: 0, end: text.length, visibleBytes: Buffer.byteLength(text), visibleHash: evidenceHash(text) }] };
    if (bound === "metadata" && index === 1) expect(() => collector.observe(observation)).toThrow("metadata");
    else collector.observe(observation);
  }
  const snapshot = f.repos.companyResearchEvidence.readStaging(f.run.id, f.run.attemptId!);
  const physical = f.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS bytes FROM company_research_evidence_blobs").get() as { n: number; bytes: number };
  expect(physical.n).toBeLessThanOrEqual(200); expect(physical.bytes).toBeLessThanOrEqual(512 * 1024);
  if (bound !== "metadata") { expect(snapshot.events).toHaveLength(count); expect(snapshot.manifest.omittedEntries).toBeGreaterThan(0); expect(snapshot.manifest.omittedBytes).toBeGreaterThan(0); }
  else expect(snapshot.events).toHaveLength(1);
  f.db.close();
});
it.each(["raw", "freeze", "packet", "stage"] as const)("rolls every raw completion write back at the %s boundary", boundary => {
  const f = lifecycleFixture(); installZeroEvidenceRawFixture(f.db, f.repos);
  const staged: EvidenceReceipt = { ...f.receipt, modelRequestId: `fixture-${f.run.id}`, requestId: `fixture-${f.run.id}`, state: "dispatched", responseState: "succeeded" };
  f.repos.companyResearchEvidence.append(f.run.id, f.run.attemptId!, staged);
  const table = boundary === "freeze" ? "company_research_evidence_snapshots" : boundary === "packet" ? "company_research_evidence_packets" : "company_research_runs";
  const operation = boundary === "raw" ? "BEFORE UPDATE OF raw_report_text" : boundary === "stage" ? "AFTER UPDATE OF status" : "AFTER INSERT";
  f.db.exec(`CREATE TRIGGER fault ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
  expect(() => f.repos.companyResearchRuns.completeRaw(f.run.id, "原报告")).toThrow("injected");
  expect(f.repos.companyResearchRuns.getByIdForTarget(f.item.id, f.company.id, f.run.id)).toMatchObject({ status: "researching" });
  expect(f.repos.companyResearchEvidence.readStaging(f.run.id, f.run.attemptId!).events).toEqual([staged]);
  expect(f.repos.companyResearchEvidence.getFrozen(f.run.id, f.run.attemptId!)).toBeUndefined();
  expect(f.repos.companyResearchEvidence.getPacket(f.run.id, f.run.attemptId!)).toBeUndefined(); f.db.close();
});
it("rejects stale, nonmonotone and changed receipts, accepts identical replay, and cannot resurrect cancellation", () => {
  const f = lifecycleFixture(); const evidence = f.repos.companyResearchEvidence; const attempt = f.run.attemptId!;
  expect(() => evidence.append(f.run.id, "old", f.receipt)).toThrow("attempt/status");
  expect(() => evidence.append(f.run.id, attempt, { ...f.receipt, sequence: 2 })).toThrow("sequence");
  evidence.append(f.run.id, attempt, f.receipt); evidence.append(f.run.id, attempt, f.receipt);
  expect(evidence.readStaging(f.run.id, attempt).events).toHaveLength(1);
  expect(() => evidence.append(f.run.id, attempt, { ...f.receipt, phase: "synthesis" })).toThrow("duplicate mismatch");
  expect(() => evidence.append(f.run.id, attempt, { ...f.receipt, sequence: 2, state: "prepared", responseState: "succeeded" })).toThrow("lifecycle");
  evidence.append(f.run.id, attempt, { ...f.receipt, sequence: 2, state: "dispatched", responseState: "pending" });
  expect(() => evidence.freeze(f.run.id, attempt, evidence.readStaging(f.run.id, attempt).manifest)).toThrow("unfinished request");
  evidence.append(f.run.id, attempt, { ...f.receipt, sequence: 3, state: "dispatched", responseState: "succeeded" });
  expect(() => evidence.append(f.run.id, attempt, { ...f.receipt, sequence: 4 })).toThrow("lifecycle");
  f.repos.companyResearchRuns.deleteActive(f.run.id);
  expect(() => evidence.freeze(f.run.id, attempt, snapshotManifest([f.receipt]))).toThrow("attempt/status");
  expect(() => evidence.append(f.run.id, attempt, f.receipt)).toThrow("attempt/status");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM company_research_evidence_events").get()).toEqual({ n: 0 }); f.db.close();
});
it.each(["before", "after", "missing"] as const)("recovers %s freeze without dispatch or rebuilding missing required material", boundary => {
  const f = lifecycleFixture();
  if (boundary === "before") f.repos.companyResearchEvidence.append(f.run.id, f.run.attemptId!, f.receipt);
  else { installZeroEvidenceRawFixture(f.db, f.repos); f.repos.companyResearchRuns.completeRaw(f.run.id, "原报告"); }
  if (boundary === "missing") f.db.prepare("DELETE FROM company_research_evidence_packets WHERE run_id = ?").run(f.run.id);
  const frozen = f.repos.companyResearchEvidence.getFrozen(f.run.id, f.run.attemptId!);
  f.repos.companyResearchRuns.recoverAbandoned();
  expect(f.repos.companyResearchRuns.getByIdForTarget(f.item.id, f.company.id, f.run.id)).toMatchObject({ status: boundary === "before" ? "research_failed" : "structure_failed", lastFailureCode: boundary === "before" ? "incomplete_response" : boundary === "missing" ? "evidence_incomplete" : "structuring_failed" });
  expect(f.repos.companyResearchEvidence.getFrozen(f.run.id, f.run.attemptId!)).toEqual(frozen);
  expect(f.repos.companyResearchRuns.recoverAbandoned()).toEqual({ failedResearching: 0, failedStructuring: 0 }); f.db.close();
});
it.each(["report", "membership", "company", "topic"] as const)("cleans only owned evidence through the %s deletion entry", entry => {
  const f = lifecycleFixture(); installZeroEvidenceRawFixture(f.db, f.repos);
  f.repos.companyResearchRuns.completeRaw(f.run.id, "原报告"); f.repos.companyResearchRuns.failStructuring(f.run.id);
  const otherItem = f.repos.capabilityItems.create({ industry: "其他主题" }); const otherCompany = f.repos.companies.upsert({ name: "其他公司" }); f.repos.itemCompanies.add(otherItem.id, otherCompany.id);
  const kept = f.repos.companyResearchRuns.createResearching(otherItem.id, otherCompany.id, f.input, { ...f.input, currentDate: f.input.asOfDate, companyName: otherCompany.name, topicName: otherItem.industry }, getCompanyResearchTemplate(f.input.direction));
  f.repos.companyResearchRuns.completeRaw(kept.id, "保留报告"); f.repos.companyResearchRuns.failStructuring(kept.id);
  f.repos.runInTransaction(() => {
    if (entry === "report") f.repos.companyResearchRuns.deleteTerminal(f.item.id, f.company.id, f.run.id);
    else if (entry === "membership") f.repos.itemCompanies.remove(f.item.id, f.company.id);
    else if (entry === "company") f.db.prepare("DELETE FROM companies WHERE id = ?").run(f.company.id);
    else f.db.prepare("DELETE FROM capability_items WHERE id = ?").run(f.item.id);
  });
  for (const table of ["company_research_evidence_events", "company_research_evidence_snapshots", "company_research_evidence_packets", "company_research_evidence_blobs"]) expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(f.run.id)).toEqual({ n: 0 });
  expect(f.repos.companyResearchEvidence.getFrozen(kept.id, kept.attemptId!)).toBeDefined(); expect(f.repos.companyResearchEvidence.getPacket(kept.id, kept.attemptId!)).toBeDefined(); f.db.close();
});
it("freezes complete zero manifests atomically, rejects missing/different manifests and preserves immutable packets", () => {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); migrate(db); const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "主题" }); const company = repos.companies.upsert({ name: "公司" }); repos.itemCompanies.add(item.id, company.id);
  const input = { direction: "product_and_technology" as const, asOfDate: "2026-10-09" };
  const run = repos.companyResearchRuns.createResearching(item.id, company.id, input, { ...input, currentDate: "2026-10-09", companyName: "公司", topicName: "主题" }, getCompanyResearchTemplate(input.direction));
  const manifest = snapshotManifest([]);
  expect(() => repos.companyResearchEvidence.freeze(run.id, run.attemptId!, { ...manifest, lastSequence: 1 })).toThrow("evidence_incomplete");
  expect(() => repos.runInTransaction(() => { repos.companyResearchEvidence.freeze(run.id, run.attemptId!, manifest); throw new Error("injected write failure"); })).toThrow("injected");
  expect(repos.companyResearchEvidence.getFrozen(run.id, run.attemptId!)).toBeUndefined();
  repos.runInTransaction(() => {
    const snapshot = repos.companyResearchEvidence.freeze(run.id, run.attemptId!, manifest);
    repos.companyResearchEvidence.savePacketOnce(run.id, run.attemptId!, { body: "", hash: evidenceHash(""), packetVersion: 1, algorithmVersion: "source-group-v1",
      snapshotHash: snapshot.manifest.snapshotHash, parameters: { maxCharacters: 24000, maxExcerptCharacters: 2000 }, selected: [], omitted: [], emptyReason: "no_matching_saved_material" });
    repos.companyResearchRuns.completeRawWithEvidence(run.id, run.attemptId!, "原报告", "ready");
  });
  const packet = repos.companyResearchEvidence.getPacket(run.id, run.attemptId!)!;
  expect(() => repos.companyResearchEvidence.savePacketOnce(run.id, run.attemptId!, { ...packet, body: "x".repeat(24001), hash: evidenceHash("x".repeat(24001)) })).toThrow("packet bounds");
  expect(() => repos.companyResearchEvidence.savePacketOnce(run.id, run.attemptId!, { ...packet, algorithmVersion: "upgraded" })).toThrow("immutable");
  expect(() => repos.companyResearchEvidence.append(run.id, run.attemptId!, { sequence: 1 } as EvidenceReceipt)).toThrow("attempt/status");
  expect(() => repos.companyResearchEvidence.readStaging(run.id, "old_attempt")).toThrow("attempt/status"); db.close();
});
it("archives Unicode safely and stores repeated request projections as one blob, rejecting unmapped receipts", () => {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); migrate(db); const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "主题" }); const company = repos.companies.upsert({ name: "公司" }); repos.itemCompanies.add(item.id, company.id);
  const input = { direction: "product_and_technology" as const, asOfDate: "2026-10-09" };
  const run = repos.companyResearchRuns.createResearching(item.id, company.id, input, { ...input, currentDate: "2026-10-09", companyName: "公司", topicName: "主题" }, getCompanyResearchTemplate(input.direction));
  const text = "中文🌱".repeat(3000);
  const collector = new ResearchEvidenceCollector("request", receipt => repos.companyResearchEvidence.append(run.id, run.attemptId!, receipt));
  for (let index = 0; index < 4; index++) collector.observe({ requestId: "request", modelRequestId: `model_${index}`, phase: "ordinary", state: "dispatched", responseState: "succeeded", projections: [{
    projectionId: `projection_${index}`, toolCallId: "tool", messageIndex: 2, origin: { toolName: "web_search", sources: [{ title: "来源", url: "https://a.test" }] },
    mapping: "mapped", text, start: 0, end: text.length, visibleBytes: Buffer.byteLength(text), visibleHash: evidenceHash(text),
  }] });
  const frozen = repos.runInTransaction(() => repos.companyResearchEvidence.freeze(run.id, run.attemptId!, collector.manifest()));
  expect(frozen.manifest.dispatched).toBe(4);
  expect(frozen.manifest.savedBytes).toBe(4 * frozen.events[0]!.projections[0]!.savedBytes);
  expect(frozen.events[0]!.projections[0]!.savedBytes).toBeLessThanOrEqual(12288);
  expect(frozen.events[0]!.projections[0]!.archiveClipping.omittedBytes).toBeGreaterThan(0);
  expect(db.prepare("SELECT COUNT(*) AS count FROM company_research_evidence_blobs").get()).toEqual({ count: 1 });
  expect(JSON.stringify(db.prepare("SELECT event_json FROM company_research_evidence_events").all())).not.toContain("中文");
  expect(JSON.stringify(db.prepare("SELECT snapshot_json FROM company_research_evidence_snapshots").all())).not.toContain("中文");
  const unmapped = new ResearchEvidenceCollector("request", () => {});
  unmapped.observe({ requestId: "request", modelRequestId: "model", phase: "ordinary", state: "dispatched", responseState: "succeeded", projections: [{
    projectionId: "bad", toolCallId: "tool", messageIndex: 2, origin: { toolName: "web_search", sources: [] }, mapping: "unmapped", text: "", start: 0, end: 0, visibleBytes: 0, visibleHash: evidenceHash(""),
  }] });
  expect(() => unmapped.manifest()).toThrow("unmapped"); db.close();
});
it("lets an unmapped observer sentinel reach the evidence boundary and refuses freezing it", () => {
  const f = lifecycleFixture(); const receipts: EvidenceReceipt[] = [];
  const collector = new ResearchEvidenceCollector("request", receipt => receipts.push(receipt));
  collector.observe({ requestId: "request", modelRequestId: "model", phase: "ordinary", state: "dispatched", responseState: "succeeded", projections: [{ projectionId: "unmapped", toolCallId: "tool", messageIndex: -1, origin: { toolName: "read_webpage", sources: [{ title: "文".repeat(2000), url: "https://a.test" }] }, mapping: "unmapped", text: "", start: 0, end: 0, visibleBytes: 0, visibleHash: evidenceHash("") }] });
  expect(Value.Check(EvidenceReceiptSchema, receipts[0])).toBe(true);
  f.repos.companyResearchEvidence.append(f.run.id, f.run.attemptId!, receipts[0]!);
  expect(() => f.repos.companyResearchEvidence.freeze(f.run.id, f.run.attemptId!, snapshotManifest(receipts))).toThrow("evidence_incomplete");
  expect(f.repos.companyResearchEvidence.getFrozen(f.run.id, f.run.attemptId!)).toBeUndefined(); f.db.close();
});
it("first packet creation after a budget failure atomically marks ready, forbidding later reconstruction authority", () => {
  const db = new DatabaseSync(":memory:"); migrate(db); const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "主题" }); const company = repos.companies.upsert({ name: "公司" }); repos.itemCompanies.add(item.id, company.id);
  const input = { direction: "product_and_technology" as const, asOfDate: "2026-10-09" };
  const run = repos.companyResearchRuns.createResearching(item.id, company.id, input, { ...input, currentDate: "2026-10-09", companyName: "公司", topicName: "主题" }, getCompanyResearchTemplate(input.direction));
  repos.runInTransaction(() => {
    repos.companyResearchEvidence.freeze(run.id, run.attemptId!, snapshotManifest([]));
    repos.companyResearchRuns.completeRawWithEvidence(run.id, run.attemptId!, "原报告", "budget_exceeded");
  });
  repos.companyResearchRuns.retryStructuring(run.id);
  expect(() => repos.companyResearchRuns.markEvidencePacketReady(run.id, run.attemptId!)).toThrow("packet creation state");
  repos.runInTransaction(() => {
    repos.companyResearchEvidence.savePacketOnce(run.id, run.attemptId!, { body: "", hash: evidenceHash(""), packetVersion: 1, algorithmVersion: "source-group-v1", snapshotHash: snapshotManifest([]).snapshotHash,
      parameters: { maxCharacters: 24000, maxExcerptCharacters: 2000 }, selected: [], omitted: [], emptyReason: "no_matching_saved_material" });
    repos.companyResearchRuns.markEvidencePacketReady(run.id, run.attemptId!);
  });
  expect(repos.companyResearchRuns.getByIdForTarget(item.id, company.id, run.id)).toMatchObject({ evidencePacketState: "ready" });
  expect(() => repos.companyResearchRuns.markEvidencePacketReady(run.id, run.attemptId!)).toThrow("packet creation state"); db.close();
});
