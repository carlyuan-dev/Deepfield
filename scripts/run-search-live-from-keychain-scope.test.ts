import { describe, expect, it, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  makeSandbox,
  writeFakes,
  runLauncher,
  expectMarkerPass,
  cleanSandbox,
  securityCallCount,
  expectNoValueLeak,
  fiveValues,
  chainValues,
  PROVIDERS,
  ENV_NAMES,
  type Sandbox,
  type FakeOptions,
  type SecurityBehavior,
} from "./run-search-live-from-keychain-test-helpers.js";

const PRICING_RAW = '{"key":"synthetic"}';
const FORBIDDEN_VALUES = [...chainValues(), PRICING_RAW];

function baseOptions(scope: { value: string } | { unset: true }): FakeOptions {
  return {
    expectedServices: [...PROVIDERS],
    behaviors: Object.fromEntries(PROVIDERS.map((provider) => [provider, "value" as SecurityBehavior])),
    values: fiveValues(),
    verifyEnv: PROVIDERS.map((provider) => ENV_NAMES[provider]),
    npmArgv: ["run", "test:providers:live"],
    expectedPricing: PRICING_RAW,
    expectedScope: scope,
  };
}

function marker(sandbox: Sandbox, name: string): string {
  return join(sandbox.assertionDir, name);
}

describe("provider-contract-overseas launcher scope (focused revision)", () => {
  let sandbox: Sandbox;
  afterEach(() => {
    if (sandbox !== undefined) {
      cleanSandbox(sandbox);
    }
  });

  it("runs the shared live suite with the fixed overseas scope and full five-key validation", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, baseOptions({ value: "overseas" }));
    const { status, stdout, stderr } = runLauncher(sandbox, ["provider-contract-overseas"], { DEEPFIELD_SEARCH_PRICING: PRICING_RAW });
    expect(status).toBe(0);
    expect(securityCallCount(sandbox)).toBe(5);
    for (let index = 1; index <= 5; index += 1) {
      expectMarkerPass(marker(sandbox, `security-argv-${index}`));
    }
    for (const envName of PROVIDERS.map((provider) => ENV_NAMES[provider])) {
      expectMarkerPass(marker(sandbox, `ok-${envName}`));
    }
    expectMarkerPass(marker(sandbox, "ok-providers"));
    expectMarkerPass(marker(sandbox, "ok-pricing"));
    expectMarkerPass(marker(sandbox, "ok-scope")); // child sees scope=overseas
    expectMarkerPass(marker(sandbox, "ok-argv"));
    expectNoValueLeak(sandbox, { stdout, stderr }, FORBIDDEN_VALUES);
  });

  it("cannot be overridden by a caller-injected scope value", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, baseOptions({ value: "overseas" }));
    const { status } = runLauncher(sandbox, ["provider-contract-overseas"], {
      DEEPFIELD_SEARCH_PRICING: PRICING_RAW,
      DEEPFIELD_SEARCH_CONTRACT_SCOPE: "evil", // caller attempt
    });
    expect(status).toBe(0);
    expectMarkerPass(marker(sandbox, "ok-scope")); // launcher fixed scope wins
  });

  it("requires the pricing gate and exactly one allowlisted argument", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, baseOptions({ value: "overseas" }));
    // missing/blank pricing -> fail before security
    for (const pricing of [{}, { DEEPFIELD_SEARCH_PRICING: "   " }]) {
      const { status } = runLauncher(sandbox, ["provider-contract-overseas"], pricing);
      expect(status).not.toBe(0);
      expect(securityCallCount(sandbox)).toBe(0);
      expect(existsSync(marker(sandbox, "npm-invoked"))).toBe(false);
    }
    // unknown / extra argument -> fail before security
    for (const args of [[], ["provider-contract-overseas", "extra"], ["provider-contract-overseas2"]]) {
      const { status } = runLauncher(sandbox, args, { DEEPFIELD_SEARCH_PRICING: PRICING_RAW });
      expect(status).not.toBe(0);
      expect(securityCallCount(sandbox)).toBe(0);
    }
  });

  it("fails closed on any keychain read failure without starting npm", () => {
    sandbox = makeSandbox();
    for (let position = 0; position < PROVIDERS.length; position += 1) {
      cleanSandbox(sandbox);
      sandbox = makeSandbox();
      const options = baseOptions({ value: "overseas" });
      options.behaviors = Object.fromEntries(PROVIDERS.map((provider, index) => [provider, (index === position ? "fail" : "value") as SecurityBehavior]));
      writeFakes(sandbox, options);
      const { status, stdout, stderr } = runLauncher(sandbox, ["provider-contract-overseas"], { DEEPFIELD_SEARCH_PRICING: PRICING_RAW });
      expect(status).not.toBe(0);
      expect(securityCallCount(sandbox)).toBe(position + 1);
      expect(existsSync(marker(sandbox, "npm-invoked"))).toBe(false);
      expectNoValueLeak(sandbox, { stdout, stderr }, FORBIDDEN_VALUES);
    }
  }, 30_000); // five sequential zsh spawns: never fit the 5s default
});

describe("regular provider-contract scope hygiene (focused revision)", () => {
  let sandbox: Sandbox;
  afterEach(() => {
    if (sandbox !== undefined) {
      cleanSandbox(sandbox);
    }
  });

  it("clears any caller-injected scope so the full five-provider suite cannot be downgraded", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, baseOptions({ unset: true }));
    const { status, stdout, stderr } = runLauncher(sandbox, ["provider-contract"], {
      DEEPFIELD_SEARCH_PRICING: PRICING_RAW,
      DEEPFIELD_SEARCH_CONTRACT_SCOPE: "overseas", // hostile injection must be cleared
    });
    expect(status).toBe(0);
    expectMarkerPass(marker(sandbox, "ok-scope")); // child env has NO scope
    expectMarkerPass(marker(sandbox, "ok-argv"));
    expect(securityCallCount(sandbox)).toBe(5);
    expectNoValueLeak(sandbox, { stdout, stderr }, FORBIDDEN_VALUES);
  });

  it("also clears an injected scope for the search-benchmark mode", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, { ...baseOptions({ unset: true }), npmArgv: ["run", "benchmark:search"] });
    const { status } = runLauncher(sandbox, ["search-benchmark"], {
      DEEPFIELD_SEARCH_PRICING: PRICING_RAW,
      DEEPFIELD_SEARCH_CONTRACT_SCOPE: "overseas",
    });
    expect(status).toBe(0);
    expectMarkerPass(marker(sandbox, "ok-scope"));
    expectMarkerPass(marker(sandbox, "ok-argv"));
  });
});
