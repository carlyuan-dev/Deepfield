import { describe, expect, it } from "vitest";
import {
  BENCHMARK_CANDIDATES_V1,
  KEYCHAIN_SERVICES,
  LIVE_PROVIDER_ENV_KEYS,
  SUPPORTED_PROVIDER_IDS,
  requireBenchmarkCandidateAssembly,
  type LiveProviderId,
  type SupportedProviderId,
} from "./provider-catalog.js";

const ASSEMBLED: Partial<Record<SupportedProviderId, { probe: boolean }>> = {
  brave: { probe: true }, // supported but NOT a v1 candidate
  baidu: { probe: true },
  metaso: { probe: true },
  tavily: { probe: true },
  serper: { probe: true },
};

describe("provider catalog (focused revision)", () => {
  it("freezes the exact supported ids (incl. brave) and the exact v1 candidates", () => {
    expect(SUPPORTED_PROVIDER_IDS).toEqual(["brave", "tavily", "serper", "baidu", "metaso"]);
    expect(SUPPORTED_PROVIDER_IDS).toContain("brave");
    expect(Object.isFrozen(SUPPORTED_PROVIDER_IDS)).toBe(true);
    expect(BENCHMARK_CANDIDATES_V1).toEqual(["baidu", "metaso", "tavily", "serper"]);
    expect(BENCHMARK_CANDIDATES_V1).not.toContain("brave");
    expect(Object.isFrozen(BENCHMARK_CANDIDATES_V1)).toBe(true);
  });

  it("maps each candidate to its approved env key and keychain service, deeply frozen and primitive", () => {
    expect(LIVE_PROVIDER_ENV_KEYS).toEqual({
      baidu: "BAIDU_SEARCH_API_KEY",
      metaso: "METASO_SEARCH_API_KEY",
      tavily: "TAVILY_API_KEY",
      serper: "SERPER_API_KEY",
    });
    expect(KEYCHAIN_SERVICES).toEqual({
      baidu: "com.deepfield.benchmark.baidu",
      metaso: "com.deepfield.benchmark.metaso",
      tavily: "com.deepfield.benchmark.tavily",
      serper: "com.deepfield.benchmark.serper",
    });
    expect(Object.isFrozen(LIVE_PROVIDER_ENV_KEYS)).toBe(true);
    expect(Object.isFrozen(KEYCHAIN_SERVICES)).toBe(true);
    for (const value of Object.values(LIVE_PROVIDER_ENV_KEYS)) {
      expect(typeof value).toBe("string");
    }
    for (const value of Object.values(KEYCHAIN_SERVICES)) {
      expect(typeof value).toBe("string");
    }
  });

  it("requireBenchmarkCandidateAssembly copies only the four candidates into a frozen record", () => {
    const result = requireBenchmarkCandidateAssembly("test-catalog", ASSEMBLED);
    expect(result).toEqual({
      baidu: { probe: true },
      metaso: { probe: true },
      tavily: { probe: true },
      serper: { probe: true },
    });
    expect(Object.prototype.hasOwnProperty.call(result, "brave")).toBe(false); // brave allowed in input but omitted
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(Object.isFrozen(result)).toBe(true);
    // the input object (incl. brave) is untouched: only the four ids are copied
    expect(Object.keys(ASSEMBLED).sort()).toEqual(["baidu", "brave", "metaso", "serper", "tavily"]);
    expect(Object.keys(result).sort()).toEqual(["baidu", "metaso", "serper", "tavily"]);
  });

  it("requireBenchmarkCandidateAssembly fails closed with the stable incomplete message", () => {
    const legacy: Partial<Record<SupportedProviderId, unknown>> = {
      brave: { legacy: true },
      tavily: { legacy: true },
      serper: { legacy: true },
    };
    try {
      requireBenchmarkCandidateAssembly("provider-contract", legacy);
      throw new Error("unreachable");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("P2-T8A Phase 2 provider-contract assembly is incomplete: baidu,metaso");
    }
    // never echoes entry values
    try {
      requireBenchmarkCandidateAssembly("secret-label", { ...legacy, baidu: { apiKey: "sk-assembly-secret" } });
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).not.toContain("sk-assembly-secret");
      expect(String(error)).not.toContain("legacy");
    }
    // undefined entry counts as missing
    expect(() =>
      requireBenchmarkCandidateAssembly("test", { baidu: undefined, metaso: { x: 1 }, tavily: { x: 1 }, serper: { x: 1 } }),
    ).toThrow(/incomplete: baidu/);
  });

  it("requireBenchmarkCandidateAssembly never runs accessor entries", () => {
    const accessorMap: Partial<Record<SupportedProviderId, unknown>> = {
      metaso: { x: 1 },
      tavily: { x: 1 },
      serper: { x: 1 },
    };
    Object.defineProperty(accessorMap, "baidu", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-assembly-accessor");
      },
    });
    try {
      requireBenchmarkCandidateAssembly("test", accessorMap as Partial<Record<SupportedProviderId, unknown>>);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/incomplete: baidu/); // treated as absent; getter never ran
      expect(String(error)).not.toContain("sk-assembly-accessor");
    }
  });
});

describe("catalog type derivations", () => {
  it("keeps the type level narrow", () => {
    // only compile-time probes: every candidate id is assignable to both type aliases
    const allCandidates: LiveProviderId[] = [...BENCHMARK_CANDIDATES_V1];
    expect(allCandidates.length).toBe(4);
    const supported: SupportedProviderId[] = [...SUPPORTED_PROVIDER_IDS];
    expect(supported.length).toBe(5);
    // a candidate value is a supported id (structural)
    const first: SupportedProviderId = BENCHMARK_CANDIDATES_V1[0];
    expect(first).toBe("baidu");
  });
});
