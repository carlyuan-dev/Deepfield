import { describe, expect, it } from "vitest";
import { resolveLiveProviders, requireLiveKeys, resolveLiveRun, bindLiveProbe } from "./live-config.js";
import { BENCHMARK_CANDIDATES_V1, LIVE_PROVIDER_ENV_KEYS, type LiveProviderId } from "./provider-catalog.js";

const FIVE = [...BENCHMARK_CANDIDATES_V1];

describe("live provider selection (focused revision)", () => {
  it("requires an explicit DEEPFIELD_SEARCH_PROVIDERS value", () => {
    expect(() => resolveLiveProviders(undefined)).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("")).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("   ")).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
  });

  it("returns the canonical frozen candidate order regardless of input order", () => {
    expect(resolveLiveProviders("serper,baidu,tavily,metaso,zhipu")).toEqual(FIVE);
    expect(resolveLiveProviders("zhipu,metaso,tavily,serper,baidu")).toEqual(FIVE);
    expect(resolveLiveProviders(FIVE.join(","))).toEqual(FIVE);
  });

  it("rejects single, unknown, duplicate, missing and Brave-containing sets", () => {
    expect(() => resolveLiveProviders("baidu")).toThrow(/five|candidate|DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("brave,tavily,serper,baidu,zhipu")).toThrow(/brave|unknown|exactly/i);
    expect(() => resolveLiveProviders("brave,baidu,zhipu,metaso,tavily,serper")).toThrow(/brave|unknown|exactly/i);
    expect(() => resolveLiveProviders("evil,baidu,zhipu,metaso,tavily,serper")).toThrow(/unknown/i);
    expect(() => resolveLiveProviders("baidu,zhipu,metaso,tavily")).toThrow(/missing|exactly|candidate/i); // missing serper
    expect(() => resolveLiveProviders("baidu,zhipu,metaso,tavily,serper,serper")).toThrow(/duplicate/i);
    expect(() => resolveLiveProviders("baidu,,zhipu,metaso,tavily,serper")).toThrow(/empty/i);
    expect(() => resolveLiveProviders("brave")).toThrow();
  });

  it("requires all five keys, rejecting blank/whitespace-only values without echoing values", () => {
    const fullEnv: Record<string, string> = {
      BAIDU_SEARCH_API_KEY: "k-baidu",
      ZHIPU_SEARCH_API_KEY: "k-zhipu",
      METASO_SEARCH_API_KEY: "k-metaso",
      TAVILY_API_KEY: "k-tavily",
      SERPER_API_KEY: "k-serper",
    };
    expect(Object.keys(requireLiveKeys(FIVE, fullEnv)).sort()).toEqual([...FIVE].sort());

    const missing = { ...fullEnv };
    delete missing.TAVILY_API_KEY;
    expect(() => requireLiveKeys(FIVE, missing)).toThrow(/TAVILY_API_KEY/);

    const blank = { ...fullEnv, SERPER_API_KEY: "   " };
    try {
      requireLiveKeys(FIVE, blank);
      throw new Error("unreachable");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("SERPER_API_KEY");
      expect(message).not.toContain("k-"); // never echoes available key values
    }
  });

  it("resolveLiveRun keeps its signature and uses the single catalog", () => {
    const env: Record<string, string> = {
      DEEPFIELD_SEARCH_PROVIDERS: FIVE.join(","),
      BAIDU_SEARCH_API_KEY: "k1",
      ZHIPU_SEARCH_API_KEY: "k2",
      METASO_SEARCH_API_KEY: "k3",
      TAVILY_API_KEY: "k4",
      SERPER_API_KEY: "k5",
    };
    const run = resolveLiveRun(env);
    expect(run.providers).toEqual(FIVE);
    expect(Object.keys(run.tokens).sort()).toEqual([...FIVE].sort());
    expect(() => resolveLiveRun({ ...env, DEEPFIELD_SEARCH_PROVIDERS: "brave" })).toThrow();
    expect(() => resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: FIVE.join(",") })).toThrow(/API_KEY/);
  });

  it("requires the providers set to EXACTLY equal the five candidates BEFORE reading any env value", () => {
    const fullEnv: Record<string, string> = {
      BAIDU_SEARCH_API_KEY: "k1",
      ZHIPU_SEARCH_API_KEY: "k2",
      METASO_SEARCH_API_KEY: "k3",
      TAVILY_API_KEY: "k4",
      SERPER_API_KEY: "k5",
    };
    // subset: even with every key present, a one-provider request fails
    expect(() => requireLiveKeys(["baidu"], fullEnv)).toThrow(/five v1 candidates/i);
    // duplicate ids fail
    expect(() => requireLiveKeys(["baidu", "baidu", "zhipu", "metaso", "tavily"], fullEnv)).toThrow(/five v1 candidates/i);
    // a missing candidate fails (length ok, set differs)
    expect(() => requireLiveKeys(["baidu", "zhipu", "metaso", "tavily", "serper", "serper"], fullEnv)).toThrow(/five v1 candidates/i);
    // a runtime unknown id fails
    expect(() => requireLiveKeys(["evil", "zhipu", "metaso", "tavily", "serper"] as unknown as typeof FIVE, fullEnv)).toThrow(/five v1 candidates/i);
    // a different order with the same set is accepted
    expect(Object.keys(requireLiveKeys(["tavily", "serper", "metaso", "zhipu", "baidu"], fullEnv)).sort()).toEqual([...FIVE].sort());
    // set failures are fixed sanitized errors: no echoed ids or env values
    for (const bad of [["baidu"], ["evil", "zhipu", "metaso", "tavily", "serper"]]) {
      try {
        requireLiveKeys(bad as typeof FIVE, fullEnv);
        throw new Error("unreachable");
      } catch (error) {
        const message = String(error);
        expect(message).toMatch(/five v1 candidates/i);
        expect(message).not.toContain("baidu");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("k1");
      }
    }
  });

  it("reads env keys ONLY as own data properties: accessor getters never run and inherited values are rejected", () => {
    // a root env key as an accessor whose getter would throw a secret
    const accessorEnv: Record<string, string> = {
      ZHIPU_SEARCH_API_KEY: "k2",
      METASO_SEARCH_API_KEY: "k3",
      TAVILY_API_KEY: "k4",
      SERPER_API_KEY: "k5",
    };
    Object.defineProperty(accessorEnv, "BAIDU_SEARCH_API_KEY", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-env-accessor-secret");
      },
    });
    try {
      requireLiveKeys(FIVE, accessorEnv);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toContain("BAIDU_SEARCH_API_KEY"); // treated as missing
      expect(String(error)).not.toContain("sk-env-accessor-secret"); // getter never ran
    }

    // an inherited env value must NOT be accepted
    const inheritedRoot = Object.create({ TAVILY_API_KEY: "k4" });
    const inheritedEnv = {
      BAIDU_SEARCH_API_KEY: "k1",
      ZHIPU_SEARCH_API_KEY: "k2",
      METASO_SEARCH_API_KEY: "k3",
      SERPER_API_KEY: "k5",
    };
    expect(() => requireLiveKeys(FIVE, { ...inheritedRoot, ...inheritedEnv } as Record<string, string>)).toThrow(/TAVILY_API_KEY/);
  });

  it("returns a frozen null-prototype token record from requireLiveKeys and resolveLiveRun", () => {
    const fullEnv: Record<string, string> = {
      BAIDU_SEARCH_API_KEY: "k1",
      ZHIPU_SEARCH_API_KEY: "k2",
      METASO_SEARCH_API_KEY: "k3",
      TAVILY_API_KEY: "k4",
      SERPER_API_KEY: "k5",
    };
    const tokens = requireLiveKeys(FIVE, fullEnv);
    expect(Object.getPrototypeOf(tokens)).toBe(null);
    expect(Object.isFrozen(tokens)).toBe(true);
    const run = resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: FIVE.join(","), ...fullEnv });
    expect(Object.getPrototypeOf(run.tokens)).toBe(null);
    expect(Object.isFrozen(run.tokens)).toBe(true);
  });

  it("bindLiveProbe binds every candidate to env-sourced tokens (never placeholders)", () => {
    const fullEnv: Record<string, string> = {
      BAIDU_SEARCH_API_KEY: "k1",
      ZHIPU_SEARCH_API_KEY: "k2",
      METASO_SEARCH_API_KEY: "k3",
      TAVILY_API_KEY: "k4",
      SERPER_API_KEY: "k5",
    };
    const assembly: Record<LiveProviderId, (client: string) => string> = {
      baidu: () => "baidu-binding",
      zhipu: () => "zhipu-binding",
      metaso: () => "metaso-binding",
      tavily: () => "tavily-binding",
      serper: () => "serper-binding",
    };
    const probes = bindLiveProbe(assembly, { DEEPFIELD_SEARCH_PROVIDERS: FIVE.join(","), ...fullEnv });
    expect(probes.map((probe) => probe.id)).toEqual(FIVE);
    for (const probe of probes) {
      // the token always comes from the env value, never from a literal
      expect(probe.token).toBe(fullEnv[LIVE_PROVIDER_ENV_KEYS[probe.id]]);
      expect(probe.binding).toBe(assembly[probe.id]);
    }
    // a missing key fails loudly through the same path
    expect(() =>
      bindLiveProbe(assembly, { DEEPFIELD_SEARCH_PROVIDERS: FIVE.join(","), ...fullEnv, TAVILY_API_KEY: "   " }),
    ).toThrow(/TAVILY_API_KEY/);
  });
});
