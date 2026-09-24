import { describe, expect, it } from "vitest";
import { ProfileEvidenceLedger } from "./company-profile-agent.js";

const ref = { url: "https://example.com", kind: "search_snippet" as const };
const candidate = { identity: { disposition: "matched", subjectType: "company", matchedName: "示例公司", reason: "来源确认主体", sources: [ref] }, fields: { legalName: "示例公司" }, fieldEvidence: { legalName: [ref] } };
function searched() {
  const ledger = new ProfileEvidenceLedger();
  ledger.record("web_search", { query: "示例", provider: "test", results: [{ title: "示例公司", url: ref.url, snippet: "示例公司注册信息", rank: 1, provider: "test" }] });
  return ledger;
}
describe("company profile evidence gate", () => {
  it("resolves stable IDs to exact parenthesized URLs and preserves snippet/page provenance", () => {
    const ledger = new ProfileEvidenceLedger();
    const url = "https://zh.wikipedia.org/wiki/月之暗面_(公司)";
    const output = { query: "月之暗面", provider: "test", results: [{ title: "月之暗面", url, snippet: "月之暗面是一家人工智能公司", rank: 1, provider: "test" }] };
    ledger.record("web_search", output);
    ledger.record("web_search", output);
    ledger.record("read_webpage", { url, title: "月之暗面", text: "月之暗面是一家人工智能公司", characterCount: 16, truncated: false });
    expect(ledger.evidence()).toMatchObject([
      { evidenceId: "e1", url, kind: "search_snippet" },
      { evidenceId: "e2", url, kind: "opened_page" },
    ]);
    const result = ledger.validate({ ...candidate,
      identity: { ...candidate.identity, matchedName: "月之暗面", sources: [{ evidenceId: "e1" }] },
      fields: { businessTags: ["人工智能"] }, fieldEvidence: { businessTags: [{ evidenceId: "e2" }] },
    });
    expect(result.identity.sources).toEqual([{ url, kind: "search_snippet" }]);
    expect(result.fieldEvidence.businessTags).toEqual([{ url, kind: "opened_page" }]);
    expect(JSON.stringify(result)).not.toContain("evidenceId");
    expect(result.identity).not.toHaveProperty("subjectType");
    expect(() => ledger.validate({ ...candidate, identity: { ...candidate.identity, sources: [{ evidenceId: "e999" }] } })).toThrow();
    expect(() => ledger.validate({ ...candidate, identity: { ...candidate.identity, sources: [{ url: url.slice(0, -1), kind: "search_snippet" }] } })).toThrow();
  });
  it.each(["brand", "product"])("does not mark a %s-only match as a completed corporate profile", (subjectType) => {
    const result = searched().validate({ ...candidate,
      identity: { ...candidate.identity, subjectType, matchedName: "文心大模型（ERNIE，百度）" },
      fields: { businessTags: ["大模型"] }, fieldEvidence: { businessTags: [ref] },
    });
    expect(result.identity.disposition).toBe("unresolved");
    expect(result.fields).toEqual({});
    expect(result.fieldEvidence).toEqual({});
  });
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
  it("requires corporate classification but does not invent legalName or headquarters for a verified company", () => {
    const partial = { ...candidate, fields: { businessTags: ["大模型"] }, fieldEvidence: { businessTags: [{ evidenceId: "e1" }] } };
    expect(searched().validate(partial).fields).toEqual({ businessTags: ["大模型"] });
    const { subjectType: _subjectType, ...unclassified } = candidate.identity;
    expect(() => searched().validate({ ...partial, identity: unclassified })).toThrow();
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
