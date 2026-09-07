import { describe, expect, it, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  makeSandbox,
  writeFakes,
  runLauncher,
  expectMarkerPass,
  markerContent,
  cleanSandbox,
  securityCallCount,
  expectNoValueLeak,
  candidateValues,
  chainValues,
  PROVIDERS,
  ENV_NAMES,
  type Sandbox,
  type FakeOptions,
  type SecurityBehavior,
} from "./run-search-live-from-keychain-test-helpers.js";

const MODES: ReadonlyArray<{ mode: string; npmArgv: string[] }> = [
  { mode: "provider-contract", npmArgv: ["run", "test:providers:live"] },
  { mode: "search-benchmark", npmArgv: ["run", "benchmark:search"] },
];

const PRICING_RAW = '{"key":"synthetic"}';
const FORBIDDEN_VALUES = [...chainValues(), PRICING_RAW];

function allBehaviors(value: string): Record<string, string> {
  const behaviors: Record<string, string> = {};
  for (const provider of PROVIDERS) {
    behaviors[provider] = value;
  }
  return behaviors;
}

function marker(sandbox: Sandbox, name: string): string {
  return join(sandbox.assertionDir, name);
}

function optionsFor(mode: { mode: string; npmArgv: string[] }): FakeOptions {
  return {
    expectedServices: [...PROVIDERS],
    behaviors: allBehaviors("value"),
    values: candidateValues(),
    verifyEnv: PROVIDERS.map((provider) => ENV_NAMES[provider]),
    npmArgv: mode.npmArgv,
    expectedPricing: PRICING_RAW,
  };
}

function runPricingGate(sandbox: Sandbox, mode: string, pricingEnv: Record<string, string>) {
  return runLauncher(sandbox, [mode], pricingEnv);
}

describe("run-search-live-from-keychain launcher modes (focused revision)", () => {
  let sandbox: Sandbox;
  afterEach(() => {
    if (sandbox !== undefined) {
      cleanSandbox(sandbox);
    }
  });

  for (const mode of MODES) {
    it(`${mode.mode}: retrieves all four services in exact order once and exports exact child env`, () => {
      sandbox = makeSandbox();
      writeFakes(sandbox, optionsFor(mode));
      const { status, stdout, stderr } = runLauncher(sandbox, [mode.mode], { DEEPFIELD_SEARCH_PRICING: PRICING_RAW });
      expect(status).toBe(0);
      expect(securityCallCount(sandbox)).toBe(4);
      for (let index = 1; index <= 4; index += 1) {
        expectMarkerPass(marker(sandbox, `security-argv-${index}`));
      }
      for (const envName of PROVIDERS.map((provider) => ENV_NAMES[provider])) {
        expectMarkerPass(marker(sandbox, `ok-${envName}`));
      }
      expectMarkerPass(marker(sandbox, "ok-providers"));
      expectMarkerPass(marker(sandbox, "ok-pricing"));
      expectMarkerPass(marker(sandbox, "ok-argv"));
      expectNoValueLeak(sandbox, { stdout, stderr }, FORBIDDEN_VALUES);
    });
  }

  it("rejects missing or blank DEEPFIELD_SEARCH_PRICING before the first security call", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, optionsFor(MODES[0]!));
    for (const mode of MODES) {
      for (const pricing of [{}, { DEEPFIELD_SEARCH_PRICING: "   " }]) {
        const { status, stdout, stderr } = runPricingGate(sandbox, mode.mode, pricing);
        expect(status).not.toBe(0);
        expect(securityCallCount(sandbox)).toBe(0);
        expect(existsSync(marker(sandbox, "npm-invoked"))).toBe(false);
        expectNoValueLeak(sandbox, { stdout, stderr }, FORBIDDEN_VALUES);
      }
    }
  });

  for (const mode of MODES) {
    for (const failure of ["fail", "empty", "whitespace"] as const) {
      it(`${mode.mode}: stops at the first ${failure} service without npm or later reads`, () => {
        sandbox = makeSandbox();
        for (let position = 0; position < PROVIDERS.length; position += 1) {
          cleanSandbox(sandbox);
          sandbox = makeSandbox();
          const behaviors = allBehaviors("value") as Record<string, SecurityBehavior>;
          behaviors[PROVIDERS[position]!] = failure;
          writeFakes(sandbox, { ...optionsFor(mode), behaviors });
          const { status, stdout, stderr } = runLauncher(sandbox, [mode.mode], { DEEPFIELD_SEARCH_PRICING: PRICING_RAW });
          expect(status).not.toBe(0);
          // only services up to and including the failing one were queried
          expect(securityCallCount(sandbox)).toBe(position + 1);
          expect(existsSync(marker(sandbox, "npm-invoked"))).toBe(false);
          expect(markerContent(marker(sandbox, "ok-providers"))).toBe("<missing>");
          expectNoValueLeak(sandbox, { stdout, stderr }, FORBIDDEN_VALUES);
        }
      }, 30_000); // four sequential zsh spawns per case: never fit the 5s default
    }
  }
});
