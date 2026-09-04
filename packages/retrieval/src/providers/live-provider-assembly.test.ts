import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderHttpClient, type ProviderTransport, type ProviderTransportResponse } from "../provider-http-client.js";
import { Readable } from "node:stream";
import {
  LIVE_PROVIDER_ENDPOINTS,
  LIVE_PROVIDER_FACTORIES,
  resolveLiveProviderSetup,
} from "./live-provider-assembly.js";
import { BENCHMARK_CANDIDATES_V1, type LiveProviderId } from "./provider-catalog.js";
import { createBaiduProvider, BAIDU_ENDPOINT } from "./baidu.js";
import { createZhipuProvider, ZHIPU_ENDPOINT } from "./zhipu.js";
import { createMetaSoProvider, METASO_ENDPOINT } from "./metaso.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "./tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "./serper.js";

const FIVE = [...BENCHMARK_CANDIDATES_V1];
const FIVE_STRING = FIVE.join(",");

function syntheticPricingJson(): string {
  const record = {
    amountPerRequest: 0.01,
    currency: "USD",
    usdPerCurrencyUnit: 1,
    priceSourceUrl: "https://example.com/pricing",
    priceObservedOn: "2026-09-01",
  };
  const baidu = {
    ...record,
    currency: "CNY",
    amountPerRequest: 0.036,
    usdPerCurrencyUnit: 0.14,
    exchangeRateSourceUrl: "https://example.com/fx",
    exchangeRateObservedOn: "2026-09-01",
  };
  return JSON.stringify({ baidu, zhipu: record, metaso: record, tavily: record, serper: record });
}

function fullEnv(pricing = syntheticPricingJson()): Record<string, string> {
  return {
    DEEPFIELD_SEARCH_PROVIDERS: FIVE_STRING,
    DEEPFIELD_SEARCH_PRICING: pricing,
    BAIDU_SEARCH_API_KEY: "k-baidu",
    ZHIPU_SEARCH_API_KEY: "k-zhipu",
    METASO_SEARCH_API_KEY: "k-metaso",
    TAVILY_API_KEY: "k-tavily",
    SERPER_API_KEY: "k-serper",
  };
}

describe("live provider assembly (focused revision)", () => {
  it("exposes exactly the five candidates in canonical order on frozen null-prototype maps", () => {
    for (const map of [LIVE_PROVIDER_ENDPOINTS, LIVE_PROVIDER_FACTORIES]) {
      expect(Object.keys(map)).toEqual(FIVE);
      expect(Object.getPrototypeOf(map)).toBe(null);
      expect(Object.isFrozen(map)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(map, "brave")).toBe(false);
    }
    for (const id of FIVE) {
      expect(LIVE_PROVIDER_ENDPOINTS[id]).toBeDefined();
      expect(LIVE_PROVIDER_FACTORIES[id]).toBeDefined();
    }
  });

  it("pins each candidate endpoint to its approved adapter endpoint", () => {
    expect(LIVE_PROVIDER_ENDPOINTS.baidu).toEqual(BAIDU_ENDPOINT);
    expect(LIVE_PROVIDER_ENDPOINTS.zhipu).toEqual(ZHIPU_ENDPOINT);
    expect(LIVE_PROVIDER_ENDPOINTS.metaso).toEqual(METASO_ENDPOINT);
    expect(LIVE_PROVIDER_ENDPOINTS.tavily).toEqual(TAVILY_ENDPOINT);
    expect(LIVE_PROVIDER_ENDPOINTS.serper).toEqual(SERPER_ENDPOINT);
  });

  it("builds every candidate provider with matching id and declared capabilities", () => {
    for (const id of FIVE) {
      const client = new ProviderHttpClient({ transport: transportStub(), endpoint: LIVE_PROVIDER_ENDPOINTS[id] });
      const provider = LIVE_PROVIDER_FACTORIES[id](client, "sk-synthetic");
      expect(provider.id).toBe(id);
      const expectsRange = id === "baidu" || id === "tavily";
      expect(provider.capabilities.timeRange).toBe(expectsRange);
    }
  });

  it("binds Baidu to the explicit authorization header only", async () => {
    const requests: Array<{ headers: Record<string, string> }> = [];
    const client = new ProviderHttpClient({
      transport: recordingTransport(requests),
      endpoint: BAIDU_ENDPOINT,
    });
    const provider = LIVE_PROVIDER_FACTORIES.baidu(client, "sk-baidu-header");
    await provider.search({ query: "x", maxResults: 5 }, new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-baidu-header");
    expect(requests[0]!.headers["x-appbuilder-authorization"]).toBeUndefined();
    expect(Object.keys(requests[0]!.headers).filter((key) => /authorization/i.test(key))).toHaveLength(1);
  });

  it("resolves a complete setup into frozen canonical providers/tokens/pricing", () => {
    const setup = resolveLiveProviderSetup(fullEnv());
    expect(Object.isFrozen(setup)).toBe(true);
    expect(Object.isFrozen(setup.providers)).toBe(true);
    expect([...setup.providers]).toEqual(FIVE);
    expect(Object.getPrototypeOf(setup.tokens)).toBe(null);
    expect(Object.isFrozen(setup.tokens)).toBe(true);
    expect(Object.keys(setup.tokens)).toEqual(FIVE);
    expect(Object.getPrototypeOf(setup.pricing)).toBe(null);
    expect(Object.isFrozen(setup.pricing)).toBe(true);
    expect(Object.keys(setup.pricing)).toEqual(FIVE);
    expect(setup.pricing.baidu!.currency).toBe("CNY");
    expect(setup.pricing.tavily!.currency).toBe("USD");
  });

  it("fails closed inside setup on provider/key/pricing boundary violations with fixed messages", () => {
    // missing provider in the explicit selection
    expect(() => resolveLiveProviderSetup({ ...fullEnv(), DEEPFIELD_SEARCH_PROVIDERS: "baidu,zhipu,metaso,tavily" })).toThrow(/providers/i);
    // an extra unknown provider
    expect(() => resolveLiveProviderSetup({ ...fullEnv(), DEEPFIELD_SEARCH_PROVIDERS: `${FIVE_STRING},brave` })).toThrow(/providers/i);
    // each missing key
    for (const key of ["BAIDU_SEARCH_API_KEY", "ZHIPU_SEARCH_API_KEY", "METASO_SEARCH_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY"]) {
      const env = fullEnv();
      delete env[key];
      expect(() => resolveLiveProviderSetup(env)).toThrow(/API_KEY/);
    }
    // blank key
    expect(() => resolveLiveProviderSetup({ ...fullEnv(), TAVILY_API_KEY: "   " })).toThrow(/TAVILY_API_KEY/);
    // missing/malformed/partial/extra pricing
    const noPricing = fullEnv();
    delete noPricing.DEEPFIELD_SEARCH_PRICING;
    expect(() => resolveLiveProviderSetup(noPricing)).toThrow(/pricing/i);
    expect(() => resolveLiveProviderSetup(fullEnv("{not-json"))).toThrow(/pricing/i);
    const partial = JSON.parse(syntheticPricingJson()) as Record<string, unknown>;
    delete partial.zhipu;
    expect(() => resolveLiveProviderSetup(fullEnv(JSON.stringify(partial)))).toThrow(/pricing/i);
    const extra = JSON.parse(syntheticPricingJson()) as Record<string, unknown>;
    (extra as Record<string, unknown>).evil = { amountPerRequest: 0.01, currency: "USD", usdPerCurrencyUnit: 1, priceSourceUrl: "https://example.com/", priceObservedOn: "2026-09-01" };
    expect(() => resolveLiveProviderSetup(fullEnv(JSON.stringify(extra)))).toThrow(/pricing/i);
    // fixed sanitized messages never echo env values
    try {
      resolveLiveProviderSetup(fullEnv("{not-json"));
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).not.toContain("{not-json");
      expect(String(error)).not.toContain("k-baidu");
    }
  });

  it("never runs a pricing env accessor getter and treats it as missing", () => {
    const env = fullEnv();
    delete env.DEEPFIELD_SEARCH_PRICING;
    Object.defineProperty(env, "DEEPFIELD_SEARCH_PRICING", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-pricing-accessor-secret");
      },
    });
    try {
      resolveLiveProviderSetup(env);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/pricing/i);
      expect(String(error)).not.toContain("sk-pricing-accessor-secret");
    }
    // an inherited pricing value is treated as missing too (own-data-descriptor read)
    const inheritedRoot = Object.create({ DEEPFIELD_SEARCH_PRICING: syntheticPricingJson() }) as Record<string, string>;
    const base = fullEnv();
    delete base.DEEPFIELD_SEARCH_PRICING;
    for (const [key, value] of Object.entries(base)) {
      inheritedRoot[key] = value;
    }
    expect(() => resolveLiveProviderSetup(inheritedRoot)).toThrow(/pricing/i);
  });
});

describe("live entry static regression (focused revision)", () => {
  const contract = readFileSync(join(import.meta.dirname, "provider-contract.live.test.ts"), "utf8");
  const benchmark = readFileSync(join(import.meta.dirname, "..", "benchmark", "search-benchmark.live.test.ts"), "utf8");

  it("both live entries import the shared assembly and have no local duplicate maps", () => {
    for (const source of [contract, benchmark]) {
      expect(source).toContain("resolveLiveProviderSetup");
      expect(source).toContain("LIVE_PROVIDER_ENDPOINTS");
      expect(source).toContain("LIVE_PROVIDER_FACTORIES");
      expect(source).not.toMatch(/\b(const|let|var)\s+(ENDPOINTS|FACTORIES)\b/);
      expect(source).not.toContain("loadPricing");
    }
  });

  it("resolves the setup before constructing any ProviderHttpClient in both live entries", () => {
    for (const source of [contract, benchmark]) {
      const setupIndex = source.indexOf("resolveLiveProviderSetup(");
      const clientIndex = source.indexOf("new ProviderHttpClient(");
      expect(setupIndex).toBeGreaterThanOrEqual(0);
      expect(clientIndex).toBeGreaterThan(setupIndex);
    }
  });
});

function transportStub(): ProviderTransport {
  return {
    async request() {
      throw new Error("transport must not be reached");
    },
  };
}

function recordingTransport(requests: Array<{ headers: Record<string, string> }>): ProviderTransport {
  return {
    async request(_endpoint, request) {
      requests.push({ headers: request.headers });
      const body = Readable.from([Buffer.from(JSON.stringify({ references: [] }), "utf8")]);
      const response: ProviderTransportResponse = {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body,
        destroy() {},
      };
      return response;
    },
  };
}
