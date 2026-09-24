import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { CompanyProfileFieldsSchema } from "../contracts/index.js";
import { CompanyProfileModelCandidateSchema } from "./company-profile-model.js";
import { buildCompanyProfileRequestPrompt, companyProfileOutputInstructions, companyProfileOutputExamples } from "./company-profile-prompt.js";

describe("company profile structured output instructions", () => {
  it("shows a schema-valid matched example with every field and object source references", () => {
    const example = companyProfileOutputExamples[0];
    expect(Value.Check(CompanyProfileModelCandidateSchema, example)).toBe(true);
    expect(Object.keys(example.fields).sort()).toEqual(Object.keys(CompanyProfileFieldsSchema.properties).sort());
    for (const field of Object.keys(example.fields)) {
      expect(example.fieldEvidence[field]).toEqual([{ evidenceId: "e1" }]);
    }
    expect(example.fields.stockListings).toEqual([{ exchange: expect.any(String), ticker: expect.any(String) }]);
    expect(companyProfileOutputInstructions).toContain(JSON.stringify(example));
    expect(companyProfileOutputInstructions).toContain("不能是 URL 字符串数组");
  });
  it("shows separate valid ambiguous/unresolved shapes without matchedName or fields", () => {
    for (const example of companyProfileOutputExamples.slice(1)) {
      expect(Value.Check(CompanyProfileModelCandidateSchema, example)).toBe(true);
      expect(example.identity).not.toHaveProperty("matchedName");
      expect(example.fields).toEqual({}); expect(example.fieldEvidence).toEqual({});
      expect(companyProfileOutputInstructions).toContain(JSON.stringify(example));
    }
  });
  it("carries topics and the optional identity hint as explicit user intent", () => {
    const prompt = JSON.parse(buildCompanyProfileRequestPrompt({
      name: "摩托罗拉", researchTopics: ["手机"], existingFields: {},
      identityHint: { name: "Motorola Mobility LLC", officialWebsite: "https://www.motorola.com" },
    }));
    expect(prompt).toEqual({
      name: "摩托罗拉", researchTopics: ["手机"], existingFields: {},
      userIntendedSubject: { name: "Motorola Mobility LLC", officialWebsite: "https://www.motorola.com" },
    });
    expect(companyProfileOutputInstructions).toContain("比可能含糊的展示名称更强的用户意图");
    expect(companyProfileOutputInstructions).toContain("不能当作事实证据");
  });
  it("directs topic-aware disambiguation without mixing related entities", () => {
    expect(companyProfileOutputInstructions).toContain("名称、researchTopics 与本轮证据");
    expect(companyProfileOutputInstructions).toContain("三星 + 手机");
    expect(companyProfileOutputInstructions).toContain("摩托罗拉 + 手机");
    expect(companyProfileOutputInstructions).toContain("不能混用母公司、子公司、兄弟公司或历史主体的事实");
  });
});
