import { describe, expect, it } from "vitest";
import { profileSchemaIssues, safeProfilePath } from "./profile-diagnostic.js";
import { profileResult } from "../../../../packages/application/src/testing/company-profile-test-fixtures.js";
describe("safe profile validation diagnostics", () => {
  it("reports reference item type without retaining values or arbitrary property names", () => {
    const { sources: _sources, ...candidate } = profileResult({ legalName: "secret-value" });
    const issues = profileSchemaIssues({ ...candidate, fieldEvidence: { legalName: ["https://sk-secret.invalid"] }, "sk-secret-key": "secret" });
    expect(issues).toContainEqual({ path: "/fieldEvidence/legalName/0", expected: "object", actual: "string" });
    expect(JSON.stringify(issues)).not.toContain("secret");
    expect(safeProfilePath("/fieldEvidence/sk-secret-key/0/url")).toBe("/fieldEvidence/*/0/url");
  });
});
