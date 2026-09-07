import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillNotFoundError, loadPiSkillCatalog } from "./pi-skill-catalog.js";

const SKILL_MD = `---
name: structured-brief
description: Turn a topic or rough notes into a concise three-part research brief.
---

Return exactly three sections:

1. 核心结论
2. 关键依据
3. 待核实问题

Keep each section concise. Clearly separate known information from uncertainty.
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function loadStructuredBriefCatalog() {
  const root = mkdtempSync(join(tmpdir(), "deepfield-pi-skills-"));
  dirs.push(root);
  mkdirSync(join(root, "structured-brief"), { recursive: true });
  writeFileSync(join(root, "structured-brief", "SKILL.md"), SKILL_MD);
  return loadPiSkillCatalog(root);
}

describe("Pi skill catalog", () => {
  it("loads a standard SKILL.md and lists only name and description", async () => {
    const { catalog, diagnostics } = await loadStructuredBriefCatalog();

    expect(diagnostics).toEqual([]);

    const summaries = catalog.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      name: "structured-brief",
      description: "Turn a topic or rough notes into a concise three-part research brief.",
    });
    expect(Object.keys(summaries[0]!)).toEqual(["name", "description"]);
  });

  it("formats the invocation with Pi and includes the user instructions", async () => {
    const { catalog } = await loadStructuredBriefCatalog();

    const instructions = "研究一下人形机器人整机设计的目标";
    const invocation = catalog.formatInvocation("structured-brief", instructions);

    expect(invocation).toContain('<skill name="structured-brief"');
    expect(invocation).toContain("1. 核心结论");
    expect(invocation).toContain(instructions);
  });

  it("throws SkillNotFoundError for an unknown skill name", async () => {
    const { catalog } = await loadStructuredBriefCatalog();

    expect(() => catalog.formatInvocation("missing-skill", "任何指令")).toThrow(SkillNotFoundError);
  });
});
