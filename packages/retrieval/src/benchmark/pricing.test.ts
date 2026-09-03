import { describe, expect, it } from "vitest";
import {
  parseProviderPricingJson,
  resolveProviderPricing,
  type ProviderPrice,
} from "./pricing.js";

const CNY_BAIDU: ProviderPrice = {
  amountPerRequest: 0.036,
  currency: "CNY",
  usdPerCurrencyUnit: 0.14,
  priceSourceUrl: "https://cloud.baidu.com/pricing",
  priceObservedOn: "2026-09-01",
  exchangeRateSourceUrl: "https://example.com/fx",
  exchangeRateObservedOn: "2026-09-01",
};

const USD_TAVILY: ProviderPrice = {
  amountPerRequest: 0.01,
  currency: "USD",
  usdPerCurrencyUnit: 1,
  priceSourceUrl: "https://docs.tavily.com/pricing",
  priceObservedOn: "2026-09-01",
};

function omitExchangeFields(price: ProviderPrice, ...keys: Array<"exchangeRateSourceUrl" | "exchangeRateObservedOn">): ProviderPrice {
  const copy: Record<string, unknown> = { ...price };
  for (const key of keys) {
    delete copy[key];
  }
  return copy as unknown as ProviderPrice;
}

describe("benchmark pricing (focused revision)", () => {
  it("resolves valid USD and CNY records into frozen USD per-request costs", () => {
    const resolved = resolveProviderPricing({ baidu: CNY_BAIDU, tavily: USD_TAVILY }, ["baidu", "tavily"]);
    expect(resolved.usdPerRequest).toEqual({ baidu: 0.00504, tavily: 0.01 });
    expect(resolved.records.baidu).toEqual(CNY_BAIDU);
    expect(Object.isFrozen(resolved.records)).toBe(true);
    expect(Object.isFrozen(resolved.records.baidu)).toBe(true);
    expect(Object.isFrozen(resolved.usdPerRequest)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    // cloning: mutating the input after resolution never changes the frozen records
    const mutable = { ...CNY_BAIDU } as { amountPerRequest: number };
    mutable.amountPerRequest = 999;
    expect(resolved.records.baidu!.amountPerRequest).toBe(0.036);
  });

  it("rejects missing and extra providers", () => {
    expect(() => resolveProviderPricing({ baidu: CNY_BAIDU }, ["baidu", "tavily"])).toThrow(/pricing/);
    expect(() => resolveProviderPricing({ baidu: CNY_BAIDU, tavily: USD_TAVILY }, ["baidu"])).toThrow(/pricing/);
    expect(() => resolveProviderPricing({ baidu: CNY_BAIDU, extra: USD_TAVILY }, ["baidu", "tavily"])).toThrow(/pricing/);
  });

  it("rejects invalid provider lists", () => {
    expect(() => resolveProviderPricing({}, [])).toThrow(/providers/);
    expect(() => resolveProviderPricing({}, ["a", "a"])).toThrow(/providers/);
    expect(() => resolveProviderPricing({}, [""])).toThrow(/providers/);
    expect(() => resolveProviderPricing({}, ["p".repeat(65)])).toThrow(/providers/);
  });

  it("rejects negative, infinite and NaN amounts and zero/non-finite rates", () => {
    const base: ProviderPrice = { ...USD_TAVILY };
    expect(() => resolveProviderPricing({ tavily: { ...base, amountPerRequest: -0.01 } }, ["tavily"])).toThrow(/amount/);
    expect(() => resolveProviderPricing({ tavily: { ...base, amountPerRequest: Number.NaN } }, ["tavily"])).toThrow(/amount/);
    expect(() => resolveProviderPricing({ tavily: { ...base, amountPerRequest: Number.POSITIVE_INFINITY } }, ["tavily"])).toThrow(/amount/);
    expect(() => resolveProviderPricing({ tavily: { ...base, usdPerCurrencyUnit: 0 } }, ["tavily"])).toThrow(/usdPerCurrencyUnit|rate/);
    expect(() => resolveProviderPricing({ tavily: { ...base, usdPerCurrencyUnit: Number.NaN } }, ["tavily"])).toThrow(/usdPerCurrencyUnit|rate/);
    expect(() => resolveProviderPricing({ tavily: { ...base, amountPerRequest: 0 } }, ["tavily"])).not.toThrow(); // zero is allowed
  });

  it("requires USD rate to be exactly 1 and forbids USD exchange fields", () => {
    expect(() => resolveProviderPricing({ tavily: { ...USD_TAVILY, usdPerCurrencyUnit: 0.5 } }, ["tavily"])).toThrow(/usd/i);
    expect(() =>
      resolveProviderPricing(
        { tavily: { ...USD_TAVILY, exchangeRateSourceUrl: "https://example.com/fx", exchangeRateObservedOn: "2026-09-01" } },
        ["tavily"],
      ),
    ).toThrow(/exchange/i);
  });

  it("requires CNY to carry BOTH exchange fields", () => {
    expect(() => resolveProviderPricing({ baidu: omitExchangeFields(CNY_BAIDU, "exchangeRateSourceUrl", "exchangeRateObservedOn") }, ["baidu"])).toThrow(/exchange/i);
    expect(() => resolveProviderPricing({ baidu: omitExchangeFields(CNY_BAIDU, "exchangeRateObservedOn") }, ["baidu"])).toThrow(/exchange/i);
  });

  it("rejects non-HTTPS or credential/query/hash-bearing source URLs and impossible dates", () => {
    const badSource: ProviderPrice = { ...USD_TAVILY, priceSourceUrl: "http://docs.tavily.com/pricing" };
    expect(() => resolveProviderPricing({ tavily: badSource }, ["tavily"])).toThrow(/source/i);
    expect(() => resolveProviderPricing({ tavily: { ...USD_TAVILY, priceSourceUrl: "https://user:pass@docs.tavily.com/" } }, ["tavily"])).toThrow(/source/i);
    expect(() => resolveProviderPricing({ tavily: { ...USD_TAVILY, priceSourceUrl: "https://docs.tavily.com/?q=1" } }, ["tavily"])).toThrow(/source/i);
    expect(() => resolveProviderPricing({ tavily: { ...USD_TAVILY, priceSourceUrl: "https://docs.tavily.com/#frag" } }, ["tavily"])).toThrow(/source/i);
    expect(() => resolveProviderPricing({ tavily: { ...USD_TAVILY, priceObservedOn: "2026-02-30" } }, ["tavily"])).toThrow(/priceObservedOn|date/i);
    expect(() => resolveProviderPricing({ baidu: { ...CNY_BAIDU, exchangeRateObservedOn: "2023-02-29" } }, ["baidu"])).toThrow(/exchangeRateObservedOn|date/i);
  });

  it("never echoes records or urls in errors", () => {
    try {
      resolveProviderPricing({ tavily: { ...USD_TAVILY, priceSourceUrl: "http://bad.example/pricing" } }, ["tavily"]);
      throw new Error("unreachable");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("bad.example");
      expect(message).not.toContain("0.01");
    }
  });

  it("parseProviderPricingJson handles missing/blank/malformed/array/null roots and unknown properties", () => {
    expect(() => parseProviderPricingJson(undefined, ["baidu", "tavily"])).toThrow(/pricing/i);
    expect(() => parseProviderPricingJson("   ", ["baidu", "tavily"])).toThrow(/pricing/i);
    expect(() => parseProviderPricingJson("{not-json", ["baidu", "tavily"])).toThrow(/pricing/i);
    expect(() => parseProviderPricingJson("[]", ["baidu", "tavily"])).toThrow(/pricing/i);
    expect(() => parseProviderPricingJson("null", ["baidu", "tavily"])).toThrow(/pricing/i);
    expect(() => parseProviderPricingJson("42", ["baidu", "tavily"])).toThrow(/pricing/i);
    expect(() =>
      parseProviderPricingJson(
        JSON.stringify({ baidu: CNY_BAIDU, tavily: { ...USD_TAVILY, apiKey: "sk-secret" } }),
        ["baidu", "tavily"],
      ),
    ).toThrow(/pricing/);
    // errors never echo the raw JSON or the key
    try {
      parseProviderPricingJson("{broken", ["baidu"]);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).not.toContain("{broken");
    }
    try {
      parseProviderPricingJson(JSON.stringify({ baidu: { ...CNY_BAIDU, apiKey: "sk-secret" } }), ["baidu"]);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).not.toContain("sk-secret");
    }
  });

  it("parseProviderPricingJson returns frozen records for a valid object", () => {
    const records = parseProviderPricingJson(
      JSON.stringify({ baidu: CNY_BAIDU, tavily: USD_TAVILY }),
      ["baidu", "tavily"],
    );
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records.baidu)).toBe(true);
    expect(records.baidu!.currency).toBe("CNY");
    expect(records.tavily!.currency).toBe("USD");
  });
});
