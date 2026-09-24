import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_USER_HELP_BYTES, readManifestFile, readPackageUserHelp, validatePackagePaths } from "./package-paths.js";

describe("readPackageUserHelp", () => {
  it("reads bounded UTF-8 Markdown and falls back for absent, empty and unsafe help", async () => {
    const parent = await mkdtemp(join(tmpdir(), "deepfield-help-"));
    const root = join(parent, "package"); await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/help.md"), "用途。\n\n- 新建一个主题\n");
    expect(await readPackageUserHelp(root, "docs/help.md")).toBe("用途。\n\n- 新建一个主题");
    expect(await readPackageUserHelp(root, undefined)).toBeUndefined();
    expect(await readPackageUserHelp(root, "docs/missing.md")).toBeUndefined();
    await writeFile(join(root, "docs/empty.md"), "  \n");
    expect(await readPackageUserHelp(root, "docs/empty.md")).toBeUndefined();
    expect(await readPackageUserHelp(root, "../outside.md")).toBeUndefined();
    expect(await readPackageUserHelp(root, "/tmp/outside.md")).toBeUndefined();
    await writeFile(join(parent, "outside.md"), "must not read");
    await symlink(join(parent, "outside.md"), join(root, "docs/link.md"));
    expect(await readPackageUserHelp(root, "docs/link.md")).toBeUndefined();
    await writeFile(join(root, "docs/large.md"), "x".repeat(MAX_USER_HELP_BYTES + 1));
    expect(await readPackageUserHelp(root, "docs/large.md")).toBeUndefined();
    await writeFile(join(root, "docs/invalid.md"), Buffer.from([0xff, 0xfe]));
    expect(await readPackageUserHelp(root, "docs/invalid.md")).toBeUndefined();
  });
});

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
