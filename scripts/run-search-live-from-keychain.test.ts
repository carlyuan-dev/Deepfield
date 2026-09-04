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
  ENV_NAMES,
  type Sandbox,
  type FakeOptions,
} from "./run-search-live-from-keychain-test-helpers.js";

const SHAPE_VALUE = "sk-metaso-shape-key";

function shapeOptions(): FakeOptions {
  return {
    expectedServices: ["metaso"],
    behaviors: { metaso: "value" },
    values: { metaso: SHAPE_VALUE, METASO_SEARCH_API_KEY: SHAPE_VALUE },
    verifyEnv: ["METASO_SEARCH_API_KEY"],
    npmArgv: ["run", "test:metaso-shape:live"],
  };
}

function marker(sandbox: Sandbox, name: string): string {
  return join(sandbox.assertionDir, name);
}

describe("run-search-live-from-keychain launcher (focused revision)", () => {
  let sandbox: Sandbox;
  afterEach(() => {
    if (sandbox !== undefined) {
      cleanSandbox(sandbox);
    }
  });

  it("metaso-shape keeps single-service retrieval and exact npm argv", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, shapeOptions());
    const { status, stdout, stderr } = runLauncher(sandbox, ["metaso-shape"]);
    expect(status).toBe(0);
    expect(securityCallCount(sandbox)).toBe(1);
    expectMarkerPass(marker(sandbox, "security-argv-1"));
    expectMarkerPass(marker(sandbox, "ok-METASO_SEARCH_API_KEY"));
    expectMarkerPass(marker(sandbox, "ok-providers"));
    expectMarkerPass(marker(sandbox, "ok-argv"));
    expectNoValueLeak(sandbox, { stdout, stderr }, [SHAPE_VALUE]);
    // only the MetaSo env key is exported in this mode
    for (const envName of Object.values(ENV_NAMES)) {
      if (envName !== "METASO_SEARCH_API_KEY") {
        expect(markerContent(marker(sandbox, `ok-${envName}`))).toBe("<missing>");
      }
    }
  });

  it("rejects missing, unknown and extra modes before any security or npm call", () => {
    sandbox = makeSandbox();
    writeFakes(sandbox, shapeOptions());
    for (const args of [[], ["unknown-mode"], ["metaso-shape", "extra"]]) {
      const { status, stdout, stderr } = runLauncher(sandbox, args);
      expect(status).not.toBe(0);
      expect(securityCallCount(sandbox)).toBe(0);
      expect(existsSync(marker(sandbox, "npm-invoked"))).toBe(false);
      expectNoValueLeak(sandbox, { stdout, stderr }, [SHAPE_VALUE]);
    }
  });

  it("rejects an empty or whitespace-only metaso secret without invoking npm", () => {
    sandbox = makeSandbox();
    for (const behavior of ["empty", "whitespace"] as const) {
      writeFakes(sandbox, { ...shapeOptions(), behaviors: { metaso: behavior } });
      const { status, stdout, stderr } = runLauncher(sandbox, ["metaso-shape"]);
      expect(status).not.toBe(0);
      expect(existsSync(marker(sandbox, "npm-invoked"))).toBe(false);
      expectNoValueLeak(sandbox, { stdout, stderr }, [SHAPE_VALUE]);
    }
  });
});
