import { join } from "node:path";

interface ResolveSkillsDirInput {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}

export function resolveSkillsDir(input: ResolveSkillsDirInput): string {
  return input.isPackaged
    ? join(input.resourcesPath, "skills")
    : join(input.appPath, "skills");
}
