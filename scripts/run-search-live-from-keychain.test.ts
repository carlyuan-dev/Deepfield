import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "run-search-live-from-keychain.zsh");
const FAKE_SECRET = "sk-fake-metaso";

interface Sandbox {
  dir: string;
  bin: string;
  assertion: string;
  markerSecurity: string;
  markerNpm: string;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "df-keychain-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  return {
    dir,
    bin,
    assertion: join(dir, "assertions.txt"),
    markerSecurity: join(dir, "security-invoked"),
    markerNpm: join(dir, "npm-invoked"),
  };
}

function writeFakes(sandbox: Sandbox, securityOutput: string): void {
  writeFileSync(
    join(sandbox.bin, "security"),
    `#!/bin/sh\n: > "${sandbox.markerSecurity}"\nprintf '%s\\n' '${securityOutput}'\n`,
  );
  writeFileSync(
    join(sandbox.bin, "npm"),
    `#!/bin/sh\n: > "${sandbox.markerNpm}"\n{\n  printf 'argv=%s\\n' "$*"\n  printf 'has_metaso=%s\\n' "\${METASO_SEARCH_API_KEY+yes}"\n  printf 'has_providers=%s\\n' "\${DEEPFIELD_SEARCH_PROVIDERS+yes}"\n} > "${sandbox.assertion}"\nexit 0\n`,
  );
  chmodSync(join(sandbox.bin, "security"), 0o755);
  chmodSync(join(sandbox.bin, "npm"), 0o755);
}

function runLauncher(sandbox: Sandbox, args: string[]) {
  const env: Record<string, string> = {
    PATH: `${sandbox.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  const result = spawnSync("zsh", [SCRIPT, ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("run-search-live-from-keychain launcher (focused revision)", () => {
  let sandbox: Sandbox;
  afterEach(() => {
    if (sandbox !== undefined) {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  it("runs the metaso-shape mode: child gets the secret env and the exact npm argv", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, FAKE_SECRET);
    const { status, stdout, stderr } = runLauncher(sandbox, ["metaso-shape"]);
    expect(existsSync(sandbox.markerNpm)).toBe(true);
    expect(existsSync(sandbox.markerSecurity)).toBe(true);
    expect(status).toBe(0);
    const assertion = readFileSync(sandbox.assertion, "utf8");
    expect(assertion).toContain("argv=run test:metaso-shape:live");
    expect(assertion).toContain("has_metaso=yes");
    expect(assertion).toContain("has_providers=yes");
    // stdout/stderr/assertion never carry the secret value
    expect(stdout).not.toContain(FAKE_SECRET);
    expect(stderr).not.toContain(FAKE_SECRET);
    expect(assertion).not.toContain(FAKE_SECRET);
  });

  it("rejects a missing, unknown or extra mode before invoking security or npm", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, FAKE_SECRET);
    for (const args of [[], ["other-mode"], ["metaso-shape", "extra"]]) {
      const { status, stdout, stderr } = runLauncher(sandbox, args);
      expect(status).not.toBe(0);
      expect(existsSync(sandbox.markerNpm)).toBe(false);
      expect(existsSync(sandbox.markerSecurity)).toBe(false);
      expect(existsSync(sandbox.assertion)).toBe(false);
      expect(stdout).not.toContain(FAKE_SECRET);
      expect(stderr).not.toContain(FAKE_SECRET);
    }
  });

  it("rejects an empty or whitespace-only secret without leaking it", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, "   ");
    const { status, stdout, stderr } = runLauncher(sandbox, ["metaso-shape"]);
    expect(status).not.toBe(0);
    expect(existsSync(sandbox.markerNpm)).toBe(false);
    expect(stdout).not.toContain(FAKE_SECRET);
    expect(stderr).not.toContain(FAKE_SECRET);
  });
});
