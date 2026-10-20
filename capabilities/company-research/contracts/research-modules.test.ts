import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { buildStructuredResearchOutputSchema, createCompanyResearchTemplate, normalizeResearchModuleIds, RESEARCH_MODULE_GROUPS, StartCompanyResearchInputSchema, type ResearchModuleId } from "./index.js";
import { validateStructuredResearchContent } from "../application/company-research-harness.js";
import { normalizeRawResearchModules } from "../runtime/company-research-agent.js";
import { structureResearchRequest } from "../runtime/company-research-test-helpers.js";
import { validateResearchWorkerContract } from "../worker.js";

describe("selected research modules", () => {
  it("rejects empty, oversized, duplicate and unknown selections before canonicalization", () => {
    const all = RESEARCH_MODULE_GROUPS.flatMap(group => group.modules.map(module => module.sectionId));
    for (const moduleIds of [[], all.slice(0, 5), [all[0], all[0]], ["unknown"]]) {
      expect(Value.Check(StartCompanyResearchInputSchema, { moduleIds, asOfDate: "2026-10-01" })).toBe(false);
      expect(() => normalizeResearchModuleIds(moduleIds as ResearchModuleId[])).toThrow();
    }
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
  });
  it("uses the fixed catalog order across groups and freezes the complete selected definitions", () => {
    const ids: ResearchModuleId[] = ["financial_performance", "products_and_positioning", "sales_and_adoption"];
    const template = createCompanyResearchTemplate(ids);
    expect(normalizeResearchModuleIds(ids)).toEqual(["products_and_positioning", "sales_and_adoption", "financial_performance"]);
    expect(template).toMatchObject({ templateId: "selected_modules", templateVersion: 2 });
    expect(template.sections.map(section => section.sectionId)).toEqual(normalizeResearchModuleIds(ids));
    expect(Object.isFrozen(template.sections[0])).toBe(true);
  });
  it.each([["products_and_positioning"], ["products_and_positioning", "sales_and_adoption", "key_relationships", "financial_performance"]])("binds output schema and harness to %j", (...ids) => {
    const template = createCompanyResearchTemplate(ids as ResearchModuleId[]);
    const candidate = { coreSummary: ["现有公开信息不足以形成可靠的核心判断。"], sections: template.sections.map(({ sectionId }) => ({ sectionId, status: "not_found", summary: null, facts: [] })) };
    const schema = Type.Unsafe(buildStructuredResearchOutputSchema(template));
    expect(Value.Check(schema, candidate)).toBe(true);
    expect(validateStructuredResearchContent(JSON.stringify(candidate), template)).toEqual(candidate);
    const invalid = [
      { ...candidate, sections: [...candidate.sections, candidate.sections[0]] },
      { ...candidate, sections: candidate.sections.slice(1) },
      { ...candidate, sections: candidate.sections.map((section, index) => index ? section : { ...section, sectionId: "technology_and_metrics" }) },
      ...(ids.length > 1 ? [{ ...candidate, sections: [...candidate.sections].reverse() }] : []),
    ];
    for (const value of invalid) {
      expect(Value.Check(schema, value)).toBe(false);
      expect(() => validateStructuredResearchContent(JSON.stringify(value), template)).toThrow();
    }
  });
  it("rejects arbitrary or altered worker output schemas", () => {
    const request = structureResearchRequest();
    expect(() => validateResearchWorkerContract(request)).not.toThrow();
    expect(() => validateResearchWorkerContract({ ...request, outputSchema: { type: "object" } })).toThrow("invalid_research_contract");
    expect(() => validateResearchWorkerContract({ ...request, template: { ...request.template, sections: [...request.template.sections].reverse() } })).toThrow("invalid_research_contract");
  });
  it("normalizes harmless raw heading formatting while enforcing selected identities and order", () => {
    const template = createCompanyResearchTemplate(["products_and_positioning", "financial_performance"]);
    const raw = "## 调研任务\n目标公司\n## **主要产品与定位** `products_and_positioning`\n事实\n## 2、核心财务表现\n事实";
    expect(normalizeRawResearchModules(raw, template)).toContain("## 1. 主要产品与定位\n");
    expect(normalizeRawResearchModules(raw, template)).not.toContain("products_and_positioning");
    expect(normalizeRawResearchModules(raw.replace("## **主要产品与定位** `products_and_positioning`", "## **1. 主要产品与定位**"), template))
      .toBe(normalizeRawResearchModules(raw, template));
    expect(normalizeRawResearchModules(raw.replace("## **主要产品与定位** `products_and_positioning`", "## 1. **主要产品与定位**"), template))
      .toBe(normalizeRawResearchModules(raw, template));
    for (const text of [raw.replace("products_and_positioning", "sales_and_adoption"), raw.replace("核心财务表现", "销售与采用情况"), raw.split("## 2、")[0]!, raw + "\n## 3. 销售与采用情况"]) {
      expect(() => normalizeRawResearchModules(text, template)).toThrow("incomplete_response");
    }
  });
});
