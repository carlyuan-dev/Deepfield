import { isValidDateString } from "../search-provider.js";

export type PriceCurrency = "CNY" | "USD";

export interface ProviderPrice {
  /** Native per-request amount in `currency` (finite, non-negative). */
  readonly amountPerRequest: number;
  readonly currency: PriceCurrency;
  /** Positive finite conversion rate into USD (exactly 1 for USD records). */
  readonly usdPerCurrencyUnit: number;
  /** https:// source with no credentials/query/hash. */
  readonly priceSourceUrl: string;
  /** YYYY-MM-DD observation date. */
  readonly priceObservedOn: string;
  /** Required for CNY records, forbidden for USD records. */
  readonly exchangeRateSourceUrl?: string;
  readonly exchangeRateObservedOn?: string;
}

export interface ResolvedProviderPricing {
  /** Frozen native-currency price records keyed by provider. */
  readonly records: Readonly<Record<string, ProviderPrice>>;
  /** Frozen USD-per-request costs: amountPerRequest * usdPerCurrencyUnit. */
  readonly usdPerRequest: Readonly<Record<string, number>>;
}

const KNOWN_FIELDS = new Set([
  "amountPerRequest",
  "currency",
  "usdPerCurrencyUnit",
  "priceSourceUrl",
  "priceObservedOn",
  "exchangeRateSourceUrl",
  "exchangeRateObservedOn",
]);

function fail(provider: string, label: string): never {
  throw new Error(`pricing: ${provider}: ${label}`);
}

function requireHttpsUrl(value: unknown, provider: string, label: string): void {
  if (typeof value !== "string") {
    fail(provider, label);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(provider, label);
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    fail(provider, label);
  }
}

/**
 * Validates the provider list and every price record, clones + freezes each
 * record and derives USD-per-request WITHOUT rounding. Object keys must EXACTLY
 * equal the provider set; no inherited fields are read and no unknown
 * properties are copied. Errors carry only provider ids and stable labels —
 * never serialized records or URLs.
 */
export function resolveProviderPricing(
  input: Readonly<Record<string, ProviderPrice>>,
  providers: readonly string[],
): ResolvedProviderPricing {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("pricing: invalid providers list");
  }
  const seen = new Set<string>();
  for (const provider of providers) {
    if (typeof provider !== "string" || provider.length === 0 || provider.length > 64 || seen.has(provider)) {
      throw new Error("pricing: invalid providers list");
    }
    seen.add(provider);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("pricing: invalid pricing object");
  }
  const inputKeys = Object.keys(input);
  if (inputKeys.length !== seen.size || inputKeys.some((key) => !seen.has(key))) {
    throw new Error("pricing: provider price records must exactly match providers");
  }

  const records: Record<string, ProviderPrice> = {};
  const usdPerRequest: Record<string, number> = {};
  for (const provider of providers) {
    const raw = input[provider];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(provider, "invalid record");
    }
    const own = raw as unknown as Record<string, unknown>;
    for (const key of Object.keys(own)) {
      if (!KNOWN_FIELDS.has(key)) {
        fail(provider, "unknown field");
      }
    }
    const amountPerRequest = own.amountPerRequest;
    if (typeof amountPerRequest !== "number" || !Number.isFinite(amountPerRequest) || amountPerRequest < 0) {
      fail(provider, "invalid amountPerRequest");
    }
    const currency = own.currency;
    if (currency !== "CNY" && currency !== "USD") {
      fail(provider, "invalid currency");
    }
    const usdPerCurrencyUnit = own.usdPerCurrencyUnit;
    if (typeof usdPerCurrencyUnit !== "number" || !Number.isFinite(usdPerCurrencyUnit) || usdPerCurrencyUnit <= 0) {
      fail(provider, "invalid usdPerCurrencyUnit");
    }
    const hasExchangeSource = own.exchangeRateSourceUrl !== undefined;
    const hasExchangeObserved = own.exchangeRateObservedOn !== undefined;
    if (currency === "USD") {
      if (usdPerCurrencyUnit !== 1) {
        fail(provider, "usd rate must be 1");
      }
      if (hasExchangeSource || hasExchangeObserved) {
        fail(provider, "exchange fields forbidden for usd");
      }
    } else {
      if (!hasExchangeSource || !hasExchangeObserved) {
        fail(provider, "exchange fields required for cny");
      }
    }
    requireHttpsUrl(own.priceSourceUrl, provider, "invalid priceSourceUrl");
    if (typeof own.priceObservedOn !== "string" || !isValidDateString(own.priceObservedOn)) {
      fail(provider, "invalid priceObservedOn");
    }
    if (currency === "CNY") {
      requireHttpsUrl(own.exchangeRateSourceUrl, provider, "invalid exchangeRateSourceUrl");
      if (typeof own.exchangeRateObservedOn !== "string" || !isValidDateString(own.exchangeRateObservedOn)) {
        fail(provider, "invalid exchangeRateObservedOn");
      }
    }
    // clone ONLY the known own fields; never spread inherited/unknown props
    const clone: {
      amountPerRequest: number;
      currency: PriceCurrency;
      usdPerCurrencyUnit: number;
      priceSourceUrl: string;
      priceObservedOn: string;
      exchangeRateSourceUrl?: string;
      exchangeRateObservedOn?: string;
    } = {
      amountPerRequest: amountPerRequest as number,
      currency: currency as PriceCurrency,
      usdPerCurrencyUnit: usdPerCurrencyUnit as number,
      priceSourceUrl: own.priceSourceUrl as string,
      priceObservedOn: own.priceObservedOn as string,
    };
    if (hasExchangeSource) {
      clone.exchangeRateSourceUrl = own.exchangeRateSourceUrl as string;
    }
    if (hasExchangeObserved) {
      clone.exchangeRateObservedOn = own.exchangeRateObservedOn as string;
    }
    records[provider] = Object.freeze(clone) as ProviderPrice;
    usdPerRequest[provider] = clone.amountPerRequest * clone.usdPerCurrencyUnit; // no rounding
  }
  return Object.freeze({
    records: Object.freeze(records),
    usdPerRequest: Object.freeze(usdPerRequest),
  });
}

/**
 * Single untrusted environment boundary: parses the DEEPFIELD_SEARCH_PRICING
 * JSON without attaching the parser error as a cause, requires a plain
 * own-property object, then delegates to resolveProviderPricing and returns
 * its frozen records. Stable errors never echo the raw JSON.
 */
export function parseProviderPricingJson(
  raw: string | undefined,
  providers: readonly string[],
): Readonly<Record<string, ProviderPrice>> {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("pricing: DEEPFIELD_SEARCH_PRICING is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("pricing: invalid pricing json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("pricing: invalid pricing json root");
  }
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("pricing: invalid pricing json root");
  }
  return resolveProviderPricing(parsed as Record<string, ProviderPrice>, providers).records;
}
