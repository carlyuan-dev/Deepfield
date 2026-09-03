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
  /** Frozen native-currency price records keyed by provider (null prototype). */
  readonly records: Readonly<Record<string, ProviderPrice>>;
  /** Frozen USD-per-request costs: amountPerRequest * usdPerCurrencyUnit (null prototype). */
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

/** Reads ONLY an own DATA property descriptor; accessors and inherited fields are rejected. */
function ownDataValue(object: object, key: string, provider: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || "value" in descriptor === false) {
    fail(provider, label);
  }
  return descriptor.value;
}

function assertPlainRecord(record: unknown, provider: string): asserts record is Record<string, unknown> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    fail(provider, "invalid record");
  }
  const proto = Object.getPrototypeOf(record);
  if (proto !== Object.prototype && proto !== null) {
    fail(provider, "invalid record");
  }
  const ownKeys = Reflect.ownKeys(record);
  const enumerableKeys = Object.keys(record);
  // symbol keys OR non-enumerable own fields (incl. unknown ones) both break this invariant
  if (ownKeys.length !== enumerableKeys.length || ownKeys.some((key) => typeof key !== "string")) {
    fail(provider, "invalid record");
  }
  for (const key of enumerableKeys) {
    if (!KNOWN_FIELDS.has(key)) {
      fail(provider, "unknown field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || "value" in descriptor === false) {
      fail(provider, "invalid record");
    }
  }
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
 * record and derives USD-per-request WITHOUT rounding. Every value is read
 * through OWN DATA property descriptors only — inherited fields, accessors,
 * symbol keys and non-enumerable own fields are all rejected and no getter is
 * ever invoked. Object keys must EXACTLY equal the provider set. The output
 * dictionaries have a null prototype so even the legal provider id "__proto__"
 * is stored as an ordinary own key. Errors carry only provider ids and stable
 * labels — never serialized records or URLs.
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
  const inputKeys = Object.keys(input); // own enumerable keys; no getters invoked
  if (inputKeys.length !== seen.size || inputKeys.some((key) => !seen.has(key))) {
    throw new Error("pricing: provider price records must exactly match providers");
  }

  // Null-prototype output dictionaries: "__proto__" can never hit a prototype setter.
  const records: Record<string, ProviderPrice> = Object.create(null) as Record<string, ProviderPrice>;
  const usdPerRequest: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const provider of providers) {
    // Read the provider record through its own data descriptor (never a root getter).
    const raw = ownDataValue(input, provider, provider, "invalid record");
    assertPlainRecord(raw, provider);
    const amountPerRequest = ownDataValue(raw, "amountPerRequest", provider, "invalid amountPerRequest");
    const currency = ownDataValue(raw, "currency", provider, "invalid currency");
    const usdPerCurrencyUnit = ownDataValue(raw, "usdPerCurrencyUnit", provider, "invalid usdPerCurrencyUnit");
    const priceSourceUrl = ownDataValue(raw, "priceSourceUrl", provider, "invalid priceSourceUrl");
    const priceObservedOn = ownDataValue(raw, "priceObservedOn", provider, "invalid priceObservedOn");
    const exchangeRateSourceUrl = Object.getOwnPropertyDescriptor(raw, "exchangeRateSourceUrl");
    const exchangeRateObservedOn = Object.getOwnPropertyDescriptor(raw, "exchangeRateObservedOn");

    if (typeof amountPerRequest !== "number" || !Number.isFinite(amountPerRequest) || amountPerRequest < 0) {
      fail(provider, "invalid amountPerRequest");
    }
    if (currency !== "CNY" && currency !== "USD") {
      fail(provider, "invalid currency");
    }
    if (typeof usdPerCurrencyUnit !== "number" || !Number.isFinite(usdPerCurrencyUnit) || usdPerCurrencyUnit <= 0) {
      fail(provider, "invalid usdPerCurrencyUnit");
    }
    const hasExchangeSource = exchangeRateSourceUrl !== undefined && "value" in exchangeRateSourceUrl;
    const hasExchangeObserved = exchangeRateObservedOn !== undefined && "value" in exchangeRateObservedOn;
    if (currency === "USD") {
      if (usdPerCurrencyUnit !== 1) {
        fail(provider, "usd rate must be 1");
      }
      if (hasExchangeSource || hasExchangeObserved) {
        fail(provider, "exchange fields forbidden for usd");
      }
    } else if (!hasExchangeSource || !hasExchangeObserved) {
      fail(provider, "exchange fields required for cny");
    }
    requireHttpsUrl(priceSourceUrl, provider, "invalid priceSourceUrl");
    if (typeof priceObservedOn !== "string" || !isValidDateString(priceObservedOn)) {
      fail(provider, "invalid priceObservedOn");
    }
    if (currency === "CNY") {
      const source = hasExchangeSource ? exchangeRateSourceUrl.value : undefined;
      const observed = hasExchangeObserved ? exchangeRateObservedOn.value : undefined;
      requireHttpsUrl(source, provider, "invalid exchangeRateSourceUrl");
      if (typeof observed !== "string" || !isValidDateString(observed)) {
        fail(provider, "invalid exchangeRateObservedOn");
      }
    }

    // clone ONLY the known own data fields; never spread inherited/unknown props
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
      priceSourceUrl: priceSourceUrl as string,
      priceObservedOn: priceObservedOn as string,
    };
    if (hasExchangeSource) {
      clone.exchangeRateSourceUrl = exchangeRateSourceUrl.value as string;
    }
    if (hasExchangeObserved) {
      clone.exchangeRateObservedOn = exchangeRateObservedOn.value as string;
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
