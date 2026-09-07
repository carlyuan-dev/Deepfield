import { formatSkillInvocation, loadSkills, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { SkillSummary } from "@deepfield/contracts";

export interface PiSkillCatalog {
  list(): SkillSummary[];
  formatInvocation(name: string, instructions: string): string;
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Skill not found: ${name}`);
    this.name = "SkillNotFoundError";
  }
}

export async function loadPiSkillCatalog(
  skillsDir: string,
): Promise<{ catalog: PiSkillCatalog; diagnostics: string[] }> {
  const env = new NodeExecutionEnv({ cwd: skillsDir });
  const { skills, diagnostics } = await loadSkills(env, skillsDir);
  return {
    catalog: new LoadedSkillCatalog(skills),
    diagnostics: diagnostics.map((diagnostic) => diagnostic.message),
  };
}

class LoadedSkillCatalog implements PiSkillCatalog {
  private readonly skills: Skill[];

  constructor(skills: Skill[]) {
    this.skills = skills;
  }

  list(): SkillSummary[] {
    return this.skills.map(({ name, description }) => ({ name, description }));
  }

  formatInvocation(name: string, instructions: string): string {
    const skill = this.skills.find((candidate) => candidate.name === name);
    if (skill === undefined) {
      throw new SkillNotFoundError(name);
    }
    return formatSkillInvocation(skill, instructions);
  }
}
