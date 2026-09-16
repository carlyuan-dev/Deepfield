import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { CompanyResearchExportArgsSchema, CompanyResearchWordExportResultSchema } from "./ipc.js";

describe("company research Word export contract", () => {
  it("accepts only three bounded identifiers plus an explicit bounded selection and a path-free result", () => {
    expect(Value.Check(CompanyResearchExportArgsSchema, ["item-1", "company-1", "run-1", { raw: true, structured: false }])).toBe(true);
    expect(Value.Check(CompanyResearchExportArgsSchema, ["item-1", "company-1", "run-1", { raw: true, structured: true }])).toBe(true);
    expect(Value.Check(CompanyResearchExportArgsSchema, ["item-1", "company-1", "run-1"])).toBe(false);
    expect(Value.Check(CompanyResearchExportArgsSchema, ["item-1", "company-1", "run-1", { raw: true, structured: false, extra: true }])).toBe(false);
    expect(Value.Check(CompanyResearchExportArgsSchema, ["item-1", "company-1", "run-1", { raw: "yes", structured: false }])).toBe(false);
    expect(Value.Check(CompanyResearchExportArgsSchema, ["item-1", "company-1", "x".repeat(201)])).toBe(false);
    expect(Value.Check(CompanyResearchWordExportResultSchema, { status: "saved" })).toBe(true);
    expect(Value.Check(CompanyResearchWordExportResultSchema, { status: "cancelled" })).toBe(true);
    expect(Value.Check(CompanyResearchWordExportResultSchema, { status: "saved", path: "/private/report.docx" })).toBe(false);
  });
});
