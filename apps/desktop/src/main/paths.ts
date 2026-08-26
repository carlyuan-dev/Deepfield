import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppPaths {
  root: string;
  database: string;
  secretsFile: string;
  attachments: string;
}

export function createAppPaths(userDataRoot: string): AppPaths {
  const paths: AppPaths = {
    root: userDataRoot,
    database: join(userDataRoot, "deepfield.sqlite"),
    secretsFile: join(userDataRoot, "secrets.json"),
    attachments: join(userDataRoot, "attachments"),
  };
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.attachments, { recursive: true });
  return paths;
}
