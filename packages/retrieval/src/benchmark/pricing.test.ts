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
  });

  it("clones the ACTUAL input record: mutating it after resolve never changes the frozen output", () => {
    const mutableInput: ProviderPrice = { ...CNY_BAIDU };
    const resolved = resolveProviderPricing({ baidu: mutableInput }, ["baidu"]);
    (mutableInput as { amountPerRequest: number }).amountPerRequest = 999;
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

  it("reads ONLY own data property descriptors: inherited/accessor/symbol/non-enumerable fields are rejected without running getters", () => {
    // required fields inherited from the prototype: must be rejected
    const inherited = Object.create(USD_TAVILY) as ProviderPrice;
    expect(() => resolveProviderPricing({ tavily: inherited }, ["tavily"])).toThrow(/pricing/);

    // an accessor field: the getter must NEVER run (it would throw with a secret)
    const accessorRecord: Record<string, unknown> = {
      currency: "USD",
      usdPerCurrencyUnit: 1,
      priceSourceUrl: "https://docs.tavily.com/pricing",
      priceObservedOn: "2026-09-01",
    };
    Object.defineProperty(accessorRecord, "amountPerRequest", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-accessor-secret");
      },
    });
    try {
      resolveProviderPricing({ tavily: accessorRecord as unknown as ProviderPrice }, ["tavily"]);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/pricing/);
      expect(String(error)).not.toContain("sk-accessor-secret");
    }

    // a symbol own field: rejected
    const symbolRecord: Record<string | symbol, unknown> = { ...USD_TAVILY };
    symbolRecord[Symbol("boom")] = 1;
    expect(() => resolveProviderPricing({ tavily: symbolRecord as unknown as ProviderPrice }, ["tavily"])).toThrow(/pricing/);

    // a non-enumerable unknown own field: rejected
    const hiddenRecord: Record<string, unknown> = { ...USD_TAVILY };
    Object.defineProperty(hiddenRecord, "apiKey", { enumerable: false, configurable: true, writable: true, value: "sk-hidden" });
    try {
      resolveProviderPricing({ tavily: hiddenRecord as unknown as ProviderPrice }, ["tavily"]);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/pricing/);
      expect(String(error)).not.toContain("sk-hidden");
    }

    // a provider ENTRY as an accessor on the input root: never invoked
    const root: Record<string, ProviderPrice> = {};
    Object.defineProperty(root, "tavily", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-root-secret");
      },
    });
    try {
      resolveProviderPricing(root, ["tavily"]);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/pricing/);
      expect(String(error)).not.toContain("sk-root-secret");
    }
  });

  it("supports the legal provider id __proto__ via null-prototype dictionaries", () => {
    const input: Record<string, ProviderPrice> = {};
    Object.defineProperty(input, "__proto__", { value: USD_TAVILY, enumerable: true, configurable: true, writable: true });
    const resolved = resolveProviderPricing(input, ["__proto__"]);
    // records and usdPerRequest must OWN the key (no prototype setter triggered)
    expect(Object.prototype.hasOwnProperty.call(resolved.records, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(resolved.records)).toBe(null);
    expect(Object.getOwnPropertyDescriptor(resolved.records, "__proto__")!.value).toEqual(USD_TAVILY);
    expect(Object.prototype.hasOwnProperty.call(resolved.usdPerRequest, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(resolved.usdPerRequest)).toBe(null);
    expect(Object.getOwnPropertyDescriptor(resolved.usdPerRequest, "__proto__")!.value).toBe(0.01);
    expect(Object.isFrozen(resolved.records)).toBe(true);
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
