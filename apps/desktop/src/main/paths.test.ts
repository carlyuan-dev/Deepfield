import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createAppPaths, resolveUserDataRoot } from "./paths.js";

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

describe("user data root resolution", () => {
  const dev = (override: string | undefined) =>
    resolveUserDataRoot({ defaultRoot: "/default", override, isPackaged: false, isE2E: false });
  const prod = (override: string | undefined) =>
    resolveUserDataRoot({ defaultRoot: "/default", override, isPackaged: true, isE2E: false });
  const e2ePackaged = (override: string | undefined) =>
    resolveUserDataRoot({ defaultRoot: "/default", override, isPackaged: true, isE2E: true });

  it("uses the override in development", () => {
    expect(dev("/dev-data")).toBe("/dev-data");
  });

  it("uses the override for an E2E packaged app", () => {
    expect(e2ePackaged("/e2e-data")).toBe("/e2e-data");
  });

  it("ignores the override for a production packaged app", () => {
    expect(prod("/override-should-be-ignored")).toBe("/default");
  });

  it("falls back to the default root when no override is set", () => {
    expect(dev(undefined)).toBe("/default");
    expect(prod(undefined)).toBe("/default");
    expect(e2ePackaged(undefined)).toBe("/default");
  });

  it("treats a blank override as unset", () => {
    expect(dev("   ")).toBe("/default");
    expect(e2ePackaged("  ")).toBe("/default");
  });

  it("trims the override value", () => {
    expect(dev("  /padded-data  ")).toBe("/padded-data");
  });
});
