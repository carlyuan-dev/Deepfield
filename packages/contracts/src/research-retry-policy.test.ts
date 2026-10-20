import { describe, expect, it } from "vitest";
import { researchRetryMode } from "../../../capabilities/company-research/contracts/research-retry-policy.js";
import type { KeyResearchRun } from "../../../capabilities/company-research/contracts/research.js";

const input = { moduleIds: ["products_and_positioning", "technology_and_metrics"], asOfDate: "2026-09-11", focusScope: "重点" } satisfies import("../../../capabilities/company-research/contracts/research.js").StartCompanyResearchInput;
describe("research retry policy", () => {
  it("requires fresh network evidence for integrity failure even with unchanged research input", () => {
    const saved = { ...input, schemaVersion: "company-research-report-v1", status: "structure_failed", searchStatus: "succeeded", lastFailureCode: "evidence_incomplete" } as KeyResearchRun;
    expect(researchRetryMode(saved, input)).toBe("raw");
    expect(researchRetryMode({ ...saved, lastFailureCode: "context_budget_exceeded" }, input)).toBe("structure");
  });
  it.each([
    ["research_failed", "none", "raw"], ["research_failed", "succeeded", "raw"],
    ["structure_failed", "none", "raw"], ["structure_failed", "unknown", "structure"],
    ["structure_failed", "succeeded", "structure"], ["completed", "none", "raw"],
    ["completed", "unknown", "unavailable"], ["completed", "succeeded", "unavailable"],
    ["researching", "none", "unavailable"], ["structuring", "succeeded", "unavailable"],
  ] as const)("%s / %s => %s", (status, searchStatus, expected) => {
    expect(researchRetryMode({ ...input, schemaVersion: "company-research-report-v1", status, searchStatus } as KeyResearchRun, input)).toBe(expected);
  });
  it("normalizes focus whitespace and restarts raw for every changed input field", () => {
    const saved = { ...input, schemaVersion: "company-research-report-v1", status: "structure_failed", searchStatus: "unknown" } as KeyResearchRun;
    expect(researchRetryMode(saved, { ...input, focusScope: "  重点  " })).toBe("structure");
    for (const changed of [{ moduleIds: ["target_market_and_customers"] }, { asOfDate: "2026-09-10" }, { focusScope: "不同" }]) {
      expect(researchRetryMode(saved, { ...input, ...changed } as typeof input)).toBe("raw");
    }
    expect(researchRetryMode(undefined, input)).toBe("unavailable");
  });
});
