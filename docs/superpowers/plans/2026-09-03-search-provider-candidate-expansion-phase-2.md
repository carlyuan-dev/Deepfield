# Search Provider Candidate Expansion Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Current State (2026-09-07, operative)

- Zhipu is REMOVED from the current product and formal candidates (decision:
  no free quota). Tasks T8A-7/T8A-9 below were executed and reviewed against the
  historical five-candidate set and are therefore SUPERSEDED as current
  configuration — they remain as an accurate record of what was run.
- **Operative candidate order:** `baidu,metaso,tavily,serper`; supported
  adapters are `brave,tavily,serper,baidu,metaso`. Candidate env keys and
  Keychain services exclude Zhipu. Adapter/fixture code for Zhipu is deleted
  but recoverable from Git history; the Keychain entry is not deleted.
- **Future routing intent (not implemented here):** renewable-free pool =
  Baidu/MetaSo/Tavily (internal order pending the benchmark); Serper (free
  quota does not refresh) is the fixed last resort; stop-and-prompt when all
  free channels are exhausted — never auto-call a paid provider.
- **Next benchmark (task T8A-10 onward):** four candidates x ten queries x
  one run = 40 provider calls; the historical 100-call / five-provider text
  below is superseded.

**Goal (historical five-candidate plan, superseded for current state):** Convert the observed MetaSo response contract into a strict adapter, assemble the approved search candidates behind the existing live boundaries, and complete reviewed one-call contract smokes before requesting approval for the live benchmark.

**Architecture (operative, per 2026-09-07 decision):** Keep the accepted `SearchProvider` and fixed-origin `ProviderHttpClient` contracts unchanged. The immutable endpoint/factory assembly covers the four candidates `baidu,metaso,tavily,serper` (Zhipu removed). The Keychain launcher has closed, explicit modes and resolves the four keys and four native-currency price records before the first request. Live contract smokes and the later benchmark remain separate user-approved operations.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest 4, zsh, macOS Keychain, existing `@deepfield/retrieval` provider and benchmark infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-01-search-provider-candidate-expansion-design.md`

## Observed MetaSo Contract Gate

The separately approved one-call probe ran once on 2026-09-03 and returned a value-free shape. This is the only live fact this plan may use:

```text
root.webpages: array
root.webpages[].title: string
root.webpages[].link: string
root.webpages[].snippet: string
root.webpages[].date: string
root.webpages[].position: number
root.webpages[].score: string
root.credits: number
root.total: number
root.searchParameters: object
```

The adapter maps only `title`, `link`, `snippet`, and a valid date. It assigns local one-based ranks and ignores `position`, `score`, `credits`, `total`, and `searchParameters`. The ignored fields are provider diagnostics, not evidence and not normalized output.

## Global Constraints

- **Operative** live candidate order is exactly `baidu,metaso,tavily,serper`; Brave remains supported but is not a candidate. (Historical text below that mentions `zhipu` records the earlier five-candidate state and is superseded.)
- Use MetaSo `POST https://metaso.cn/api/v1/search`; never call `/api/v1/chat/completions` or any generated-answer endpoint.
- MetaSo request fields are exactly `q`, `scope: "webpage"`, `size`, `includeSummary: false`, `includeRawContent: false`, and `conciseSnippet: true`.
- Use one `Authorization: Bearer <key>` header for MetaSo. Use one `authorization` Bearer header for the first Baidu contract smoke; a 401 stops the gate and never triggers an automatic second-header attempt.
- Every selected candidate, Keychain key, and native-currency price record must resolve before the first contract or benchmark HTTP request.
- No live response body, title, URL, snippet, page content, request header, API key, or Keychain output may be committed or copied into a DSH report.
- Default `npm test` must never run `*.live.test.ts`; every live operation requires a separate explicit user approval with a maximum call count.
- Provider contract smokes use at most the operative candidate count (four) provider-search calls (the overseas scope restricts to tavily+serper), stop at the first failed test, and never retry automatically.
- **Superseded benchmark arithmetic (five providers x ten queries x two runs = 100 calls).** Operative: four providers x ten queries x one run = 40 calls; the benchmark is outside the implementation tasks and requires a fresh cost estimate and approval.
- No automatic provider failover, blending, proxy support, generated search answer, full-page provider option, runtime multi-provider selection, or Capability/UI change is added.
- Production and test TypeScript files should stay below 300 lines. Split by responsibility before exceeding the limit.
- Do not read, modify, stage, delete, or commit `docs/Deepfield项目开发教程-临时学习版.md`.

---

### Task P2-T8A-6: Strict Fixture-Backed MetaSo Adapter

**Files:**
- Create: `packages/retrieval/src/providers/metaso.ts`
- Create: `packages/retrieval/src/providers/metaso.test.ts`
- Create: `packages/retrieval/src/providers/metaso-boundaries.test.ts`
- Create: `packages/retrieval/src/providers/fixtures/metaso-success.json`
- Create: `packages/retrieval/src/providers/fixtures/metaso-zero.json`
- Modify: `packages/retrieval/src/index.ts`

**Interfaces:**
- Consumes: `ProviderHttpClient`, `ProviderEndpoint`, `SearchProvider`, `SearchRequest`, `NormalizedSearchResponse`, `SearchProviderError`, `assertValidSearchRequest`, `isValidDateString`, and `normalizeSearchResults`.
- Produces:

```ts
export const METASO_ENDPOINT: ProviderEndpoint;

export interface MetaSoProviderDeps {
  client: ProviderHttpClient;
  token: string;
}

export function createMetaSoProvider(deps: MetaSoProviderDeps): SearchProvider;
```

- `SearchProvider.id` is `metaso`; `capabilities.timeRange` is `false`.

- [ ] **Step 1: Add minimal synthetic fixtures from the observed shape**

Create `metaso-success.json` with two synthetic `webpages` entries. Include `title`, HTTPS `link`, `snippet`, `date`, `position`, and string `score`, plus synthetic `credits`, `total`, and `searchParameters`. Use only `.example` URLs and invented text; do not reconstruct or paste live values. Create `metaso-zero.json` with an empty `webpages` array and synthetic top-level metadata.

- [ ] **Step 2: Write failing request and mapping tests**

In `metaso.test.ts`, use the existing scripted `ProviderTransport` pattern. Assert:

```ts
expect(METASO_ENDPOINT).toEqual({
  origin: "https://metaso.cn",
  pathPrefix: "/api/v1/search",
});

expect(JSON.parse(request.body!)).toEqual({
  q: "人形机器人 公司",
  scope: "webpage",
  size: 20,
  includeSummary: false,
  includeRawContent: false,
  conciseSnippet: true,
});
```

Assert exactly one POST, JSON accept/content headers, exactly one `authorization` header, no token in the body, and no Q&A/raw-content/summary request mode. Assert the success fixture becomes normalized results with local ranks `1,2`; a valid leading `YYYY-MM-DD` is retained, an invalid date is omitted, and `position`, `score`, `credits`, `total`, and `searchParameters` never enter serialized output. Assert zero results for `metaso-zero.json`.

- [ ] **Step 3: Write failing boundary and failure tests**

Cover endpoint mismatch, blank token, supplied `timeRange`, malformed JSON, null/array/primitive roots, missing or non-array `webpages`, null/array/primitive result entries, non-string `title`/`link`/`snippet`, dangerous URL, 401, 429 with bounded Retry-After, 5xx, pre-abort, and a provider body containing a distinctive test secret. Assert all failures are stable `SearchProviderError` values, never native `TypeError`, never contain the token/raw body/test secret, and never attach a raw cause. A rejected `timeRange` must make zero transport calls.

- [ ] **Step 4: Run the adapter tests and record RED**

```bash
npm test -- packages/retrieval/src/providers/metaso.test.ts packages/retrieval/src/providers/metaso-boundaries.test.ts
```

Expected: FAIL because `./metaso.js` does not exist. Record the exact missing-module failure before implementation.

- [ ] **Step 5: Implement the minimal MetaSo adapter**

Bind `METASO_ENDPOINT` at factory construction and reject a blank token with `SearchProviderError("invalid_request")`. In `search`, call `assertValidSearchRequest`, reject any `timeRange` before I/O, send the exact request body, parse one bounded JSON response in memory, require a non-null non-array root and `webpages` array, and require each entry to be a non-null non-array object before reading fields.

Map only:

```ts
{
  title: result.title,
  url: result.link,
  snippet: result.snippet,
  ...(validDate !== undefined ? { date: validDate } : {}),
}
```

Delegate title/snippet/URL/rank/count validation to `normalizeSearchResults`. Normalize a date only when its first ten characters pass `isValidDateString`. Do not read or copy provider position, score, credits, totals, echoed search parameters, or unknown fields.

- [ ] **Step 6: Run GREEN and regression gates**

```bash
npm test -- packages/retrieval/src/providers/metaso.test.ts packages/retrieval/src/providers/metaso-boundaries.test.ts
npm test -- packages/retrieval/src/providers/provider-contract.test.ts packages/retrieval/src/search-provider.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npm ls --depth=0
```

Expected: all offline tests pass; no `*.live.test.ts`, Keychain command, DNS request, or external HTTP request runs.

- [ ] **Step 7: Commit Task P2-T8A-6**

```bash
git add packages/retrieval/src/providers/metaso.ts packages/retrieval/src/providers/metaso.test.ts packages/retrieval/src/providers/metaso-boundaries.test.ts packages/retrieval/src/providers/fixtures/metaso-success.json packages/retrieval/src/providers/fixtures/metaso-zero.json packages/retrieval/src/index.ts
git commit -m "feat: add strict MetaSo search adapter"
```

Stop for main-window review. Do not start Task P2-T8A-7 in the same DSH task.

---

### Task P2-T8A-7: Immutable Five-Provider Live Assembly (EXECUTED, historical: five candidates — SUPERSEDED by 2026-09-07 four-candidate decision)

**Files:**
- Create: `packages/retrieval/src/providers/live-provider-assembly.ts`
- Create: `packages/retrieval/src/providers/live-provider-assembly.test.ts`
- Modify: `packages/retrieval/src/providers/provider-contract.live.test.ts`
- Modify: `packages/retrieval/src/benchmark/search-benchmark.live.test.ts`
- Modify: `packages/retrieval/src/index.ts`

**Interfaces:**
- Consumes: the five adapter factories and endpoints, `BENCHMARK_CANDIDATES_V1`, `requireBenchmarkCandidateAssembly`, `ProviderHttpClient`, and `SearchProvider`.
- Produces:

```ts
export type LiveProviderFactory = (
  client: ProviderHttpClient,
  token: string,
) => SearchProvider;

export const LIVE_PROVIDER_ENDPOINTS:
  Readonly<Record<LiveProviderId, ProviderEndpoint>>;

export const LIVE_PROVIDER_FACTORIES:
  Readonly<Record<LiveProviderId, LiveProviderFactory>>;

export interface LiveProviderSetup {
  readonly providers: readonly LiveProviderId[];
  readonly tokens: Readonly<Record<LiveProviderId, string>>;
  readonly pricing: Readonly<Record<LiveProviderId, ProviderPrice>>;
}

export function resolveLiveProviderSetup(
  env: Record<string, string | undefined>,
): LiveProviderSetup;
```

- Baidu is bound to the explicit `authorization` header for its first contract smoke. No factory performs retries or fallback.

- [ ] **Step 1: Write failing assembly tests**

Assert both exported records have exactly the candidate keys in canonical order, have null prototypes, are frozen, omit Brave, and contain no undefined/placeholder entries. For every candidate, construct a `ProviderHttpClient` with its exact endpoint and call the factory with a synthetic token; assert the returned provider ID matches the key. Assert capabilities are `true` for Baidu/Tavily and `false` for Zhipu/MetaSo/Serper. Assert the Baidu factory emits only the selected `authorization` header in its existing offline request test path.

For `resolveLiveProviderSetup`, pass a complete synthetic environment and assert canonical frozen providers, frozen null-prototype tokens, and frozen native-currency price records. Test missing/extra provider selection, every missing/blank key, missing/malformed/partial/extra pricing, and a pricing record accessor whose getter would throw a distinctive secret. Every failure must occur inside setup, use a fixed sanitized message, and never execute a factory or getter.

- [ ] **Step 2: Run assembly RED**

```bash
npm test -- packages/retrieval/src/providers/live-provider-assembly.test.ts
```

Expected: FAIL because `live-provider-assembly.ts` does not exist.

- [ ] **Step 3: Implement one shared immutable assembly**

Create partial maps from the six supported adapters, then pass them through `requireBenchmarkCandidateAssembly`. The resulting exported maps contain exactly the five benchmark candidates. Bind factories as follows:

```ts
baidu: (client, token) => createBaiduProvider({
  client,
  token,
  authHeader: "authorization",
}),
zhipu: (client, token) => createZhipuProvider({ client, token }),
metaso: (client, token) => createMetaSoProvider({ client, token }),
tavily: (client, token) => createTavilyProvider({ client, token }),
serper: (client, token) => createSerperProvider({ client, token }),
```

Do not duplicate endpoints or factories in either live test after this task.

Implement `resolveLiveProviderSetup` in this non-live module as the single pre-I/O boundary:

```ts
const run = resolveLiveRun(env);
const pricing = parseProviderPricingJson(
  ownDataEnvironmentValue(env, "DEEPFIELD_SEARCH_PRICING"),
  run.providers,
);
return Object.freeze({
  providers: Object.freeze([...run.providers]),
  tokens: run.tokens,
  pricing,
});
```

Use this private helper signature:

```ts
function ownDataEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined;
```

Read `DEEPFIELD_SEARCH_PRICING` through an own data-property descriptor, consistent with the existing key boundary; inherited/accessor values are treated as missing and the getter never executes. Do not copy environment values into an error.

- [ ] **Step 4: Replace both incomplete Phase 1 live maps**

In `provider-contract.live.test.ts`, import `LIVE_PROVIDER_ENDPOINTS`, `LIVE_PROVIDER_FACTORIES`, and `resolveLiveProviderSetup`. At module setup, call:

```ts
const SETUP = resolveLiveProviderSetup(
  process.env as Record<string, string | undefined>,
);
```

before constructing a transport or entering a test body. Build probes only from `SETUP.providers`, `SETUP.tokens`, and the shared factories. Pricing need not be logged; resolving it here enforces complete evidence before the first live request.

In `search-benchmark.live.test.ts`, call the same `resolveLiveProviderSetup` and pass `SETUP.pricing` to `runBenchmark`. Preserve its 20-second client timeout, benchmark harness, report writer, and link checker. Remove the obsolete incomplete-assembly literals/comments and the duplicate `loadPricing` function.

- [ ] **Step 5: Add a static live-entry regression test**

Read both live entry source files as text in `live-provider-assembly.test.ts`. For each file, assert it imports `resolveLiveProviderSetup`, `LIVE_PROVIDER_ENDPOINTS`, and `LIVE_PROVIDER_FACTORIES`; assert it does not contain local declarations named `ENDPOINTS`, `FACTORIES`, or `loadPricing`. Assert the first textual occurrence of `resolveLiveProviderSetup(` precedes the first occurrence of `new ProviderHttpClient(`. This is an offline structural test; never import a live test module under default Vitest.

- [ ] **Step 6: Run GREEN and regression gates**

```bash
npm test -- packages/retrieval/src/providers/live-provider-assembly.test.ts packages/retrieval/src/providers/provider-catalog.test.ts packages/retrieval/src/providers/live-config.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npm ls --depth=0
```

Expected: all offline tests pass and both live files compile, but no live test runs and no environment key is required by the default suite.

- [ ] **Step 7: Commit Task P2-T8A-7**

```bash
git add packages/retrieval/src/providers/live-provider-assembly.ts packages/retrieval/src/providers/live-provider-assembly.test.ts packages/retrieval/src/providers/provider-contract.live.test.ts packages/retrieval/src/benchmark/search-benchmark.live.test.ts packages/retrieval/src/index.ts
git commit -m "feat: assemble five live search candidates"
```

Stop for main-window review. Do not run a provider contract smoke.

---

### Task P2-T8A-8: Fail-Closed Keychain Modes and Pricing Gate

**Files:**
- Modify: `scripts/run-search-live-from-keychain.zsh`
- Create: `scripts/run-search-live-from-keychain-test-helpers.ts`
- Modify: `scripts/run-search-live-from-keychain.test.ts`
- Create: `scripts/run-search-live-from-keychain-modes.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the five `KEYCHAIN_SERVICES`, their corresponding environment variable names, and caller-provided non-secret `DEEPFIELD_SEARCH_PRICING` JSON.
- Produces exactly three allowlisted launcher modes:

```text
metaso-shape       -> existing one-call shape test, retained for audit only
provider-contract  -> at most one-query provider contract tests over the operative candidates (historical T8A-8 text said five; operative is four)
search-benchmark   -> the separately approved benchmark (historical text: 100 calls; operative: 40 calls — 10 queries x 1 run)
```

- `provider-contract` and `search-benchmark` export the candidate keys plus `DEEPFIELD_SEARCH_PROVIDERS` to the child (historical T8A-8 text named five keys incl. zhipu; operative per the 2026-09-07 decision is four: baidu/metaso/tavily/serper). Both require a non-blank `DEEPFIELD_SEARCH_PRICING`; neither parses or prints it in zsh—the live TypeScript boundary performs strict parsing.

- [ ] **Step 1: Split the existing launcher test support before adding cases**

Move temporary sandbox/fake executable construction into `run-search-live-from-keychain-test-helpers.ts`. Keep tests value-free: fake `security` and fake `npm` write only invocation counts and `pass`/`fail` markers. They must never write a fake secret or pricing JSON to stdout, stderr, or assertion files.

- [ ] **Step 2: Write failing allowlist and preflight tests**

Assert missing, unknown, and extra arguments fail before `security` or `npm`. Assert `provider-contract` and `search-benchmark` reject missing/blank `DEEPFIELD_SEARCH_PRICING` before the first Keychain read. Assert the existing `metaso-shape` mode still retrieves only the MetaSo service and invokes only `npm run test:metaso-shape:live`.

- [ ] **Step 3: Write failing five-key and exact-child tests**

For both new modes, fake `security` must verify exactly one call for each account/service pair:

```text
deepfield / com.deepfield.benchmark.baidu
deepfield / com.deepfield.benchmark.zhipu
deepfield / com.deepfield.benchmark.metaso
deepfield / com.deepfield.benchmark.tavily
deepfield / com.deepfield.benchmark.serper
```

Fake `npm` compares, without printing values, that all five child environment keys equal their corresponding fake Keychain values, the provider list is exact, and the inherited pricing JSON is byte-for-byte unchanged. Assert exact argv:

```text
provider-contract -> npm run test:providers:live
search-benchmark  -> npm run benchmark:search
```

For each of the five services, test a missing, command-failed, empty, and whitespace-only result. The launcher must exit nonzero before npm; no later Keychain service should be queried after the first failure; stdout/stderr/markers must contain no fake secret.

- [ ] **Step 4: Run launcher RED**

```bash
npm test -- scripts/run-search-live-from-keychain.test.ts scripts/run-search-live-from-keychain-modes.test.ts
```

Expected: the new modes fail because the launcher currently accepts only `metaso-shape`.

- [ ] **Step 5: Implement the minimal zsh mode dispatcher**

Keep `set -euo pipefail`, `set +x`, and `unset HISTFILE`. Validate mode/argument count first. For the two new modes, validate pricing presence before any `security` command, retrieve each service with the explicit command form, reject blank values silently, export the exact environment names and provider list, then use `exec npm run ...`. Do not use `eval`, indirect shell execution, glob-derived service names, or a loop that constructs an unvalidated Keychain service.

Change the contract script to stop after the first failed provider test:

```json
"test:providers:live": "vitest run --bail=1 --config vitest.live.config.ts packages/retrieval/src/providers/provider-contract.live.test.ts"
```

Do not add retries to either live script.

- [ ] **Step 6: Run GREEN and offline safety gates**

```bash
npm test -- scripts/run-search-live-from-keychain.test.ts scripts/run-search-live-from-keychain-modes.test.ts
zsh -n scripts/run-search-live-from-keychain.zsh
npm run typecheck
npm test
npm run build
git diff --check
npm ls --depth=0
```

Expected: all tests pass using fake executables; no real `security` invocation, DNS request, provider request, or live test occurs. Confirm the launcher remains mode `100755`.

- [ ] **Step 7: Commit Task P2-T8A-8**

```bash
git add scripts/run-search-live-from-keychain.zsh scripts/run-search-live-from-keychain-test-helpers.ts scripts/run-search-live-from-keychain.test.ts scripts/run-search-live-from-keychain-modes.test.ts package.json
git commit -m "feat: add fail-closed live search launch modes"
```

Stop for main-window review. Do not run either new mode.

---

### Task P2-T8A-9: Five-Provider Contract Smoke Gate (EXECUTED, historical: five candidates — SUPERSEDED by 2026-09-07 decision; current contract scope resolves baidu/metaso/tavily/serper, overseas tavily+serper)

**Files:**
- No tracked file changes.
- No fixture is generated from live output.

**Interfaces:**
- Consumes: five Keychain API keys and one valid `DEEPFIELD_SEARCH_PRICING` JSON object containing exactly the five native-currency records.
- Produces: reviewed pass/fail status and schema compatibility for each candidate; never a persisted provider response.

- [ ] **Step 1: Prepare and validate price evidence without network I/O**

The main window obtains current official price-source URLs and observation dates. CNY records include one explicit CNY-to-USD rate, source URL, and observation date. A credit-based MetaSo price is derived from the user's purchased-credit price and documented credit formula. Construct the five-record JSON in memory and run only the existing `parseProviderPricingJson` boundary with the exact candidate list. Do not put API keys in this object.

If any provider lacks a finite per-request amount and source evidence, stop with `P2-T8A-9` blocked. Do not substitute zero for an unknown price and do not run a contract request.

- [ ] **Step 2: Present the contract-smoke authorization gate**

Report to the user:

```text
maximum provider calls: 5
per-provider maximum: 1
automatic retries: 0
stop-on-first-failure: yes
maximum native spend: one separately stated amount per provider in that provider's source currency
maximum converted USD spend: sum(amountPerRequest * usdPerCurrencyUnit)
```

Obtain explicit approval immediately before execution. Prior approval for the MetaSo shape probe or the later benchmark (operative 40 calls) does not count.

- [ ] **Step 3: Run the allowlisted contract mode exactly once**

With the validated non-secret pricing JSON in `DEEPFIELD_SEARCH_PRICING`, run:

```bash
scripts/run-search-live-from-keychain.zsh provider-contract
```

Do not rerun on any failure. `--bail=1` ensures later providers are not called after a failed test.

- [ ] **Step 4: Review the five contract outcomes**

For each candidate, record only provider ID, pass/fail, stable error code, and whether normalized results contain HTTP(S) URLs. Do not copy response values. Confirm exactly one auth header and one request per executed provider from test assertions, not logs.

If Baidu returns 401, stop; do not try `x-appbuilder-authorization` without a separately reviewed fixture/code change and new user approval. If any provider has schema drift, change its synthetic fixture and adapter through a new TDD task, then request a fresh maximum-one-call approval for only that failed provider. Never weaken validation at the live-test layer.

- [ ] **Step 5: Verify no repository side effects**

```bash
git diff --check
git status --short
test ! -d benchmark-results
```

Expected: no tracked changes and no benchmark output. The only permitted status entry is the pre-existing untracked user tutorial file.

Stop for main-window review. A successful five-provider contract gate completes P2-T8A Phase 2 implementation; it does not authorize the benchmark.

---

### Task P2-T8A-10: Fresh Benchmark Cost and Approval Gate (operative: FOUR candidates, 10 queries x 1 run = 40 calls)

**Files:**
- No tracked file changes.
- This task does not execute the benchmark.

**Interfaces:**
- Consumes: the same validated four-provider pricing records and four successful reviewed contract outcomes (historical five-provider runs are not part of the new count).
- Produces: a concrete maximum-cost statement and an explicit user decision for original P2-T9.

- [ ] **Step 1: Revalidate benchmark preconditions offline**

Confirm the candidate set is still exactly `baidu,metaso,tavily,serper`, all four contract smokes passed, the query set contains exactly ten queries, `runsPerQuery` is `1`, `maxResults` is `20`, and every price record is still valid for its observation date. Confirm `benchmark-results/` is absent or contains no prior run that could be mistaken for the new run.

- [ ] **Step 2: Calculate the maximum search-provider spend**

Each provider receives `10 × 1 = 10` search calls. Report per-provider native maximum:

```text
providerMaximumNative = 10 * amountPerRequest
```

Report the common converted maximum without rounding inside the calculation (single-run fallback price per provider):

```text
maximumUsd = 10 * sum(amountPerRequest * usdPerCurrencyUnit)
```

List the price and exchange-rate source URLs and observation dates. Keep the already completed contract-smoke calls separate from the 40-call estimate. Expected cash spend is 0: if the free-quota/balance precondition check fails, stop and prompt the user — never auto-call a paid provider. Destination-page link checks may generate additional ordinary web requests but are not provider-search API calls.

- [ ] **Step 3: Obtain a new explicit benchmark approval**

State exactly:

```text
maximum provider-search calls: 40
automatic provider retries: 0
queries: 10
runs per query: 1
providers: 4
top results requested: 20
```

Ask the user to approve or reject the run. Do not run `search-benchmark`, create `benchmark-results/`, or begin provider selection in this task. If approved, resume original P2-T9 at its live benchmark execution step using the operative four-candidate rules (baidu/metaso/tavily/serper; Zhipu removed 2026-09-07) from the approved expansion specification decision record.

---

## Plan Self-Review Checklist

- [x] Every observed MetaSo field used by the adapter is listed; every ignored diagnostic field is explicitly excluded.
- [x] Both live entry points consume one shared complete assembly.
- [x] Four keys and four price records fail closed before transport construction.
- [x] Default tests remain offline and live calls have separate user gates.
- [x] Contract smokes are capped at the operative candidate count (four) with no retry and first-failure bail.
- [x] The benchmark is not executed until a fresh 40-call cost approval (10 queries x 1 run, retries 0, top 20).
- [x] No task changes Capability A, Chat UI, provider failover, or production multi-provider behavior.
- [x] No task reads or stages the untracked user tutorial document.
