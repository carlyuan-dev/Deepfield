# Search Provider Candidate Expansion — Phase 1 Implementation Plan

> **Current planning pointer (2026-09-07):** Provider expansion is retained as
> implementation history. Active product sequencing is defined in
> `docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`.

> **SUPERSEDED (2026-09-07):** this file is the historical implementation plan
> for the Phase-1 expansion. It was executed as written (including Zhipu).
> Current configuration removed Zhipu (no free quota; adapter/fixtures deleted,
> recoverable from Git history; Keychain entry not deleted) and the operative
> candidate set is now `baidu,metaso,tavily,serper`. See the spec decision
> record §0 and the Phase-2 plan Current State block before treating anything
> here as current configuration.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the accepted P2-T8 benchmark foundation with currency-neutral pricing, a deterministic five-provider candidate catalog, strict Baidu and Zhipu adapters, and a non-persisting MetaSo response-shape probe.

**Architecture:** Preserve the existing `SearchProvider` and fixed-origin `ProviderHttpClient` boundaries. Add focused modules for pricing and provider catalog data, then add one adapter per domestic provider. Because MetaSo does not publish a complete successful response schema, Phase 1 ends at a one-call shape-only live gate; its exact adapter and the five-provider live assembly belong to Phase 2 after main-window review.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest 4, existing `ProviderHttpClient`, macOS `security` CLI, zsh, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-search-provider-candidate-expansion-design.md`

## Global Constraints

- Work on branch `codex/tool-platform` starting from commit `4ae9605f246be4952dfb76d032fe291c6c34e4e0` or a reviewed descendant.
- Tasks 1–4 are entirely offline: no keychain reads, DNS, HTTP, provider call or benchmark report write.
- Task 5 implementation and default tests are offline. Its final live probe step is a hard stop requiring a separate instruction from the main window.
- Never place API keys in source, fixtures, command arguments, stdout, test names, errors, reports, Git or DSH YAML.
- Never persist a successful MetaSo response body, URL, title, snippet or page content. The live probe may emit property names and JSON value kinds only.
- Keep Brave adapter support but exclude Brave from `BENCHMARK_CANDIDATES_V1`.
- Do not call Baidu `/web_summary`, MetaSo `/api/v1/chat/completions`, or any Chat-based web-search API.
- Do not add provider failover, blending, runtime multi-provider selection, proxy support or generated answers.
- Preserve `BenchmarkedRun.costUsd` as the common scoring measurement; only the pricing input/report evidence changes.
- All new production and test source files must remain below 300 lines; prefer below 200 lines.
- Do not add or update dependencies. Exact versions in `package.json` and `package-lock.json` remain unchanged.
- Default `npm test` remains deterministic and network-free; every live file ends in `.live.test.ts` and runs only through `vitest.live.config.ts`.
- Use strict TDD: record the intended RED failure, implement the minimum, then run targeted, typecheck, full test, build and `git diff --check` gates.
- Do not touch `docs/架构图/`, `.DS_Store`, ignored build output or unrelated user files.
- Each task produces one focused commit and returns `DEEPFIELD_DSH_REPORT_V1` as a raw fenced YAML block.

## File Structure

```text
packages/retrieval/src/benchmark/pricing.ts
    immutable native-currency price validation and USD conversion
packages/retrieval/src/providers/provider-catalog.ts
    supported adapters, frozen v1 candidate set, env names, keychain services
packages/retrieval/src/providers/baidu.ts
    Baidu basic-search adapter only
packages/retrieval/src/providers/zhipu.ts
    Zhipu independent Web Search adapter only
packages/retrieval/src/providers/metaso-shape.ts
    value-free bounded JSON-shape summarizer for the live contract gate
packages/retrieval/src/providers/metaso-shape.live.test.ts
    one-call MetaSo shape probe; no response persistence
scripts/run-search-live-from-keychain.zsh
    allowlisted launcher that maps macOS Keychain values into child env only
```

---

### Task P2-T8A-1: Currency-Neutral Pricing Evidence

**Files:**
- Create: `packages/retrieval/src/benchmark/pricing.ts`
- Create: `packages/retrieval/src/benchmark/pricing.test.ts`
- Modify: `packages/retrieval/src/benchmark/report.ts`
- Modify: `packages/retrieval/src/benchmark/report.test.ts`
- Modify: `packages/retrieval/src/benchmark/run-benchmark.ts`
- Modify: `packages/retrieval/src/benchmark/run-benchmark.test.ts`
- Modify: `packages/retrieval/src/benchmark/search-benchmark.live.test.ts`
- Modify: `packages/retrieval/src/benchmark/scoring.test.ts`
- Modify: `packages/retrieval/src/index.ts`

**Interfaces:**
- Consumes: `isValidDateString(value: string): boolean` from `search-provider.ts`; existing `BenchmarkedRun.costUsd` and `BenchmarkReport`.
- Produces:

```ts
export type PriceCurrency = "CNY" | "USD";

export interface ProviderPrice {
  readonly amountPerRequest: number;
  readonly currency: PriceCurrency;
  readonly usdPerCurrencyUnit: number;
  readonly priceSourceUrl: string;
  readonly priceObservedOn: string;
  readonly exchangeRateSourceUrl?: string;
  readonly exchangeRateObservedOn?: string;
}

export interface ResolvedProviderPricing {
  readonly records: Readonly<Record<string, ProviderPrice>>;
  readonly usdPerRequest: Readonly<Record<string, number>>;
}

export function resolveProviderPricing(
  input: Readonly<Record<string, ProviderPrice>>,
  providers: readonly string[],
): ResolvedProviderPricing;

export function parseProviderPricingJson(
  raw: string | undefined,
  providers: readonly string[],
): Readonly<Record<string, ProviderPrice>>;
```

- Changes `BenchmarkHarnessDeps.pricingUsd` and `pricingNote` to one field:

```ts
pricing: Readonly<Record<string, ProviderPrice>>;
```

- Changes `BenchmarkReport.pricingUsd` and `pricingNote` to:

```ts
pricing: Record<string, ProviderPrice>;
```

- Keeps `BenchmarkedRun.costUsd` and all scoring formulas unchanged.

- [ ] **Step 1: Write failing pricing tests**

Create table-driven tests for valid USD and CNY records, exact provider-key matching, URL/date rules, currency-specific exchange fields and runtime immutability. Include these concrete assertions:

```ts
const resolved = resolveProviderPricing({
  baidu: {
    amountPerRequest: 0.036,
    currency: "CNY",
    usdPerCurrencyUnit: 0.14,
    priceSourceUrl: "https://cloud.baidu.com/pricing",
    priceObservedOn: "2026-09-01",
    exchangeRateSourceUrl: "https://example.com/fx",
    exchangeRateObservedOn: "2026-09-01",
  },
  tavily: {
    amountPerRequest: 0.01,
    currency: "USD",
    usdPerCurrencyUnit: 1,
    priceSourceUrl: "https://docs.tavily.com/pricing",
    priceObservedOn: "2026-09-01",
  },
}, ["baidu", "tavily"]);

expect(resolved.usdPerRequest).toEqual({ baidu: 0.00504, tavily: 0.01 });
expect(Object.isFrozen(resolved.records)).toBe(true);
expect(Object.isFrozen(resolved.records.baidu)).toBe(true);
```

Reject missing and extra providers; negative, infinite and `NaN` amounts; zero/non-finite rates; non-HTTPS or credential-bearing source URLs; impossible dates; USD rate other than `1`; USD exchange fields; and CNY missing either exchange field. For `parseProviderPricingJson`, cover missing/blank input, malformed JSON, array/null roots, unknown properties and a valid five-record object. Assert errors contain only provider IDs and stable validation labels, never serialized records or URLs.

- [ ] **Step 2: Run the new test and record RED**

Run:

```bash
npm test -- packages/retrieval/src/benchmark/pricing.test.ts
```

Expected: FAIL because `./pricing.js` does not exist.

- [ ] **Step 3: Implement `resolveProviderPricing`**

Validate the provider list first: non-empty unique IDs, each 1–64 characters. Require `Object.keys(input)` to exactly equal the provider set. Validate `https:` source URLs with no username, password, query or hash. Validate dates with `isValidDateString`. Clone and freeze every accepted record, then freeze `records`, `usdPerRequest` and the returned wrapper. Compute USD cost without rounding:

```ts
usdPerRequest[provider] = record.amountPerRequest * record.usdPerCurrencyUnit;
```

Do not accept inherited fields or copy unknown properties.

Implement `parseProviderPricingJson` as the single untrusted environment boundary: parse JSON without attaching the parser error as a cause, require a plain own-property object, then call `resolveProviderPricing` and return its frozen `records`. Its stable errors must not echo raw JSON.

- [ ] **Step 4: Run pricing tests and record GREEN**

Run:

```bash
npm test -- packages/retrieval/src/benchmark/pricing.test.ts
```

Expected: all pricing tests pass.

- [ ] **Step 5: Refactor the benchmark and report boundary**

In `runBenchmark`, resolve pricing before calculating `expectedMeasurements` or invoking `writer`. Use `resolved.usdPerRequest[provider.id]` for `BenchmarkedRun.costUsd`. Copy the frozen native records into every checkpoint report as `pricing`; remove `pricingUsd` and `pricingNote` everywhere. Update report/scoring/run-harness fixtures with explicit USD/CNY records and assert:

```ts
expect(report.pricing.baidu.currency).toBe("CNY");
expect(report.runs.find((run) => run.provider === "baidu")?.costUsd).toBe(0.00504);
expect(JSON.stringify(report)).not.toContain("apiKey");
```

Keep scoring inputs and outputs otherwise byte-for-byte compatible.

Update `search-benchmark.live.test.ts` in the same task so TypeScript never carries a stale call site: remove its local numeric `parsePricing`, `PRICING_USD` and `PRICING_NOTE`; call `parseProviderPricingJson(process.env.DEEPFIELD_SEARCH_PRICING, RUN.providers)` before any transport or report write, and pass the returned record as `pricing`. The environment variable now contains the exact `ProviderPrice` JSON object, not a numeric USD map. This live file is compiled but is not executed by default tests.

- [ ] **Step 6: Verify Task P2-T8A-1**

Run:

```bash
npm test -- packages/retrieval/src/benchmark/pricing.test.ts packages/retrieval/src/benchmark/run-benchmark.test.ts packages/retrieval/src/benchmark/report.test.ts packages/retrieval/src/benchmark/scoring.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: targeted tests, typecheck, full offline suite and four build outputs pass; no live test executes; package files have no diff.

- [ ] **Step 7: Commit Task P2-T8A-1**

```bash
git add packages/retrieval/src/benchmark/pricing.ts packages/retrieval/src/benchmark/pricing.test.ts packages/retrieval/src/benchmark/report.ts packages/retrieval/src/benchmark/report.test.ts packages/retrieval/src/benchmark/run-benchmark.ts packages/retrieval/src/benchmark/run-benchmark.test.ts packages/retrieval/src/benchmark/search-benchmark.live.test.ts packages/retrieval/src/benchmark/scoring.test.ts packages/retrieval/src/index.ts
git commit -m "feat: record benchmark pricing in native currency"
```

Stop and return a DSH report for main-window review before Task P2-T8A-2.

---

### Task P2-T8A-2: Supported Adapter Catalog and Frozen Candidate Set

**Files:**
- Create: `packages/retrieval/src/providers/provider-catalog.ts`
- Create: `packages/retrieval/src/providers/provider-catalog.test.ts`
- Modify: `packages/retrieval/src/providers/live-config.ts`
- Modify: `packages/retrieval/src/providers/live-config.test.ts`
- Modify: `packages/retrieval/src/providers/provider-contract.live.test.ts`
- Modify: `packages/retrieval/src/benchmark/search-benchmark.live.test.ts`
- Delete: `packages/retrieval/src/providers/live-keys.ts`
- Modify: `packages/retrieval/src/index.ts`

**Interfaces:**
- Produces:

```ts
export const SUPPORTED_PROVIDER_IDS = [
  "brave", "tavily", "serper", "baidu", "zhipu", "metaso",
] as const;

export const BENCHMARK_CANDIDATES_V1 = [
  "baidu", "zhipu", "metaso", "tavily", "serper",
] as const;

export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];
export type LiveProviderId = (typeof BENCHMARK_CANDIDATES_V1)[number];

export const LIVE_PROVIDER_ENV_KEYS: Readonly<Record<LiveProviderId, string>>;
export const KEYCHAIN_SERVICES: Readonly<Record<LiveProviderId, string>>;
```

- `LIVE_PROVIDER_ENV_KEYS` maps to the five names approved in the spec.
- `KEYCHAIN_SERVICES` maps to `com.deepfield.benchmark.<provider>`.
- `resolveLiveProviders(raw)` requires exact membership in `BENCHMARK_CANDIDATES_V1` and returns canonical candidate order.
- `requireLiveKeys` and `resolveLiveRun` retain their existing signatures but use the single catalog source.
- Produces a temporary Phase 1 assembly guard so expanding `LiveProviderId` cannot create an incomplete typed factory map or accidentally run the old three-provider live path:

```ts
export function requireBenchmarkCandidateAssembly<T>(
  label: string,
  entries: Readonly<Partial<Record<SupportedProviderId, T>>>,
): Readonly<Record<LiveProviderId, T>>;
```

- [ ] **Step 1: Write failing catalog and live-config tests**

Assert the exact supported/candidate arrays, Brave support without v1 candidacy, deep runtime freezing, exact env/keychain maps, canonical ordering and fail-closed selection:

```ts
expect(SUPPORTED_PROVIDER_IDS).toContain("brave");
expect(BENCHMARK_CANDIDATES_V1).not.toContain("brave");
expect(resolveLiveProviders("serper,baidu,tavily,metaso,zhipu")).toEqual([
  "baidu", "zhipu", "metaso", "tavily", "serper",
]);
```

Reject a single provider, an unknown provider, duplicates, a set missing one candidate and any set containing Brave. Require all five non-blank keys; whitespace-only values fail. Assert thrown messages contain only env variable and provider names, not available key values.

Also test `requireBenchmarkCandidateAssembly`: a complete synthetic five-candidate map is copied, frozen and returned; a map containing only the legacy `brave`/`tavily`/`serper` entries fails with the stable message `P2-T8A Phase 2 <label> assembly is incomplete: baidu,zhipu,metaso`. The message may contain only the label and missing provider IDs, never entry values. Brave may be present in the input because it remains supported, but it is omitted from the returned candidate record.

- [ ] **Step 2: Run tests and record RED**

Run:

```bash
npm test -- packages/retrieval/src/providers/provider-catalog.test.ts packages/retrieval/src/providers/live-config.test.ts
```

Expected: FAIL because `provider-catalog.ts` does not exist and the old candidate universe is three providers.

- [ ] **Step 3: Implement the catalog and consolidate key metadata**

Freeze all arrays/maps at module initialization. In `resolveLiveProviders`, parse the explicit comma-separated value, reject empty entries/duplicates/unknown IDs, compare its set exactly to the frozen v1 set, and return `[...BENCHMARK_CANDIDATES_V1]`. Do not infer candidates from available keys. Remove the duplicate `live-keys.ts` module after moving its only public metadata to `provider-catalog.ts`.

Implement `requireBenchmarkCandidateAssembly` by checking every ID in `BENCHMARK_CANDIDATES_V1` with `Object.hasOwn(entries, provider)`, rejecting `undefined` values, copying only those five entries into a null-prototype object, and freezing the returned record. It is a temporary fail-closed Phase 1 boundary, not provider selection or fallback.

- [ ] **Step 4: Run catalog/config tests and record GREEN**

Run:

```bash
npm test -- packages/retrieval/src/providers/provider-catalog.test.ts packages/retrieval/src/providers/live-config.test.ts
```

Expected: all tests pass; no environment key is read during unit tests.

- [ ] **Step 5: Make both existing live entry points explicitly fail closed during Phase 1**

In `provider-contract.live.test.ts` and `search-benchmark.live.test.ts`, type the legacy endpoint and factory literals as `Partial<Record<SupportedProviderId, ...>>`, then pass them through `requireBenchmarkCandidateAssembly` before resolving keys, constructing a transport, parsing pricing, invoking a writer or entering a test body. The returned complete record is the only map later indexed by `LiveProviderId`.

Do not add placeholder Baidu/Zhipu/MetaSo factories, do not silently filter `RUN.providers`, and do not keep a three-provider escape hatch. Until Phase 2 assembles all five real adapters, either live entry point must stop before I/O with the stable incomplete-assembly error. This keeps `npm run typecheck` honest while making the temporary inability to run the full live suite explicit.

- [ ] **Step 6: Verify Task P2-T8A-2**

Run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: full offline regression and TypeScript compilation pass. Default tests stay network-free. Static inspection shows both opt-in live entry points call `requireBenchmarkCandidateAssembly` before key resolution or transport/report work and cannot silently execute the legacy three-provider subset.

- [ ] **Step 7: Commit Task P2-T8A-2**

```bash
git add packages/retrieval/src/providers/provider-catalog.ts packages/retrieval/src/providers/provider-catalog.test.ts packages/retrieval/src/providers/live-config.ts packages/retrieval/src/providers/live-config.test.ts packages/retrieval/src/providers/provider-contract.live.test.ts packages/retrieval/src/benchmark/search-benchmark.live.test.ts packages/retrieval/src/providers/live-keys.ts packages/retrieval/src/index.ts
git commit -m "feat: freeze expanded search candidate catalog"
```

Stop and return a DSH report for main-window review before Task P2-T8A-3.

---

### Task P2-T8A-3: Baidu Basic Search Adapter

**Files:**
- Create: `packages/retrieval/src/providers/baidu.ts`
- Create: `packages/retrieval/src/providers/baidu.test.ts`
- Create: `packages/retrieval/src/providers/fixtures/baidu-success.json`
- Create: `packages/retrieval/src/providers/fixtures/baidu-zero.json`
- Modify: `packages/retrieval/src/index.ts`

**Interfaces:**
- Consumes: `ProviderHttpClient`, `SearchProvider`, `SearchRequest`, `assertValidSearchRequest`, `normalizeSearchResults`, `isValidDateString`.
- Produces:

```ts
export const BAIDU_ENDPOINT: ProviderEndpoint = {
  origin: "https://qianfan.baidubce.com",
  pathPrefix: "/v2/ai_search/web_search",
};

export type BaiduAuthHeader = "authorization" | "x-appbuilder-authorization";

export interface BaiduProviderDeps {
  client: ProviderHttpClient;
  token: string;
  authHeader: BaiduAuthHeader;
}

export function countBaiduQueryUnits(query: string): number;
export function createBaiduProvider(deps: BaiduProviderDeps): SearchProvider;
```

- Provider ID is exactly `baidu`; `capabilities.timeRange` is `true`.
- The auth header remains explicit and has no default. Phase 2 freezes the header confirmed by the contract smoke; the adapter never retries with another header.

- [ ] **Step 1: Write failing Baidu request-boundary tests**

Use the existing scripted transport pattern. Assert endpoint pinning, non-blank token, explicit allowed auth header, one and only one auth header, and this exact request body without `timeRange`:

```json
{
  "messages": [{ "role": "user", "content": "人形机器人 公司" }],
  "search_source": "baidu_search_v2",
  "edition": "standard",
  "resource_type_filter": [{ "type": "web", "top_k": 20 }]
}
```

With a range, assert:

```json
{
  "search_filter": {
    "range": {
      "page_time": { "gte": "2026-01-01", "lte": "2026-08-31" }
    }
  }
}
```

Assert no `/web_summary`, `choices`, `stream`, generated-answer flag or full-content flag appears in the request.

- [ ] **Step 2: Write failing Baidu query-unit tests**

Assert Han code points count as two and other Unicode code points as one:

```ts
expect(countBaiduQueryUnits("AI机器人")).toBe(8);
expect(countBaiduQueryUnits("a".repeat(72))).toBe(72);
expect(countBaiduQueryUnits("人".repeat(36))).toBe(72);
```

Both 73 ASCII units and 74 Han units must fail with `SearchProviderError("invalid_request")` before transport invocation. Include a surrogate-pair case to prove iteration is by Unicode code point, not UTF-16 code unit.

- [ ] **Step 3: Write failing Baidu normalization/error tests**

Fixture results must map only `title`, `url`, `snippet`, local rank, provider and normalized date. `snippet` wins when both fields exist; `content` is used only when `snippet === undefined`. A documented date-time such as `2026-08-31 09:30:00` maps to `2026-08-31`; an absent or non-calendar date is omitted. Assert zero results; missing/non-array `references`; non-string result fields; unsafe URL; 401; 429 with Retry-After; 5xx; invalid JSON; and a raw error containing a test secret. No thrown error or serialized normalized response may contain the raw payload or token.

- [ ] **Step 4: Run Baidu tests and record RED**

Run:

```bash
npm test -- packages/retrieval/src/providers/baidu.test.ts
```

Expected: FAIL because `./baidu.js` does not exist.

- [ ] **Step 5: Implement the Baidu adapter**

Validate dependencies at factory construction, including exact client endpoint and allowed auth header. Before `client.request`, run the shared request validator and provider-specific 72-unit validator. Send one `POST` to `BAIDU_ENDPOINT.pathPrefix`; set only the selected header to `Bearer ${token}` plus JSON accept/content headers. Parse one bounded JSON body, require `references` array, map documented fields, and delegate final URL/title/snippet/rank validation to `normalizeSearchResults`. Do not copy `authority_score`, `rerank_score`, icons or raw content into normalized output.

- [ ] **Step 6: Run Baidu tests and record GREEN**

Run:

```bash
npm test -- packages/retrieval/src/providers/baidu.test.ts
```

Expected: all Baidu tests pass with zero network requests.

- [ ] **Step 7: Verify Task P2-T8A-3**

Run:

```bash
npm test -- packages/retrieval/src/providers/baidu.test.ts packages/retrieval/src/providers/provider-http-client.test.ts packages/retrieval/src/search-provider.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: targeted and full offline gates pass; fixture files contain synthetic public examples and no live body or key.

- [ ] **Step 8: Commit Task P2-T8A-3**

```bash
git add packages/retrieval/src/providers/baidu.ts packages/retrieval/src/providers/baidu.test.ts packages/retrieval/src/providers/fixtures/baidu-success.json packages/retrieval/src/providers/fixtures/baidu-zero.json packages/retrieval/src/index.ts
git commit -m "feat: add Baidu basic search adapter"
```

Stop and return a DSH report for main-window review before Task P2-T8A-4.

---

### Task P2-T8A-4: Zhipu Independent Web Search Adapter

**Files:**
- Create: `packages/retrieval/src/providers/zhipu.ts`
- Create: `packages/retrieval/src/providers/zhipu.test.ts`
- Create: `packages/retrieval/src/providers/fixtures/zhipu-success.json`
- Create: `packages/retrieval/src/providers/fixtures/zhipu-zero.json`
- Modify: `packages/retrieval/src/index.ts`

**Interfaces:**
- Consumes: the same shared provider contracts/client as Task P2-T8A-3.
- Produces:

```ts
export const ZHIPU_ENDPOINT: ProviderEndpoint = {
  origin: "https://open.bigmodel.cn",
  pathPrefix: "/api/paas/v4/web_search",
};

export interface ZhipuProviderDeps {
  client: ProviderHttpClient;
  token: string;
}

export function countUnicodeCodePoints(value: string): number;
export function createZhipuProvider(deps: ZhipuProviderDeps): SearchProvider;
```

- Provider ID is exactly `zhipu`; `capabilities.timeRange` is `false`.
- Engine is frozen to `search_pro`; `search_intent` is always `false`.

- [ ] **Step 1: Write failing Zhipu request-boundary tests**

Assert endpoint pinning, non-blank token, `Authorization: Bearer <token>`, no token in JSON, and this exact body for `maxResults: 20`:

```json
{
  "search_query": "humanoid robot companies official website",
  "search_engine": "search_pro",
  "search_intent": false,
  "count": 20,
  "content_size": "medium"
}
```

Assert the request does not contain `messages`, Chat model fields or generated-answer options. Supplying any exact `timeRange` must fail before transport invocation.

- [ ] **Step 2: Write failing Zhipu length/normalization tests**

Use `Array.from(value).length` semantics. Exactly 70 Unicode code points pass; 71 fail before I/O, including astral characters. Map `search_result[]` fields as `title`, `link` to URL, `content` to snippet, local rank and provider. Normalize a valid leading `YYYY-MM-DD` from `publish_date`; omit absent or invalid dates.

Cover zero results; missing/non-array `search_result`; malformed entry; dangerous URL; 401; 429; 5xx; invalid JSON; and raw secret-bearing provider error. Assert safe fixed errors only.

- [ ] **Step 3: Run Zhipu tests and record RED**

Run:

```bash
npm test -- packages/retrieval/src/providers/zhipu.test.ts
```

Expected: FAIL because `./zhipu.js` does not exist.

- [ ] **Step 4: Implement the Zhipu adapter**

Validate factory dependencies and endpoint, then shared request rules, exact-range rejection and the 70-code-point limit before I/O. Send one POST with the frozen body above. Strictly require `search_result` array and whitelisted fields; let shared normalization enforce output bounds, ranks and safe URLs. Never expose `search_intent`, request IDs, icons, provider diagnostics or raw JSON.

- [ ] **Step 5: Run Zhipu tests and record GREEN**

Run:

```bash
npm test -- packages/retrieval/src/providers/zhipu.test.ts
```

Expected: all Zhipu tests pass offline.

- [ ] **Step 6: Verify Task P2-T8A-4**

Run:

```bash
npm test -- packages/retrieval/src/providers/zhipu.test.ts packages/retrieval/src/providers/provider-http-client.test.ts packages/retrieval/src/search-provider.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all offline gates pass and dependencies remain unchanged.

- [ ] **Step 7: Commit Task P2-T8A-4**

```bash
git add packages/retrieval/src/providers/zhipu.ts packages/retrieval/src/providers/zhipu.test.ts packages/retrieval/src/providers/fixtures/zhipu-success.json packages/retrieval/src/providers/fixtures/zhipu-zero.json packages/retrieval/src/index.ts
git commit -m "feat: add Zhipu web search adapter"
```

Stop and return a DSH report for main-window review before Task P2-T8A-5.

---

### Task P2-T8A-5: MetaSo Value-Free Shape Probe and Keychain Launcher

**Files:**
- Create: `packages/retrieval/src/providers/metaso-shape.ts`
- Create: `packages/retrieval/src/providers/metaso-shape.test.ts`
- Create: `packages/retrieval/src/providers/metaso-shape.live.test.ts`
- Create: `scripts/run-search-live-from-keychain.zsh`
- Create: `scripts/run-search-live-from-keychain.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `METASO_SEARCH_API_KEY`, the `com.deepfield.benchmark.metaso` Keychain item, `ProviderHttpClient`, and the existing live Vitest configuration.
- Produces:

```ts
export type JsonShape =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | { readonly type: "array"; readonly length: number; readonly first?: JsonShape }
  | { readonly type: "object"; readonly properties: Readonly<Record<string, JsonShape>> };

export function summarizeJsonShape(value: unknown): JsonShape;
```

- Adds exact package script:

```json
"test:metaso-shape:live": "vitest run --config vitest.live.config.ts packages/retrieval/src/providers/metaso-shape.live.test.ts"
```

- Adds launcher interface:

```text
scripts/run-search-live-from-keychain.zsh metaso-shape
```

No arbitrary command or additional mode is accepted in Phase 1.

- [ ] **Step 1: Write failing shape-summarizer tests**

Assert strings/numbers/booleans/null become kind labels, object property names are retained in sorted order, arrays report length plus only the first element's shape, and no JSON value survives:

```ts
const secret = "sk-value-that-must-not-appear";
const shape = summarizeJsonShape({
  data: [{ title: "A", url: "https://example.com", token: secret }],
  credits: 3,
});
const serialized = JSON.stringify(shape);

expect(serialized).toContain('"title":"string"');
expect(serialized).toContain('"url":"string"');
expect(serialized).not.toContain("https://example.com");
expect(serialized).not.toContain(secret);
expect(serialized).not.toContain('"credits":3');
```

Reject symbol, bigint, function, undefined, cyclic input, objects with symbol keys, depth greater than 12, more than 100 properties on one object, or arrays longer than 10,000. Errors use fixed messages and must not serialize input.

- [ ] **Step 2: Run the summarizer test and record RED**

Run:

```bash
npm test -- packages/retrieval/src/providers/metaso-shape.test.ts
```

Expected: FAIL because `./metaso-shape.js` does not exist.

- [ ] **Step 3: Implement the bounded value-free summarizer**

Track object identity in a `WeakSet`, recurse with explicit depth, sort `Object.keys`, reject symbol keys, freeze every returned object/map, and inspect only array element zero. Never call `String(value)`, `JSON.stringify(value)` or a custom `toJSON` on raw input. Access only ordinary own enumerable data properties; reject accessor descriptors so a getter cannot execute during probing.

- [ ] **Step 4: Write and implement the offline-tested Keychain launcher**

The zsh script must start with:

```zsh
#!/bin/zsh
set -euo pipefail
set +x
unset HISTFILE
```

For the only accepted argument `metaso-shape`, retrieve the secret with:

```zsh
METASO_SEARCH_API_KEY="$(security find-generic-password \
  -a deepfield \
  -s com.deepfield.benchmark.metaso \
  -w)"
```

Reject an empty result, export it only to the child process, set
`DEEPFIELD_SEARCH_PROVIDERS=baidu,zhipu,metaso,tavily,serper`, then execute:

```zsh
exec npm run test:metaso-shape:live
```

The script must never use `echo`, `print`, `env`, `set -x`, `eval`, an arbitrary command argument or a secret as a command-line argument.

In `run-search-live-from-keychain.test.ts`, place fake `security` and `npm` executables in a temporary directory prepended to `PATH`. The fake `security` writes `sk-fake-metaso` to stdout; fake `npm` writes only selected env names and argv into a temp assertion file. Assert the child receives the key and exact npm arguments, while launcher stdout/stderr and thrown messages do not contain `sk-fake-metaso`. Invalid or missing mode must exit nonzero before invoking either fake executable. Always delete the temporary directory.

- [ ] **Step 5: Write the opt-in MetaSo live shape test without running it**

At module load, require a non-blank `METASO_SEARCH_API_KEY`. Construct a fixed-origin client for `https://metaso.cn/api/v1/search` with 15-second total timeout. Send exactly one POST:

```json
{
  "q": "humanoid robot companies official website",
  "scope": "webpage",
  "size": 5,
  "includeSummary": false,
  "includeRawContent": false,
  "conciseSnippet": true
}
```

Use `Authorization: Bearer <key>`, JSON content/accept headers, and no Q&A fields. Parse JSON in memory, call `summarizeJsonShape`, serialize only the returned `JsonShape`, assert that serialization contains neither key nor query text nor `http`, and emit one line prefixed exactly `METASO_RESPONSE_SHAPE_V1=`. Do not write a fixture, report, snapshot or temp file. Any HTTP/JSON/shape failure uses a fixed safe error and does not attach a cause.

- [ ] **Step 6: Run offline tests and record GREEN**

Run:

```bash
npm test -- packages/retrieval/src/providers/metaso-shape.test.ts scripts/run-search-live-from-keychain.test.ts
npm run typecheck
npm test
npm run build
zsh -n scripts/run-search-live-from-keychain.zsh
git diff --check
```

Expected: all offline gates pass; `metaso-shape.live.test.ts` is excluded from default tests; no `security find-generic-password` or external HTTP call occurs.

- [ ] **Step 7: Commit the offline probe infrastructure**

```bash
git add packages/retrieval/src/providers/metaso-shape.ts packages/retrieval/src/providers/metaso-shape.test.ts packages/retrieval/src/providers/metaso-shape.live.test.ts scripts/run-search-live-from-keychain.zsh scripts/run-search-live-from-keychain.test.ts package.json
git commit -m "test: add safe MetaSo contract shape probe"
```

Stop and return `recommended_next_action: "await_live_probe_approval"`. Do not execute Step 8 in the same DSH task.

- [ ] **Step 8: After separate user approval, run exactly one MetaSo probe**

The main window first reports the maximum call count (`1`) and the available MetaSo pricing/credit evidence. Only after explicit approval, run:

```bash
scripts/run-search-live-from-keychain.zsh metaso-shape
```

Expected: one passing live test and one `METASO_RESPONSE_SHAPE_V1=` line containing property names and value kinds only. The DSH report may copy that one shape line but must not include environment values, HTTP headers, response values or Keychain command output. No source commit follows this measurement.

---

## Phase 1 Exit and Phase 2 Entry

Phase 1 is complete only when Tasks P2-T8A-1 through P2-T8A-5 pass review and the separately approved MetaSo shape probe has returned a usable stable URL-bearing result structure.

The main window then writes a Phase 2 plan with the exact observed MetaSo field path. Phase 2 must include:

1. a strict fixture-backed `createMetaSoProvider` implementation;
2. five-provider factory assembly for both live entry points;
3. Keychain launcher modes for the five contract smokes and full benchmark;
4. native-currency price parsing at the live entry point;
5. one reviewed contract smoke per candidate;
6. a fresh maximum-cost estimate and explicit approval before the 100-call benchmark.

No Phase 1 implementer may guess MetaSo response fields or begin provider selection.

## Final Phase 1 Verification

After the last offline commit and before requesting the live probe, run:

```bash
npm ls --depth=0
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

Expected: no invalid/unmet dependency, all offline tests pass, four Electron build outputs exist, the worktree is clean except approved ignored user files, and no live result/report file exists.
