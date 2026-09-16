import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./settings.css", import.meta.url), "utf8");

describe("settings responsive layout", () => {
  it("stacks the profile list and editor based on available content width", () => {
    expect(css).toMatch(/\.settings-view\s*\{[^}]*container-type:\s*inline-size;/su);
    expect(css).toMatch(/@container\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.settings-layout\s*\{[^}]*grid-template-columns:\s*1fr;/u);
    expect(css).toMatch(/@container\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.profile-editor\s*\{[^}]*grid-template-columns:\s*1fr;/u);
  });

  it("lets long profile fields shrink and action rows wrap", () => {
    expect(css).toMatch(/\.profile-list,\s*\.profile-editor\s*\{[^}]*min-width:\s*0;/su);
    expect(css).toMatch(/\.profile-editor label\s*\{[^}]*min-width:\s*0;/su);
    expect(css).toMatch(/\.profile-editor input,\s*\.profile-editor select\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/su);
    expect(css).toMatch(/\.diagnostic-row,\s*\.editor-actions\s*\{[^}]*flex-wrap:\s*wrap;/su);
  });
});
