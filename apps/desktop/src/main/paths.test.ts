import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createAppPaths } from "./paths.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("app paths", () => {
  it("derives database, secrets and attachments from the user data root", () => {
    const root = mkdtempSync(join(tmpdir(), "deepfield-paths-"));
    dirs.push(root);
    const paths = createAppPaths(root);
    expect(paths.database).toBe(join(root, "deepfield.sqlite"));
    expect(paths.secretsFile).toBe(join(root, "secrets.json"));
    expect(paths.attachments).toBe(join(root, "attachments"));
    expect(existsSync(root)).toBe(true);
    expect(existsSync(paths.attachments)).toBe(true);
    expect(statSync(paths.attachments).isDirectory()).toBe(true);
  });
});
