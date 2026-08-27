import { describe, expect, it } from "vitest";
import { resolveLiveProviders, requireLiveKeys, resolveLiveRun, ALL_LIVE_PROVIDERS } from "./live-config.js";

describe("live provider selection (focused revision)", () => {
  it("requires an explicit DEEPFIELD_SEARCH_PROVIDERS value", () => {
    expect(() => resolveLiveProviders(undefined)).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("")).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
    expect(() => resolveLiveProviders("   ")).toThrow(/DEEPFIELD_SEARCH_PROVIDERS/);
  });

  it("requires at least two providers", () => {
    expect(() => resolveLiveProviders("brave")).toThrow(/at least two/);
    expect(() => resolveLiveProviders("tavily")).toThrow(/at least two/);
  });

  it("rejects unknown and duplicate providers", () => {
    expect(() => resolveLiveProviders("brave,evil")).toThrow(/unknown provider/i);
    expect(() => resolveLiveProviders("brave,tavily,serper,extra")).toThrow(/unknown provider/i);
    expect(() => resolveLiveProviders("brave,brave")).toThrow(/duplicate/i);
    expect(() => resolveLiveProviders("brave,tavily,tavily")).toThrow(/duplicate/i);
  });

  it("accepts exactly the whitelisted set with whitespace tolerance", () => {
    expect(resolveLiveProviders("brave, tavily")).toEqual(["brave", "tavily"]);
    expect(resolveLiveProviders("serper,brave,tavily")).toEqual(["serper", "brave", "tavily"]);
    expect(ALL_LIVE_PROVIDERS).toEqual(["brave", "tavily", "serper"]);
  });

  it("requires a key for every selected provider (fail closed before any I/O)", () => {
    expect(() => requireLiveKeys(["brave", "tavily"], { BRAVE_SEARCH_API_KEY: "k" })).toThrow(/TAVILY_API_KEY is required/);
    expect(() => requireLiveKeys(["brave", "tavily"], {})).toThrow(/BRAVE_SEARCH_API_KEY is required/);
    const tokens = requireLiveKeys(["brave", "tavily"], { BRAVE_SEARCH_API_KEY: "k1", TAVILY_API_KEY: "k2" });
    expect(tokens).toEqual({ brave: "k1", tavily: "k2" });
    // one-shot live run setup: selection + keys together
    const run = resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: "brave,tavily", BRAVE_SEARCH_API_KEY: "k1", TAVILY_API_KEY: "k2" });
    expect(run.providers).toEqual(["brave", "tavily"]);
    expect(run.tokens.tavily).toBe("k2");
    expect(() => resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: "brave,tavily", BRAVE_SEARCH_API_KEY: "k1" })).toThrow(/TAVILY_API_KEY is required/);
    expect(() => resolveLiveRun({ DEEPFIELD_SEARCH_PROVIDERS: "brave" })).toThrow(/at least two/);
  });
});
