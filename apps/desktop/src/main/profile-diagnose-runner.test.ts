import { describe, expect, it } from "vitest";
import { runProfileDiagnostic } from "./profile-diagnose-runner.js";
import { rawResearchRequest } from "../../../../capabilities/company-research/runtime/company-research-test-helpers.js";
import { profileResult } from "../../../../packages/application/src/testing/company-profile-test-fixtures.js";
describe("isolated diagnostic harness", () => {
  it("never outputs request credentials, profile fields or model text", async () => {
    const raw = rawResearchRequest(); const lines: string[] = [];
    const code = await runProfileDiagnostic({ kind: "company-profile.enrich", requestId: "trace", companyId: "c", name: "name-secret", researchTopics: [], existingFields: {}, llm: raw.llm, search: raw.search }, (line) => lines.push(line), { async run(request, emit) {
      emit({ kind: "company-profile.event", requestId: request.requestId, companyId: request.companyId, type: "diagnostic", phase: "complete", code: "ok", schemaIssues: [], searchSourceCount: 1, openedSourceCount: 0, searchToolCalls: 1, readToolCalls: 0, outputChars: 100 });
      emit({ kind: "company-profile.event", requestId: request.requestId, companyId: request.companyId, type: "completed", result: profileResult({ legalName: "secret-result" }) });
    } });
    expect(code).toBe(0); expect(lines).toHaveLength(2); expect(lines.join()).not.toContain("secret"); expect(lines.join()).not.toContain(raw.search.apiKey);
    expect(JSON.parse(lines[1]!)).toEqual({ kind: "profile-diagnose.terminal", requestId: "trace", companyId: "c", status: "completed" });
  });
  it("rejects invalid input before constructing an Agent", async () => {
    expect(await runProfileDiagnostic({ apiKey: "sk-secret" }, () => { throw Error("must not output"); })).toBe(1);
  });
});
