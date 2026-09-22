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
  it("reports bounded sanitized evidence mismatch detail without model or page text", () => {
    const ledger = new ProfileEvidenceLedger();
    const actualUrl = "https://user:pass@example.com/company?token=secret#private";
    ledger.record("web_search", { query: "secret query", provider: "fixture", results: [
      { title: "Source", url: actualUrl, snippet: "private page text", rank: 1, provider: "fixture" },
    ] });
    const badRef = { url: actualUrl, kind: "opened_page" as const };
    try { ledger.validate({ ...candidate, identity: { ...candidate.identity, sources: [{ url: actualUrl, kind: "search_snippet" as const }] }, fieldEvidence: { legalName: [badRef] } }); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toMatchObject({ detail: {
        reason: "kind_mismatch", path: "/fieldEvidence/legalName",
        modelRef: { url: "https://example.com/company", kind: "opened_page" },
        actualSources: [{ url: "https://example.com/company", kind: "search_snippet" }],
      } });
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("private page text");
    }
  });
  it("distinguishes an empty reference list from an absent ledger URL", () => {
    for (const [value, reason] of [
      [{ ...candidate, fieldEvidence: {} }, "empty_refs"],
      [{ ...candidate, fieldEvidence: { legalName: [] } }, "empty_refs"],
      [{ ...candidate, fieldEvidence: { legalName: [{ ...ref, url: "https://missing.example/path?q=sensitive" }] } }, "url_absent"],
    ] as const) {
      try { searched().validate(value); throw new Error("expected rejection"); }
      catch (error) { expect(error).toMatchObject({ detail: { reason, path: "/fieldEvidence/legalName" } }); }
    }
  });
  it("includes an opened page recorded after more than ten snippets in absent-URL detail", () => {
    const ledger = new ProfileEvidenceLedger();
    for (let batch = 0; batch < 2; batch++) ledger.record("web_search", { query: `batch-${batch}`, provider: "fixture", results: Array.from({ length: 10 }, (_, index) => ({ title: `Source ${batch}-${index}`, url: `https://example.com/${batch}-${index}`, snippet: "public evidence", rank: index + 1, provider: "fixture" })) });
    ledger.record("read_webpage", { url: "https://example.com/opened", title: "Opened", text: "opened evidence", characterCount: 15, truncated: false });
    const value = { ...candidate, identity: { ...candidate.identity, sources: [{ url: "https://missing.example", kind: "search_snippet" as const }] } };
    try { ledger.validate(value); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toMatchObject({ detail: { totalSourceCount: 21, truncated: false } });
      expect((error as { detail: { actualSources: Array<{ url: string; kind: string }> } }).detail.actualSources).toContainEqual(expect.objectContaining({ url: "https://example.com/opened", kind: "opened_page" }));
    }
  });
});
