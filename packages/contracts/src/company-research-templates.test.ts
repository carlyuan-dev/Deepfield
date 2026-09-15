import { describe, expect, expectTypeOf, it } from "vitest";
import { Value } from "typebox/value";
import * as contracts from "./index.js";
import type { DesktopApi } from "./ipc.js";

const expectedSections = {
  product_and_technology: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"],
  market_and_commercialization: ["target_market_and_customers", "commercialization_progress", "sales_and_adoption", "pricing_and_business_model", "drivers_barriers_and_outlook"],
  value_chain_and_competition: ["value_chain_position", "key_relationships", "competitors_and_differentiation", "supply_cost_and_resources", "opportunities_and_risks"],
  operations_and_performance: ["financial_performance", "business_mix_and_topic_contribution", "operating_indicators", "performance_drivers", "guidance_and_risks"],
};
const input = { direction: "product_and_technology", focusScope: "手机硅碳负极电池", asOfDate: "2026-09-11" };
const context = {
  currentDate: "2026-09-11", companyName: "小米", legalName: "小米集团",
  aliases: ["Xiaomi"], headquarters: "北京", foundedAt: "2010-04-06",
  officialWebsite: "https://www.mi.com", stockListings: [{ exchange: "HKEX", ticker: "1810" }],
  businessTags: ["手机"], companyNote: "目标公司备注", topicName: "电池", topicScope: "消费电子电池", ...input,
};
const fact = { text: "发布了电池产品", timeContext: "2026年", claimType: "reported_fact", source: { title: "公告", url: "https://example.com/report" } };
const content = () => ({
  coreSummary: ["公司已发布产品。"],
  sections: expectedSections.product_and_technology.map((sectionId) => ({ sectionId, status: "found", summary: "已发布", facts: [structuredClone(fact)] })),
});
const identity = { id: "run-1", itemId: "item-1", companyId: "company-1", createdAt: "2026-09-11T00:00:00Z" };

describe("company research template registry", () => {
  it("defines exactly four version-one templates with the twenty ordered module IDs", () => {
    expect(contracts.COMPANY_RESEARCH_TEMPLATES).toBeDefined();
    expect(contracts.RESEARCH_DIRECTIONS).toEqual(Object.keys(expectedSections));
    expect(Object.keys(contracts.COMPANY_RESEARCH_TEMPLATES)).toEqual(Object.keys(expectedSections));
    for (const direction of contracts.RESEARCH_DIRECTIONS) {
      const template = contracts.getCompanyResearchTemplate(direction);
      expect(template.templateId).toBe(direction);
      expect(template.templateVersion).toBe(1);
      expect(template.sections.map((section) => section.sectionId)).toEqual(expectedSections[direction]);
      expect(new Set(template.sections.map((section) => section.sectionId)).size).toBe(5);
      expect(Value.Check(contracts.CompanyResearchTemplateSnapshotSchema, JSON.parse(JSON.stringify(template)))).toBe(true);
      for (const section of template.sections) {
        for (const key of ["title", "coreQuestion", "coverage", "boundary"] as const) expect(section[key].length).toBeGreaterThan(0);
      }
    }
  });

  it("freezes the registry and every nested snapshot so consumers cannot change later runs", () => {
    expect(contracts.getCompanyResearchTemplate).toBeTypeOf("function");
    const template = contracts.getCompanyResearchTemplate("product_and_technology");
    expect(Object.isFrozen(contracts.COMPANY_RESEARCH_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(contracts.RESEARCH_DIRECTIONS)).toBe(true);
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.sections)).toBe(true);
    expect(Object.isFrozen(template.sections[0])).toBe(true);
    expect(() => Reflect.set(template.sections[0]!, "title", "changed")).not.toThrow();
    expect(template.sections[0]!.title).toBe("主要产品与定位");
  });
});

describe("read-only research JSON contracts", () => {
  it("accepts direction, optional focus and a date-shaped cutoff only", () => {
    expectTypeOf<contracts.StartCompanyResearchInput["direction"]>().toEqualTypeOf<contracts.ResearchDirection>();
    expect(Value.Check(contracts.StartCompanyResearchInputSchema, input)).toBe(true);
    expect(Value.Check(contracts.StartCompanyResearchInputSchema, { direction: input.direction, asOfDate: input.asOfDate })).toBe(true);
    for (const invalid of [
      { ...input, direction: "all" }, { ...input, asOfDate: "tomorrow" },
      { ...input, asOfDate: "2026-9-11" }, { ...input, timeScope: "近一年" },
      { ...input, customRequirements: "extra" }, { ...input, focusScope: "x".repeat(1001) },
    ]) expect(Value.Check(contracts.StartCompanyResearchInputSchema, invalid)).toBe(false);
    expect(Value.Check(contracts.StartCompanyResearchInputSchema, { ...input, focusScope: "x".repeat(1000) })).toBe(true);
    // Calendar validity and future dates belong to Application, not this transport pattern.
    expect(Value.Check(contracts.StartCompanyResearchInputSchema, { ...input, asOfDate: "2026-02-31" })).toBe(true);
  });

  it("validates complete context snapshots without conflating topicScope and focusScope", () => {
    expect(Value.Check(contracts.CompanyResearchContextSchema, context)).toBe(true);
    for (const invalid of [
      { ...context, topicName: "" }, { ...context, industry: "legacy" },
      { ...context, researchScope: "legacy" }, { ...context, apiKey: "secret" },
      { ...context, stockListings: [{ exchange: "HKEX", ticker: 1810 }] },
    ]) expect(Value.Check(contracts.CompanyResearchContextSchema, invalid)).toBe(false);
  });

  it("rejects malformed and expanded persisted template snapshots", () => {
    expect(contracts.CompanyResearchTemplateSnapshotSchema).toBeDefined();
    const template = structuredClone(contracts.getCompanyResearchTemplate("product_and_technology"));
    for (const invalid of [
      { ...template, templateVersion: 2 }, { ...template, templateId: "all" },
      { ...template, sections: template.sections.slice(1) },
      { ...template, sections: [...template.sections, template.sections[0]] },
      { ...template, sections: template.sections.map((section) => ({ ...section, editable: true })) },
    ]) expect(Value.Check(contracts.CompanyResearchTemplateSnapshotSchema, invalid)).toBe(false);
  });

  it("bounds structured content and rejects extra fields at every nested level", () => {
    expect(contracts.StructuredResearchContentSchema).toBeDefined();
    const valid = content();
    expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(true);
    for (const target of [valid, valid.sections[0]!, valid.sections[0]!.facts[0]!, valid.sections[0]!.facts[0]!.source]) {
      Object.assign(target, { id: "unrequested-content-id" });
      expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(false);
      Reflect.deleteProperty(target, "id");
    }
    for (const invalid of [
      { ...valid, coreSummary: [] }, { ...valid, coreSummary: Array(5).fill("summary") },
      { ...valid, coreSummary: [""] }, { ...valid, coreSummary: ["x".repeat(4001)] },
      { ...valid, sections: valid.sections.slice(1) },
    ]) expect(Value.Check(contracts.StructuredResearchContentSchema, invalid)).toBe(false);
    const section = valid.sections[0]!;
    for (const field of ["text", "timeContext"] as const) {
      section.facts = [{ ...fact, [field]: "x".repeat(4001) }];
      expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(false);
    }
    for (const invalidFact of [
      { ...fact, text: "" }, { ...fact, claimType: "verified" },
      { ...fact, source: { ...fact.source, title: "x".repeat(1001) } },
      { ...fact, source: { ...fact.source, url: "x".repeat(4001) } },
      { ...fact, source: { title: "", url: "" } },
    ]) {
      section.facts = [invalidFact];
      expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(false);
    }
    section.facts = Array(9).fill(fact);
    expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(false);
    section.facts = Array(8).fill({ ...fact, text: "x".repeat(4000), timeContext: null, source: { title: "x".repeat(1000), url: "x".repeat(4000) } });
    section.summary = "x".repeat(4000);
    expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(true);
    section.summary = "x".repeat(4001);
    expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(false);
  });

  it("accepts all five status and claim literals and nullable content", () => {
    expect(contracts.StructuredResearchContentSchema).toBeDefined();
    const valid = content();
    valid.sections = valid.sections.map((section, index) => ({
      ...section, status: ["found", "partial", "not_found", "not_disclosed", "conflicting"][index]!,
      facts: [{ ...fact, claimType: ["reported_fact", "company_statement", "plan", "estimate", "forecast"][index]! }],
    }));
    expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(true);
    expect(Value.Check(contracts.StructuredResearchContentSchema, { ...valid, sections: valid.sections.map((section) => ({ ...section, summary: null, facts: [] })) })).toBe(true);
    // Cross-field status rules, exact module order and source inheritance are Harness responsibilities.
    valid.sections[0]!.status = "not_applicable";
    expect(Value.Check(contracts.StructuredResearchContentSchema, valid)).toBe(false);
  });

  it("validates versioned run details including nested JSON and isolates legacy fields", () => {
    expect(contracts.ResearchRunSchema).toBeDefined();
    const run = { ...identity, schemaVersion: "company-research-report-v1", status: "completed", ...input, researchContext: context, template: contracts.getCompanyResearchTemplate("product_and_technology"), harnessVersion: 1, structuringAttempts: 1, rawReportText: "# 原始报告", structuredContent: content(), rawCompletedAt: identity.createdAt, completedAt: identity.createdAt };
    expect(Value.Check(contracts.ResearchRunSchema, JSON.parse(JSON.stringify(run)))).toBe(true);
    for (const status of ["researching", "research_failed", "structuring", "structure_failed", "completed"]) expect(Value.Check(contracts.ResearchRunSchema, { ...run, status })).toBe(true);
    const failed = {
      ...identity, schemaVersion: "company-research-report-v1", status: "research_failed",
      ...input, researchContext: context, template: contracts.getCompanyResearchTemplate("product_and_technology"),
      harnessVersion: 1, structuringAttempts: 0, lastFailureCode: "tool_failed",
    };
    expect(Value.Check(contracts.ResearchRunSchema, failed)).toBe(true);
    const { researchContext: _context, template: _template, harnessVersion: _harnessVersion, ...failedSummary } = failed;
    expect(Value.Check(contracts.ResearchRunSummarySchema, failedSummary)).toBe(true);
    for (const invalid of [
      { ...run, schemaVersion: "unknown" }, { ...run, status: "running" },
      { ...run, reportText: "legacy" }, { ...run, structuringAttempts: -1 },
      { ...run, structuringAttempts: 1.5 }, { ...run, lastFailureCode: "raw-secret" },
      { ...run, researchContext: { ...context, topicName: 1 } },
      { ...run, template: { ...run.template, templateVersion: 9 } },
      { ...run, structuredContent: { ...content(), userWorkingCopy: {} } },
    ]) expect(Value.Check(contracts.ResearchRunSchema, invalid)).toBe(false);
    const legacy = { ...identity, schemaVersion: "legacy-freeform-v1", status: "completed", timeScope: "近一年", customRequirements: "旧要求", reportText: "旧报告", completedAt: identity.createdAt };
    expect(Value.Check(contracts.ResearchRunSchema, legacy)).toBe(true);
    expect(Value.Check(contracts.ResearchRunSummarySchema, legacy)).toBe(false);
    const legacySummary = { ...legacy };
    Reflect.deleteProperty(legacySummary, "reportText");
    expect(Value.Check(contracts.ResearchRunSummarySchema, legacySummary)).toBe(true);
    expect(Value.Check(contracts.ResearchRunSchema, { ...legacy, status: "running" })).toBe(false);
    expect(Value.Check(contracts.ResearchRunSchema, { ...legacy, direction: input.direction })).toBe(false);
  });

  it("reads nonblank legacy bodies above 1M without relaxing the new report limit", () => {
    const reportText = "旧".repeat(1_000_001);
    const legacy = { ...identity, schemaVersion: "legacy-freeform-v1", status: "completed", timeScope: "近一年", reportText, completedAt: identity.createdAt };
    expect(Value.Check(contracts.LegacyResearchRunSchema, legacy)).toBe(true);
    expect(Value.Check(contracts.ResearchRunSchema, JSON.parse(JSON.stringify(legacy)))).toBe(true);
    for (const blank of ["", " \t\n\r\u3000"]) {
      expect(Value.Check(contracts.ResearchRunSchema, { ...legacy, reportText: blank })).toBe(false);
    }
    const run = { ...identity, schemaVersion: "company-research-report-v1", status: "structuring", ...input, researchContext: context, template: contracts.getCompanyResearchTemplate("product_and_technology"), harnessVersion: 1, structuringAttempts: 1, rawReportText: reportText };
    expect(Value.Check(contracts.ResearchRunSchema, run)).toBe(false);
    expect(Value.Check(contracts.ResearchRunSchema, { ...run, rawReportText: reportText.slice(0, 1_000_000) })).toBe(true);
  });

  it("keeps summaries body-free and exposes occupancy even when the target has no active run", () => {
    expect(contracts.CompanyResearchStateSchema).toBeDefined();
    const summary = { ...identity, schemaVersion: "company-research-report-v1", status: "structure_failed", ...input, structuringAttempts: 1, lastFailureCode: "structuring_failed" };
    expect(Value.Check(contracts.ResearchRunSummarySchema, summary)).toBe(true);
    for (const field of ["rawReportText", "structuredContent", "reportText", "researchContext", "template"]) {
      expect(Value.Check(contracts.ResearchRunSummarySchema, { ...summary, [field]: "body" })).toBe(false);
      expect(Value.Check(contracts.KeyResearchRunSummarySchema, { ...summary, [field]: "body" })).toBe(false);
    }
    const state = { runs: [summary], globalActiveRun: { runId: "other-run", itemId: "other-item", companyId: "other-company", stage: "structure" } };
    expect(Value.Check(contracts.CompanyResearchStateSchema, state)).toBe(true);
    expect(Value.Check(contracts.CompanyResearchStateSchema, { runs: [], globalActiveRun: null })).toBe(true);
    expect(Value.Check(contracts.CompanyResearchStateSchema, { runs: [] })).toBe(false);
    expect(Value.Check(contracts.CompanyResearchStateSchema, { ...state, runs: [{ ...summary, status: "researching" }] })).toBe(false);
    expect(Value.Check(contracts.CompanyResearchStateSchema, { ...state, globalActiveRun: { ...state.globalActiveRun, stage: "completed" } })).toBe(false);
    expect(Value.Check(contracts.CompanyResearchStateSchema, { runs: [], globalActiveRun: state.globalActiveRun, active: { run: { ...summary, status: "structuring" }, draftText: "" } })).toBe(true);
  });

  it("requires target triples for retry/getRun and exposes only summary history through DesktopApi", () => {
    expect(contracts.CompanyResearchGetRunArgsSchema).toBeDefined();
    for (const schema of [contracts.CompanyResearchGetRunArgsSchema, contracts.CompanyResearchRetryStructuringArgsSchema]) {
      expect(Value.Check(schema, ["item", "company", "run"])).toBe(true);
      for (const invalid of [["run"], ["item", "company"], ["item", "company", ""], ["item", "company", "run", "extra"]]) expect(Value.Check(schema, invalid)).toBe(false);
    }
    expectTypeOf<DesktopApi["companyResearch"]["getRun"]>().parameters.toEqualTypeOf<[string, string, string]>();
    expectTypeOf<DesktopApi["companyResearch"]["retryStructuring"]>().parameters.toEqualTypeOf<[string, string, string]>();
    expectTypeOf<DesktopApi["companyResearch"]["listRuns"]>().returns.toEqualTypeOf<Promise<contracts.ResearchRunSummary[]>>();
    expectTypeOf<Parameters<DesktopApi["companyResearch"]["subscribe"]>[0]>().toEqualTypeOf<(event: contracts.CompanyResearchEvent) => void>();
  });
});
