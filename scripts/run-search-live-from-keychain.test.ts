import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "run-search-live-from-keychain.zsh");
const FAKE_SECRET = "sk-fake-metaso";
const EXPECTED_PROVIDERS = "baidu,zhipu,metaso,tavily,serper";

interface Sandbox {
  dir: string;
  bin: string;
  markerInvokedSecurity: string;
  markerInvokedNpm: string;
  markerSecurityArgv: string;
  markerKey: string;
  markerProviders: string;
  markerArgv: string;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "df-keychain-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  return {
    dir,
    bin,
    markerInvokedSecurity: join(dir, "security-invoked"),
    markerInvokedNpm: join(dir, "npm-invoked"),
    markerSecurityArgv: join(dir, "security-argv"),
    markerKey: join(dir, "key-ok"),
    markerProviders: join(dir, "providers-ok"),
    markerArgv: join(dir, "argv-ok"),
  };
}

function writeFakes(sandbox: Sandbox): void {
  const { markerSecurityArgv, markerInvokedSecurity, markerInvokedNpm, markerKey, markerProviders, markerArgv } = sandbox;
  writeFileSync(
    join(sandbox.bin, "security"),
    `#!/bin/sh\n: > "${markerInvokedSecurity}"\nif [ "$#" -eq 6 ] && [ "$1" = "find-generic-password" ] && [ "$2" = "-a" ] && [ "$3" = "deepfield" ] && [ "$4" = "-s" ] && [ "$5" = "com.deepfield.benchmark.metaso" ] && [ "$6" = "-w" ]; then\n  printf pass > "${markerSecurityArgv}"\nelse\n  printf fail > "${markerSecurityArgv}"\nfi\nprintf '%s\\n' "\${FAKE_KEYCHAIN_VALUE-}"\n`,
  );
  writeFileSync(
    join(sandbox.bin, "npm"),
    `#!/bin/sh\n: > "${markerInvokedNpm}"\nif [ "\${METASO_SEARCH_API_KEY-}" = "\${EXPECTED_METASO_KEY-}" ]; then\n  printf pass > "${markerKey}"\nelse\n  printf fail > "${markerKey}"\nfi\nif [ "\${DEEPFIELD_SEARCH_PROVIDERS-}" = "\${EXPECTED_PROVIDERS-}" ]; then\n  printf pass > "${markerProviders}"\nelse\n  printf fail > "${markerProviders}"\nfi\nif [ "$#" -eq 2 ] && [ "$1" = "run" ] && [ "$2" = "test:metaso-shape:live" ]; then\n  printf pass > "${markerArgv}"\nelse\n  printf fail > "${markerArgv}"\nfi\nexit 0\n`,
  );
  chmodSync(join(sandbox.bin, "security"), 0o755);
  chmodSync(join(sandbox.bin, "npm"), 0o755);
}

function runLauncher(sandbox: Sandbox, args: string[], keychainValue = FAKE_SECRET) {
  const env: Record<string, string> = {
    PATH: `${sandbox.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    FAKE_KEYCHAIN_VALUE: keychainValue,
    EXPECTED_METASO_KEY: keychainValue,
    EXPECTED_PROVIDERS,
  };
  const result = spawnSync("zsh", [SCRIPT, ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function expectMarkerPass(marker: string): void {
  expect(readFileSync(marker, "utf8").trim()).toBe("pass");
}

describe("run-search-live-from-keychain launcher (focused revision)", () => {
  let sandbox: Sandbox;
  afterEach(() => {
    if (sandbox !== undefined) {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  it("proves exact security argv, exact child env values and exact npm argv via pass markers", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox);
    const { status, stdout, stderr } = runLauncher(sandbox, ["metaso-shape"]);
    expect(status).toBe(0);
    // fake security verified its exact argv; fake npm verified exact values+argv
    expectMarkerPass(sandbox.markerSecurityArgv);
    expectMarkerPass(sandbox.markerKey);
    expectMarkerPass(sandbox.markerProviders);
    expectMarkerPass(sandbox.markerArgv);
    // stdout/stderr never carry the secret value
    expect(stdout).not.toContain(FAKE_SECRET);
    expect(stderr).not.toContain(FAKE_SECRET);
    // no env value or secret was written into the pass/fail markers
    for (const marker of [sandbox.markerSecurityArgv, sandbox.markerKey, sandbox.markerProviders, sandbox.markerArgv]) {
      expect(readFileSync(marker, "utf8")).not.toContain(FAKE_SECRET);
    }
  });

  it("rejects a missing, unknown or extra mode before invoking security or npm", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox);
    for (const args of [[], ["other-mode"], ["metaso-shape", "extra"]]) {
      const { status, stdout, stderr } = runLauncher(sandbox, args);
      expect(status).not.toBe(0);
      expect(existsSync(sandbox.markerInvokedSecurity)).toBe(false);
      expect(existsSync(sandbox.markerInvokedNpm)).toBe(false);
      expect(existsSync(sandbox.markerKey)).toBe(false);
      expect(stdout).not.toContain(FAKE_SECRET);
      expect(stderr).not.toContain(FAKE_SECRET);
    }
  });

  it("rejects an empty or whitespace-only secret without invoking npm or leaking it", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox);
    const { status, stdout, stderr } = runLauncher(sandbox, ["metaso-shape"], "   ");
    expect(status).not.toBe(0);
    expect(existsSync(sandbox.markerInvokedNpm)).toBe(false);
    expect(existsSync(sandbox.markerKey)).toBe(false);
    expect(stdout).not.toContain(FAKE_SECRET);
    expect(stderr).not.toContain(FAKE_SECRET);
  });
});
