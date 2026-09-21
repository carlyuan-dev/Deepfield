import { describe, expect, it } from "vitest";
import { researchRetryMode } from "../../../capabilities/company-research/contracts/research-retry-policy.js";
import type { KeyResearchRun } from "../../../capabilities/company-research/contracts/research.js";

const input = { direction: "product_and_technology", asOfDate: "2026-09-11", focusScope: "重点" } as const;
describe("research retry policy", () => {
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
    for (const changed of [{ direction: "market_and_competition" }, { asOfDate: "2026-09-10" }, { focusScope: "不同" }]) {
      expect(researchRetryMode(saved, { ...input, ...changed } as typeof input)).toBe("raw");
    }
    expect(researchRetryMode(undefined, input)).toBe("unavailable");
  });
});
