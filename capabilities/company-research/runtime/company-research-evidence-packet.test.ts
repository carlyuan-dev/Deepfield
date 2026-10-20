import { expect, it } from "vitest";
import { structureResearchRequest } from "./company-research-test-helpers.js";
import { buildEvidencePacket } from "./company-research-evidence-packet.js";
import { checkStructureBudget } from "./company-research-context-budget.js";
import { snapshotManifest, evidenceHash, evidenceBytes, type FrozenSnapshot, type EvidenceReceipt } from "../persistence/research-evidence-data.js";
function fixture(text = "中文🌱".repeat(3000)): FrozenSnapshot {
  const event: EvidenceReceipt = { sequence: 1, modelRequestId: "model", requestId: "request", phase: "ordinary", state: "dispatched", responseState: "succeeded", projections: [{
    evidenceId: "projection", toolCallId: "tool", toolName: "web_search", messageIndex: 2, mapping: "mapped",
    sources: [{ title: "原来源", url: "https://a.test/a(b)" }, { title: "关联来源", url: "https://b.test" }],
    savedText: text, savedBytes: evidenceBytes(text), savedHash: evidenceHash(text), visibleBytes: evidenceBytes(text), visibleHash: evidenceHash(text), capturedAt: "2026-10-09",
    archiveClipping: { reason: "none", omittedBytes: 0 },
  }] };
  return { version: 1, frozen: true, runId: "run", attemptId: "attempt", events: [event], manifest: snapshotManifest([event]) };
}
it("uses raw source order, grouped shared text, ordinary projection preference, and Unicode caps", () => {
  const snapshot = fixture();
  snapshot.events.push({ ...snapshot.events[0]!, sequence: 2, modelRequestId: "synthesis", phase: "synthesis", projections: [{ ...snapshot.events[0]!.projections[0]!, evidenceId: "synthesis_projection", savedText: "收尾新包装", savedHash: evidenceHash("收尾新包装"), savedBytes: evidenceBytes("收尾新包装") }] });
  const result = buildEvidencePacket(snapshot, "[来源](https://a.test/a(b))", structureResearchRequest());
  expect(result.status).toBe("ready"); if (result.status !== "ready") return;
  const record = JSON.parse(result.packet.body); expect(record.sources).toHaveLength(2); expect([...record.text]).toHaveLength(2000);
  expect([...result.packet.body].length).toBeLessThanOrEqual(24000);
  expect(result.packet.selected.map(p => p.evidenceId)).toEqual(["projection"]);
  expect(result.packet.omitted).toContainEqual({ evidenceId: "synthesis_projection", reason: "ordinary_projection_preferred" });
});
it("returns an explained empty packet only for no matching saved material; base over-budget rejects", () => {
  const request = structureResearchRequest(); const snapshot = fixture();
  const empty = buildEvidencePacket(snapshot, "无来源报告", request);
  expect(empty).toMatchObject({ status: "ready", packet: { body: "", emptyReason: "no_matching_saved_material" } });
  expect(buildEvidencePacket(snapshot, "报告", { ...request, llm: { ...request.llm, contextWindow: 16000 } }).status).toBe("budget_exceeded");
});
it("refuses a candidate whose nonempty record cannot fit and only shrinks the last excerpt during initial packing", () => {
  const snapshot = fixture(); const request = structureResearchRequest();
  snapshot.events[0]!.projections[0]!.sources.push(...Array.from({ length: 40 }, (_, i) => ({ title: "元数据".repeat(300), url: `https://uncited.test/${i}` })));
  expect(buildEvidencePacket(snapshot, "[来源](https://a.test/a(b))", request).status).toBe("budget_exceeded");
  const smaller = fixture();
  const contextWindow = Array.from({ length: 80 }, (_, i) => 35000 + i * 500).find(C => {
    const context = { ...request, llm: { ...request.llm, contextWindow: C } };
    const result = buildEvidencePacket(smaller, "[来源](https://a.test/a(b))", context);
    return checkStructureBudget(context).allowed && result.status === "ready" && result.packet.selected[0]!.end > 0 && result.packet.selected[0]!.end < 2000;
  });
  expect(contextWindow).toBeDefined();
});
