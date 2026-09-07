import { describe, expect, it } from "vitest";
import { resolveLiveProviders, requireLiveKeys, resolveLiveRun, bindLiveProbe } from "./live-config.js";
import { BENCHMARK_CANDIDATES_V1, LIVE_PROVIDER_ENV_KEYS, type LiveProviderId } from "./provider-catalog.js";

const FOUR = [...BENCHMARK_CANDIDATES_V1];

function fullEnv(): Record<string, string> {
  return {
    BAIDU_SEARCH_API_KEY: "k-baidu",
    METASO_SEARCH_API_KEY: "k-metaso",
    TAVILY_API_KEY: "k-tavily",
    SERPER_API_KEY: "k-serper",
  };
}

describe("live provider selection (focused revision)", () => {
  it("requires an explicit DEEPFIELD_SEARCH_PROVIDERS value", () => {
    expect(() => resolveLiveProviders(undefined)).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("")).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("   ")).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
  });

  it("returns the canonical frozen candidate order regardless of input order", () => {
    expect(resolveLiveProviders("serper,tavily,metaso,baidu")).toEqual(FOUR);
    expect(resolveLiveProviders("tavily,serper,baidu,metaso")).toEqual(FOUR);
    expect(resolveLiveProviders(FOUR.join(","))).toEqual(FOUR);
  });

  it("rejects single, unknown, duplicate, missing and Brave-containing sets", () => {
    expect(() => resolveLiveProviders("baidu")).toThrow(/four|candidate|DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("brave,tavily,serper,baidu")).toThrow(/brave|unknown|exactly/i);
    expect(() => resolveLiveProviders("evil,baidu,metaso,tavily,serper")).toThrow(/unknown/i);
    expect(() => resolveLiveProviders("baidu,metaso,tavily")).toThrow(/missing|exactly|candidate/i); // missing serper
    expect(() => resolveLiveProviders("baidu,metaso,tavily,serper,serper")).toThrow(/duplicate/i);
    expect(() => resolveLiveProviders("baidu,,metaso,tavily,serper")).toThrow(/empty/i);
    expect(() => resolveLiveProviders("brave")).toThrow();
  });

  it("requires all four keys, rejecting blank/whitespace-only values without echoing values", () => {
    const env = fullEnv();
    expect(Object.keys(requireLiveKeys(FOUR, env)).sort()).toEqual([...FOUR].sort());

    const missing = { ...env };
    delete missing.TAVILY_API_KEY;
    expect(() => requireLiveKeys(FOUR, missing)).toThrow(/TAVILY_API_KEY/);

    const blank = { ...env, SERPER_API_KEY: "   " };
    try {
      requireLiveKeys(FOUR, blank);
      throw new Error("unreachable");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("SERPER_API_KEY");
      expect(message).not.toContain("k-"); // never echoes available key values
    }
  });

  it("resolveLiveRun keeps its signature and uses the single catalog", () => {
    const env: Record<string, string> = {
      DEEPFIELD_SEARCH_PROVIDERS: FOUR.join(","),
      ...fullEnv(),
    };
    const run = resolveLiveRun(env);
    expect(run.providers).toEqual(FOUR);
    expect(Object.keys(run.tokens).sort()).toEqual([...FOUR].sort());
    expect(() => resolveLiveRun({ ...env, DEEPFIELD_SEARCH_PROVIDERS: "brave" })).toThrow();
    expect(() => resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: FOUR.join(",") })).toThrow(/API_KEY/);
  });

  it("requires the providers set to EXACTLY equal the four candidates BEFORE reading any env value", () => {
    const env = fullEnv();
    // subset: even with every key present, a one-provider request fails
    expect(() => requireLiveKeys(["baidu"], env)).toThrow(/four v1 candidates/i);
    // duplicate ids fail
    expect(() => requireLiveKeys(["baidu", "baidu", "metaso", "tavily"], env)).toThrow(/four v1 candidates/i);
    // a missing candidate fails (length ok, set differs)
    expect(() => requireLiveKeys(["baidu", "metaso", "tavily", "serper", "serper"], env)).toThrow(/four v1 candidates/i);
    // a runtime unknown id fails
    expect(() => requireLiveKeys(["evil", "metaso", "tavily", "serper"] as unknown as typeof FOUR, env)).toThrow(/four v1 candidates/i);
    // a different order with the same set is accepted
    expect(Object.keys(requireLiveKeys(["tavily", "serper", "metaso", "baidu"], env)).sort()).toEqual([...FOUR].sort());
    // set failures are fixed sanitized errors: no echoed ids or env values
    for (const bad of [["baidu"], ["evil", "metaso", "tavily", "serper"]]) {
      try {
        requireLiveKeys(bad as typeof FOUR, env);
        throw new Error("unreachable");
      } catch (error) {
        const message = String(error);
        expect(message).toMatch(/four v1 candidates/i);
        expect(message).not.toContain("baidu");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("k-baidu");
      }
    }
  });

  it("reads env keys ONLY as own data properties: accessor getters never run and inherited values are rejected", () => {
    const accessorEnv: Record<string, string> = {
      METASO_SEARCH_API_KEY: "k-metaso",
      TAVILY_API_KEY: "k-tavily",
      SERPER_API_KEY: "k-serper",
    };
    Object.defineProperty(accessorEnv, "BAIDU_SEARCH_API_KEY", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-env-accessor-secret");
      },
    });
    try {
      requireLiveKeys(FOUR, accessorEnv);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toContain("BAIDU_SEARCH_API_KEY"); // treated as missing
      expect(String(error)).not.toContain("sk-env-accessor-secret"); // getter never ran
    }

    // an inherited env value must NOT be accepted
    const inheritedRoot = Object.create({ TAVILY_API_KEY: "k-tavily" });
    const inheritedEnv = {
      BAIDU_SEARCH_API_KEY: "k-baidu",
      METASO_SEARCH_API_KEY: "k-metaso",
      SERPER_API_KEY: "k-serper",
    };
    expect(() => requireLiveKeys(FOUR, { ...inheritedRoot, ...inheritedEnv } as Record<string, string>)).toThrow(/TAVILY_API_KEY/);
  });

  it("returns a frozen null-prototype token record from requireLiveKeys and resolveLiveRun", () => {
    const tokens = requireLiveKeys(FOUR, fullEnv());
    expect(Object.getPrototypeOf(tokens)).toBe(null);
    expect(Object.isFrozen(tokens)).toBe(true);
    const run = resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: FOUR.join(","), ...fullEnv() });
    expect(Object.getPrototypeOf(run.tokens)).toBe(null);
    expect(Object.isFrozen(run.tokens)).toBe(true);
  });

  it("bindLiveProbe binds every candidate to env-sourced tokens (never placeholders)", () => {
    const assembly: Record<LiveProviderId, (client: string) => string> = {
      baidu: () => "baidu-binding",
      metaso: () => "metaso-binding",
      tavily: () => "tavily-binding",
      serper: () => "serper-binding",
    };
    const probes = bindLiveProbe(assembly, { DEEPFIELD_SEARCH_PROVIDERS: FOUR.join(","), ...fullEnv() });
    expect(probes.map((probe) => probe.id)).toEqual(FOUR);
    for (const probe of probes) {
      // the token always comes from the env value, never from a literal
      expect(probe.token).toBe(fullEnv()[LIVE_PROVIDER_ENV_KEYS[probe.id]]);
      expect(probe.binding).toBe(assembly[probe.id]);
    }
    // a missing key fails loudly through the same path
    expect(() =>
      bindLiveProbe(assembly, { DEEPFIELD_SEARCH_PROVIDERS: FOUR.join(","), ...fullEnv(), TAVILY_API_KEY: "   " }),
    ).toThrow(/TAVILY_API_KEY/);
  });
});
