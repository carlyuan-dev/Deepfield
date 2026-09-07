import { describe, expect, it } from "vitest";
import { BENCHMARK_CANDIDATES_V1 } from "./provider-catalog.js";
import {
  CONTRACT_SCOPE_ENV,
  OVERSEAS_CONTRACT_PROVIDERS,
  resolveContractScope,
} from "./provider-contract-scope.js";

function envWith(value: unknown): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  Object.defineProperty(env, CONTRACT_SCOPE_ENV, { value, enumerable: true, configurable: true, writable: true });
  return env;
}

describe("provider contract scope resolver (focused revision)", () => {
  it("returns the frozen full canonical set when the scope env is missing", () => {
    const full = resolveContractScope({});
    expect(Object.isFrozen(full)).toBe(true);
    expect([...full]).toEqual([...BENCHMARK_CANDIDATES_V1]);
    // own property with undefined value behaves like missing
    const undefinedValue = resolveContractScope(envWith(undefined));
    expect([...undefinedValue]).toEqual([...BENCHMARK_CANDIDATES_V1]);
  });

  it("returns the frozen fixed overseas pair only for the exact own value 'overseas'", () => {
    const overseas = resolveContractScope(envWith("overseas"));
    expect(Object.isFrozen(overseas)).toBe(true);
    expect([...overseas]).toEqual(["tavily", "serper"]);
    expect(OVERSEAS_CONTRACT_PROVIDERS).toEqual(["tavily", "serper"]);
  });

  it("rejects blank, unknown and non-exact values with a fixed sanitized error", () => {
    for (const value of ["", "   ", "tavily", "overseas,tavily", "all", "evil", " overseas", "overseas "]) {
      try {
        resolveContractScope(envWith(value));
        throw new Error("unreachable");
      } catch (error) {
        expect(String(error)).toMatch(/invalid provider contract scope/);
        expect(String(error)).not.toContain("tavily");
        expect(String(error)).not.toContain("overseas");
        expect(String(error)).not.toContain("evil");
      }
    }
  });

  it("rejects inherited scope values and never runs an accessor getter", () => {
    // inherited property on the prototype chain counts as present-but-invalid
    const inherited = Object.create({ [CONTRACT_SCOPE_ENV]: "overseas" });
    expect(() => resolveContractScope(inherited as Record<string, string | undefined>)).toThrow(/invalid provider contract scope/);

    // own accessor: rejected WITHOUT running the getter
    const accessor: Record<string, string | undefined> = {};
    Object.defineProperty(accessor, CONTRACT_SCOPE_ENV, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-scope-accessor-secret");
      },
    });
    try {
      resolveContractScope(accessor);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/invalid provider contract scope/);
      expect(String(error)).not.toContain("sk-scope-accessor-secret");
    }
  });

  it("does not modify the input and its overseas targets are canonical members", () => {
    const input = envWith("overseas");
    Object.freeze(input);
    const overseas = resolveContractScope(input);
    expect(Object.prototype.hasOwnProperty.call(input, CONTRACT_SCOPE_ENV)).toBe(true);
    expect([...overseas]).toEqual(["tavily", "serper"]);
    const canonical = new Set(BENCHMARK_CANDIDATES_V1);
    for (const id of overseas) {
      expect(canonical.has(id)).toBe(true);
    }
  });
});
