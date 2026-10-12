import { expect, it } from "vitest";
import { structureResearchRequest } from "./company-research-test-helpers.js";
import { budgetMessages, buildStructureRepairPrompt, checkStructureBudget } from "./company-research-context-budget.js";
import { evidenceBytes } from "../../../packages/persistence/src/research-evidence-data.js";
import { buildCompanyResearchStructuringPrompt } from "./company-research-structuring-prompt.js";
it("adds evidence rules only with a packet and budgets the actual ordinary and repair messages", () => {
  const legacy = structureResearchRequest();
  expect(buildCompanyResearchStructuringPrompt(legacy).instructions).not.toContain("固定检索依据仅用于");
  const request = { ...legacy, evidencePolicy: "required_v1" as const, evidencePacket: { body: "冻结资料", hash: "a".repeat(64), packetVersion: 1 as const, algorithmVersion: "source-group-v1", snapshotHash: "b".repeat(64), parameters: { maxCharacters: 24000, maxExcerptCharacters: 2000 }, selected: [], omitted: [] } };
  const ordinary = buildCompanyResearchStructuringPrompt(request);
  const repair = buildStructureRepairPrompt(request, "", {});
  for (const messages of [ordinary, repair]) {
    expect(messages.instructions).toContain("company-research-structure-v4");
    expect(messages.instructions).toContain("facts.text 尽可能逐字沿用原始报告的事实表达");
    expect(messages.instructions).toContain("“提升至三倍”不得改成“提升三倍”");
    expect(messages.instructions).toContain("summary 和 coreSummary 优先选取最终 facts 中的完整短句");
    expect(messages.instructions).toContain("不得把不同来源或不同上下文拼成原文未建立的因果");
    expect(messages.instructions).not.toContain("summary 必须非空且说明已知与缺口");
    expect(messages.instructions).toContain("partial 状态本身不要求");
    expect(messages.instructions).toContain("facts、summary 和 coreSummary 都必须保留");
    expect(messages.instructions).toContain("公司称、内部测试、转引榜单、计划、估算、预测");
    expect(messages.instructions).toContain("不得新增缺口，不重复提醒");
    expect(messages.instructions).toContain("固定检索依据仅用于核对和缩窄原始报告");
    expect(messages.input).toContain("<frozen_evidence_packet>\n冻结资料\n</frozen_evidence_packet>");
    expect(budgetMessages(request, messages).E).toBe(evidenceBytes(messages.instructions) + evidenceBytes(messages.input) + 512 + 2048);
  }
  expect(checkStructureBudget(request, "repair").E).toBe(budgetMessages(request, repair).E + 16384 + 8192);
});
it("counts UTF-8 and protocol overhead, reserves the actual repair shape and explicit output", () => {
  const request = structureResearchRequest();
  const budget = budgetMessages(request, { instructions: "中文🌱", input: "资料" });
  expect(budget.E).toBe(evidenceBytes("中文🌱资料") + 512 + 2048);
  expect(budget.O).toBe(8192); expect(budget.S).toBe(12800);
  expect(checkStructureBudget({ ...request, llm: { ...request.llm, contextWindow: 16000 } }).allowed).toBe(false);
  const repair = buildStructureRepairPrompt(request, "", {});
  expect(checkStructureBudget(request, "repair").E).toBe(budgetMessages(request, repair).E + 16384 + 8192);
});
it("bounds final inserted Unicode candidates and JSON-escaped feedback while reporting omissions", () => {
  const request = structureResearchRequest();
  const repair = buildStructureRepairPrompt(request, "中文🌱".repeat(10000), { issues: Array.from({ length: 1000 }, () => ({ path: "\\".repeat(50), expected: "value" })) });
  const candidate = repair.input.split("【失败候选】\n")[1]!;
  const feedbackText = repair.input.split("【安全校验反馈】\n")[1]!.split("\n【失败候选】")[0]!;
  expect(evidenceBytes(candidate)).toBeLessThanOrEqual(16384); expect(candidate).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(evidenceBytes(feedbackText)).toBeLessThanOrEqual(8192);
  const feedback = JSON.parse(feedbackText); expect(feedback.issues.length).toBeGreaterThan(0); expect(feedback.omittedIssues + feedback.issues.length).toBe(1000);
});
