import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  CompanyProfileDiagnosticSchema,
  CompanyProfileWorkerRequestSchema,
} from "./company-profile.js";

const request = {
  kind: "company-profile.enrich" as const,
  requestId: "request-1",
  companyId: "company-1",
  name: "原始歧义名称",
  researchTopics: [],
  existingFields: {},
  llm: {
    id: "llm-1", name: "OpenAI", provider: "openai" as const,
    protocol: "openai_compatible" as const, baseUrl: "https://api.openai.com/v1",
    modelId: "model-1", contextWindow: 128_000, apiKey: "secret",
  },
  search: {
    id: "search-1", name: "Tavily", provider: "tavily" as const,
    baseUrl: "https://api.tavily.com", options: {}, apiKey: "secret",
  },
};

const diagnostic = {
  kind: "company-profile.event" as const,
  requestId: "request-1",
  companyId: "company-1",
  type: "diagnostic" as const,
  phase: "complete" as const,
  code: "ok" as const,
  schemaIssues: [],
  searchSourceCount: 1,
  openedSourceCount: 0,
  searchToolCalls: 1,
  readToolCalls: 0,
  outputChars: 100,
};

describe("company profile worker contract", () => {
  it("accepts a precise optional identity hint and rejects blank names or non-http websites", () => {
    expect(Value.Check(CompanyProfileWorkerRequestSchema, {
      ...request,
      identityHint: { name: "精确主体有限公司", officialWebsite: "https://example.com/company" },
    })).toBe(true);
    expect(Value.Check(CompanyProfileWorkerRequestSchema, request)).toBe(true);
    expect(Value.Check(CompanyProfileWorkerRequestSchema, {
      ...request,
      identityHint: { name: "   ", officialWebsite: "https://example.com" },
    })).toBe(false);
    expect(Value.Check(CompanyProfileWorkerRequestSchema, {
      ...request,
      identityHint: { name: "精确主体有限公司", officialWebsite: "ftp://example.com" },
    })).toBe(false);
  });

  it("accepts bounded format-repair diagnostics without making them mandatory", () => {
    expect(Value.Check(CompanyProfileDiagnosticSchema, diagnostic)).toBe(true);
    expect(Value.Check(CompanyProfileDiagnosticSchema, {
      ...diagnostic,
      formatRepair: { attempted: true, outcome: "succeeded", durationMs: 12 },
    })).toBe(true);
    expect(Value.Check(CompanyProfileDiagnosticSchema, {
      ...diagnostic,
      formatRepair: { attempted: true, outcome: "retried", durationMs: -1 },
    })).toBe(false);
  });
});
