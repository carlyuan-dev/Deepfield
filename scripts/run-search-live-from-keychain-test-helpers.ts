import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRIPT = join(import.meta.dirname, "run-search-live-from-keychain.zsh");
export const PROVIDERS = ["baidu", "zhipu", "metaso", "tavily", "serper"] as const;
export const EXPECTED_PROVIDERS = PROVIDERS.join(",");
export const ENV_NAMES: Readonly<Record<string, string>> = {
  baidu: "BAIDU_SEARCH_API_KEY",
  zhipu: "ZHIPU_SEARCH_API_KEY",
  metaso: "METASO_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
};
export const SERVICE_OF = (provider: string): string => `com.deepfield.benchmark.${provider}`;

/** Behavior of the fake `security` for one provider's service. */
export type SecurityBehavior = "value" | "fail" | "empty" | "whitespace";

export interface Sandbox {
  dir: string;
  bin: string;
  securityCounter: string;
  npmInvoked: string;
  assertionDir: string;
}

export interface FakeOptions {
  /** expected service order the launcher must call (argv markers keyed by call #). */
  expectedServices: readonly string[];
  /** per-provider fake keychain value / failure behavior. */
  behaviors: Readonly<Record<string, SecurityBehavior>>;
  values: Readonly<Record<string, string>>;
  /** env names the fake npm must verify equal to their expected value. */
  verifyEnv: readonly string[];
  /** expected npm argv (mode-specific). */
  npmArgv: readonly string[];
  /** when true, fake npm verifies DEEPFIELD_SEARCH_PRICING byte equality against this literal. */
  expectedPricing?: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "df-keychain-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  return {
    dir,
    bin,
    securityCounter: join(dir, "security-count"),
    npmInvoked: join(dir, "npm-invoked"),
    assertionDir: dir,
  };
}

export function writeFakes(sandbox: Sandbox, opts: FakeOptions): void {
  const behaviorLines = opts.expectedServices.map((provider) => {
    const service = SERVICE_OF(provider);
    const behavior = opts.behaviors[provider] ?? "value";
    const line =
      behavior === "fail"
        ? `  ${quote(service)}) exit 43 ;;`
        : behavior === "empty"
          ? `  ${quote(service)}) printf '' ;;`
          : behavior === "whitespace"
            ? `  ${quote(service)}) printf '%s\\n' '   ' ;;`
            : `  ${quote(service)}) printf '%s\\n' ${quote(opts.values[provider] ?? "")} ;;`;
    return line;
  });

  const expectedList = opts.expectedServices.join(" ");
  const securityScript = `#!/bin/sh
n=0
if [ -f "${sandbox.securityCounter}" ]; then
  n=$(cat "${sandbox.securityCounter}")
fi
n=$((n + 1))
printf '%s\\n' "$n" > "${sandbox.securityCounter}"
marker=${quote(join(sandbox.assertionDir, "security-argv"))}
if [ "$#" -eq 6 ] && [ "$1" = "find-generic-password" ] && [ "$2" = "-a" ] && [ "$3" = "deepfield" ] && [ "$4" = "-s" ] && [ "$6" = "-w" ]; then
  expected=$(printf '%s' ${quote(expectedList)} | cut -d' ' -f"$n")
  if [ "$5" = ${quote("com.deepfield.benchmark.")}"$expected" ]; then
    printf pass > "\${marker}-$n"
  else
    printf fail > "\${marker}-$n"
  fi
else
  printf fail > "\${marker}-$n"
fi
case "$5" in
${behaviorLines.join("\n")}
  *) exit 44 ;;
esac
`;
  writeFileSync(join(sandbox.bin, "security"), securityScript);

  const envChecks = opts.verifyEnv
    .map((envName) => {
      const expected = quote(opts.values[envName] ?? "");
      return `if [ "\${${envName}-}" = ${expected} ]; then\n  printf pass > "${sandbox.assertionDir}/ok-${envName}"\nelse\n  printf fail > "${sandbox.assertionDir}/ok-${envName}"\nfi`;
    })
    .join("\n");
  const argvCheck = `if [ "$#" -eq ${opts.npmArgv.length} ]${opts.npmArgv.map((arg, index) => ` && [ "$${index + 1}" = ${quote(arg)} ]`).join("")}; then
  printf pass > "${sandbox.assertionDir}/ok-argv"
else
  printf fail > "${sandbox.assertionDir}/ok-argv"
fi`;
  const pricingCheck = opts.expectedPricing !== undefined
    ? `if [ "\${DEEPFIELD_SEARCH_PRICING-}" = ${quote(opts.expectedPricing)} ]; then
  printf pass > "${sandbox.assertionDir}/ok-pricing"
else
  printf fail > "${sandbox.assertionDir}/ok-pricing"
fi`
    : "";
  const npmScript = `#!/bin/sh
: > "${sandbox.npmInvoked}"
${envChecks}
if [ "\${DEEPFIELD_SEARCH_PROVIDERS-}" = ${quote(EXPECTED_PROVIDERS)} ]; then
  printf pass > "${sandbox.assertionDir}/ok-providers"
else
  printf fail > "${sandbox.assertionDir}/ok-providers"
fi
${argvCheck}
${pricingCheck}
exit 0
`;
  writeFileSync(join(sandbox.bin, "npm"), npmScript);
  chmodSync(join(sandbox.bin, "security"), 0o755);
  chmodSync(join(sandbox.bin, "npm"), 0o755);
}

export function runLauncher(sandbox: Sandbox, args: readonly string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${sandbox.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    ...extraEnv,
  };
  const result = spawnSync("zsh", [SCRIPT, ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function expectMarkerPass(path: string): void {
  expect(readFileSync(path, "utf8").trim()).toBe("pass");
}

export function markerContent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
}

export function cleanSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.dir, { recursive: true, force: true });
}

/** Standard five-value keychain map for the five candidate services. */
export function fiveValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const provider of PROVIDERS) {
    values[provider] = `sk-${provider}-chain`;
  }
  return values;
}

export function securityCallCount(sandbox: Sandbox): number {
  if (!existsSync(sandbox.securityCounter)) {
    return 0;
  }
  return Number(readFileSync(sandbox.securityCounter, "utf8").trim() || "0");
}
