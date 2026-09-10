import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./capability.css", import.meta.url), "utf8");

describe("company list status alignment", () => {
  it("centers both the enrichment spinner and remove control within a company row", () => {
    expect(css).toMatch(/\.company-profile-spinner\s*\{[^}]*align-self:\s*center;/su);
    expect(css).toMatch(/\.company-remove-button\s*\{[^}]*align-self:\s*center;/su);
  });
});
