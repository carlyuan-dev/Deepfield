import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readManifestFile, validatePackagePaths } from "./package-paths.js";

describe("readManifestFile", () => {
  it("rejects a manifest over 256 KiB before reading it", async () => {
    const readFile = vi.fn();
    const result = await readManifestFile("/package/capability.json", {
      stat: async () => ({ size: 256 * 1024 + 1 }),
      readFile,
    });
    expect(result).toEqual({ ok: false, code: "manifest_too_large" });
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("validatePackagePaths", () => {
  it.each([
    ["missing entry", { main: "dist/missing.js", worker: "dist/worker.js" }, "entry_missing"],
    ["parent traversal", { main: "../outside.js", worker: "dist/worker.js" }, "invalid_path"],
    ["absolute path", { main: "/outside.js", worker: "dist/worker.js" }, "invalid_path"],
  ] as const)("rejects %s", async (_name, entries, code) => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-paths-"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/worker.js"), "export {}");
    expect(await validatePackagePaths(root, { entries, documentationPaths: [] })).toEqual({ ok: false, code });
  });

  it("rejects an entry symlink resolving outside the package", async () => {
    const parent = await mkdtemp(join(tmpdir(), "deepfield-paths-"));
    const root = join(parent, "package");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/worker.js"), "export {}");
    await writeFile(join(parent, "outside.js"), "export {}");
    await symlink(join(parent, "outside.js"), join(root, "dist/main.js"));
    expect(await validatePackagePaths(root, {
      entries: { main: "dist/main.js", worker: "dist/worker.js" },
      documentationPaths: [],
    })).toEqual({ ok: false, code: "path_outside_package" });
  });

  it("validates documentation existence and realpath containment too", async () => {
    const parent = await mkdtemp(join(tmpdir(), "deepfield-paths-"));
    const root = join(parent, "package");
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "dist/main.js"), "export {}");
    await writeFile(join(root, "dist/worker.js"), "export {}");

    expect(await validatePackagePaths(root, {
      entries: { main: "dist/main.js", worker: "dist/worker.js" },
      documentationPaths: ["docs/missing.md"],
    })).toEqual({ ok: false, code: "documentation_missing" });

    await writeFile(join(parent, "outside.md"), "outside");
    await symlink(join(parent, "outside.md"), join(root, "docs/run.md"));
    expect(await validatePackagePaths(root, {
      entries: { main: "dist/main.js", worker: "dist/worker.js" },
      documentationPaths: ["docs/run.md"],
    })).toEqual({ ok: false, code: "path_outside_package" });
  });
});
