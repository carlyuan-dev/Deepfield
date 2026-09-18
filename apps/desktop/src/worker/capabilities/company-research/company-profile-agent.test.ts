import { describe, expect, it } from "vitest";
import { ProfileEvidenceLedger } from "./company-profile-agent.js";

const ref = { url: "https://example.com", kind: "search_snippet" as const };
const candidate = { identity: { disposition: "matched", matchedName: "示例公司", reason: "来源确认主体", sources: [ref] }, fields: { legalName: "示例公司" }, fieldEvidence: { legalName: [ref] } };
function searched() {
  const ledger = new ProfileEvidenceLedger();
  ledger.record("web_search", { query: "示例", provider: "test", results: [{ title: "示例公司", url: ref.url, snippet: "示例公司注册信息", rank: 1, provider: "test" }] });
  return ledger;
}
describe("company profile evidence gate", () => {
  it.each([
    ["schema_invalid", { ...candidate, fieldEvidence: { legalName: ["https://example.com"] } }],
    ["source_missing", { ...candidate, fieldEvidence: {} }],
    ["kind_mismatch", { ...candidate, fieldEvidence: { legalName: [{ ...ref, kind: "opened_page" }] } }],
    ["empty_field", { ...candidate, fields: { aliases: [] }, fieldEvidence: { aliases: [ref] } }],
    ["identity", { ...candidate, fields: {}, fieldEvidence: {} }],
  ])("retains safe %s diagnostic identity", (reason, value) => {
    try { searched().validate(value); throw new Error("expected rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "invalid_evidence", reason }); }
  });
  it("rejects no search and empty search, regardless of model claims", () => {
    expect(() => new ProfileEvidenceLedger().validate(candidate)).toThrow();
    const ledger = new ProfileEvidenceLedger();
    ledger.record("web_search", { query: "示例", provider: "fixture", results: [] });
    expect(() => ledger.validate(candidate)).toThrow();
  });
  it("rejects invented sources and unsupported fields", () => {
    expect(() => searched().validate({ ...candidate, fieldEvidence: { legalName: [{ ...ref, url: "https://invented.test" }] } })).toThrow();
    expect(() => searched().validate({ ...candidate, fieldEvidence: {} })).toThrow();
    expect(() => searched().validate({ ...candidate, identity: { ...candidate.identity, matchedName: " " } })).toThrow();
  });
  it("keeps useful partial fields with original tool provenance", () => {
    const result = searched().validate(candidate);
    expect(result.fields).toEqual({ legalName: "示例公司" });
    expect(result.sources).toEqual([{ ...ref, title: "示例公司", excerpt: "示例公司注册信息" }]);
  });
  it("does not treat snippets as opened pages and allows ambiguous identity without fields", () => {
    expect(() => searched().validate({ ...candidate, fieldEvidence: { legalName: [{ ...ref, kind: "opened_page" }] } })).toThrow();
    expect(searched().validate({ ...candidate, identity: { disposition: "ambiguous", reason: "同名主体待确认", sources: candidate.identity.sources }, fields: {}, fieldEvidence: {} }).identity.disposition).toBe("ambiguous");
    expect(() => searched().validate({ ...candidate, identity: { ...candidate.identity, disposition: "ambiguous" }, fields: {}, fieldEvidence: {} })).toThrow();
  });
  it("accepts only nonempty opened output and retains its returned canonical URL", () => {
    const ledger = searched();
    const opened = { url: "https://example.com/canonical", kind: "opened_page" as const };
    ledger.record("read_webpage", { url: opened.url, title: "公司页面", text: "", characterCount: 0, truncated: false });
    const withPage = { ...candidate, fieldEvidence: { legalName: [opened] } };
    expect(() => ledger.validate(withPage)).toThrow();
    ledger.record("read_webpage", { url: opened.url, title: "公司页面", text: "示例公司", characterCount: 4, truncated: false });
    expect(ledger.validate(withPage).sources).toContainEqual({ ...opened, title: "公司页面", excerpt: "示例公司" });
  });
});
