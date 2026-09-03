import { describe, expect, it } from "vitest";
import { resolveLiveProviders, requireLiveKeys, resolveLiveRun } from "./live-config.js";
import { BENCHMARK_CANDIDATES_V1 } from "./provider-catalog.js";

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
});
