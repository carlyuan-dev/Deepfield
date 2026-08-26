import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppPaths {
  root: string;
  database: string;
  secretsFile: string;
  attachments: string;
}

export interface UserDataRootOptions {
  defaultRoot: string;
  override: string | undefined;
  isPackaged: boolean;
  isE2E: boolean;
}

export function resolveUserDataRoot(options: UserDataRootOptions): string {
  const override = options.override?.trim();
  const overrideAllowed = !options.isPackaged || options.isE2E;
  if (overrideAllowed && override !== undefined && override.length > 0) {
    return override;
  }
  return options.defaultRoot;
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
