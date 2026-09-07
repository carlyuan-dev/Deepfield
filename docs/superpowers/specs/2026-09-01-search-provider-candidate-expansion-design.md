# Deepfield Search Provider Candidate Expansion Design

**Status:** Approved in chat on 2026-09-01; written specification awaiting final review

**Extends:** `docs/superpowers/specs/2026-08-27-deepfield-tool-platform-design.md`

**Applies before:** P2-T9 live benchmark and `search_web v1` provider selection

## 0. 2026-09-07 Decision Record (current operative configuration)

- Zhipu has NO free quota and is excluded from the current product and from
  the formal candidate set. Its adapter/fixtures are removed from the codebase;
  they remain recoverable from Git history. The existing macOS Keychain entry
  is NOT deleted by this project (no `security delete`, no Keychain reads).
- **Operative benchmark candidates (canonical order):** `baidu`, `metaso`,
  `tavily`, `serper`. **Supported adapters:** `brave`, `tavily`, `serper`,
  `baidu`, `metaso`.
- Candidate env keys are the four documented names without
  `ZHIPU_SEARCH_API_KEY`; keychain services are the four
  `com.deepfield.benchmark.<candidate>` names without `zhipu`.
- Future routing intent (not implemented in this task): a renewable-free pool
  of Baidu/MetaSo/Tavily (internal order pending the benchmark) is preferred;
  Serper (free quota does not refresh) is the fixed last resort; when every
  free channel is exhausted/unavailable, stop and prompt — never auto-call a
  paid provider.
- Text below dated 2026-09-01 describing a five-candidate plan (incl. zhipu)
  is historical planning; where it conflicts with this record, this record
  wins for current configuration.

## 1. Decision Summary (HISTORICAL — 2026-09-01 decision, superseded by §0 on 2026-09-07)

This section is preserved as the historical record of the original five-candidate
plan (including Zhipu). It is NOT current configuration: Zhipu was removed
2026-09-07 and the operative benchmark is baidu/metaso/tavily/serper, 10 queries
x 1 run = 40 calls. Do not treat anything below that conflicts with §0 as operative.

1. `baidu` — Baidu Qianfan basic Baidu Search, not AI-generated search;
2. `zhipu` — Zhipu independent Web Search API, not Chat web access;
3. `metaso` — MetaSo `/api/v1/search`, not its Q&A endpoint;
4. `tavily` — existing adapter;
5. `serper` — existing adapter.

Brave remains a supported, fixture-tested adapter, but is excluded from the v1
live candidate set because obtaining a key currently requires a credit-card
subscription and the endpoint did not connect directly from the target Mac.
Exclusion from this benchmark is not deletion and does not prohibit a later
proxy-enabled comparison.

The existing `SearchProvider` contract, fixed-origin HTTP client, normalized
result schema, safe error boundary, benchmark queries, scoring weights and
human review gate remain authoritative. This change adds providers and
configuration evidence; it does not redesign the Tool Platform.

## 2. Why the Expansion Is Required

Capability A must discover companies globally while running reliably for a
China-based user. A provider that scores well in fixtures but cannot be reached
from the target machine is not a useful production choice. Conversely, a
domestic provider must not be selected merely because it is reachable: the
fixed bilingual humanoid-robot benchmark still decides recall, official-site
coverage, link validity, noise, duplication, latency and cost.

Direct unauthenticated probes on 2026-08-28 reached all three domestic
endpoints without a proxy:

- Baidu returned HTTP 401;
- Zhipu returned HTTP 401;
- MetaSo returned HTTP 200 with application error `2005` (invalid API key).

These probes establish routing only. They do not establish response-schema
compatibility, search quality or successful authentication. Those facts must
come from opt-in live contract tests using the user's local keys.

## 3. Candidate Universe and Configuration

The code must distinguish two concepts:

- **supported adapters (operative):** `brave`, `tavily`, `serper`, `baidu`,
  `metaso` (zhipu removed 2026-09-07, see §0);
- **P2-T9 v1 candidates (operative):** `baidu`, `metaso`, `tavily`, `serper`.

The live configuration must reject unknown, duplicate or fewer than two
candidates before network I/O. Every selected candidate must have a key.
Missing pricing or a missing key fails the whole run before a report is
created; it must never silently narrow the candidate set.

### 3.1 Baidu

- Endpoint: `POST https://qianfan.baidubce.com/v2/ai_search/web_search`.
- Product: basic Baidu Search only. Never call `/web_summary` or another
  generated-answer endpoint.
- Benchmark edition: `standard`.
- Request: one user message, `search_source: "baidu_search_v2"`, web-only
  `resource_type_filter`, and `top_k` equal to `maxResults`.
- Response source: `references[]`.
- Normalized mapping: `title`, `url`, `snippet` (fall back to `content` only
  when `snippet` is absent), one-based local rank, and a valid normalized date
  when present.
- Exact time range: supported through `search_filter.range.page_time` with
  `gte` and `lte`.
- Provider query limit: 72 units; each Han code point counts as two units and
  every other Unicode code point counts as one. Reject over-limit input before
  I/O; never rely on provider-side truncation.
- Authentication: the adapter uses the header confirmed by the live contract
  smoke. Because current official examples disagree between `Authorization`
  and `X-Appbuilder-Authorization`, a 401 is a contract failure requiring
  review, not an automatic second paid search attempt.
- Global-coverage rule: standard edition is used because it is the documented
  edition that supports explicit web `top_k`. If it fails the existing English
  query or reference-company coverage gates, Baidu is ineligible. The adapter
  must not silently switch to `turbo`.

### 3.2 Zhipu (REMOVED 2026-09-07 — historical record only)

Zhipu had no free quota and is removed from the current product and from the
formal candidate set (decision record §0). Its endpoint, request/response
interface, pricing and API documentation below this stub were deleted as
operative content; the adapter implementation lives on in Git history. The
Keychain entry is intentionally not deleted by this project.

### 3.3 MetaSo

- Endpoint: `POST https://metaso.cn/api/v1/search`.
- Product: Search mode only. Never call `/api/v1/chat/completions`.
- Request: `scope: "webpage"`, `size: maxResults`,
  `includeSummary: false`, `includeRawContent: false`, and
  `conciseSnippet: true`.
- Exact time range: unsupported unless a successful live response and official
  request contract prove otherwise. The first adapter version therefore
  declares `capabilities.timeRange = false`.
- Authentication: `Authorization: Bearer <key>`, injected only in the Utility
  Process.
- Contract gate: the public playground does not publish a complete successful
  response schema. Before accepting the adapter fixture, an opt-in live smoke
  must confirm the result-array path and the exact title, URL, snippet and
  optional-date fields. The fixture is a minimal synthetic reproduction of
  that confirmed shape; no live response body or page content is committed.
- If a successful response lacks a stable per-result URL, MetaSo is rejected
  from P2-T9 rather than normalized through heuristics.

### 3.4 Tavily and Serper

The existing adapters and their fixed configurations remain unchanged.
Tavily supports an exact start/end date range. Serper declares exact range
unsupported. Both must pass a fresh live contract smoke before the benchmark.

## 4. Search Results Are Discovery, Not Evidence

Provider titles and snippets are lead-generation material. They can suggest a
company, product, filing or announcement, but they are not saved as authoritative
evidence and must not be cited as if Deepfield had read the destination page.

The downstream retrieval tools must open the returned URL, apply the existing
safe-fetch and redirect rules, extract content, and attach the final reachable
URL to report claims. Provider-specific authority or relevance scores may be
retained only inside ignored benchmark diagnostics; they do not enter the
normalized `search_web` output or automatically establish trust.

## 5. Secrets and Live-Test Gate

The user has obtained keys for the operative v1 candidates. Keys remain an
external precondition and are not part of this specification or repository.

- Never paste keys into Chat, DSH messages, YAML reports or shell output.
- Never store keys in fixtures, tracked files, benchmark reports or audit
  events.
- Live tests read the four documented environment-variable names only:
  `BAIDU_SEARCH_API_KEY`, `METASO_SEARCH_API_KEY`, `TAVILY_API_KEY`, and
  `SERPER_API_KEY`.
- The live entry point must resolve and validate the complete candidate/key
  set before the first HTTP request.
- Provider errors and malformed responses cross the boundary only as the
  existing stable `SearchProviderError` codes and fixed messages.
- Production stores only the finally selected provider key through the
  existing encrypted settings design. Benchmark-only keys are not imported
  into project data.

## 6. Currency-Neutral Cost Evidence

The current benchmark accepts only `pricingUsd`, which is insufficient when
providers publish CNY prices. Replace that input with a per-provider immutable
price record:

```ts
interface ProviderPrice {
  amountPerRequest: number;
  currency: "CNY" | "USD";
  usdPerCurrencyUnit: number;
  priceSourceUrl: string;
  priceObservedOn: string; // YYYY-MM-DD
  exchangeRateSourceUrl?: string;
  exchangeRateObservedOn?: string; // YYYY-MM-DD
}
```

`amountPerRequest` and the source currency are preserved in the report.
Scoring uses `amountPerRequest * usdPerCurrencyUnit`; USD records use a rate of
`1`. The CNY-to-USD rate is a benchmark input recorded with its own source and
observation date. No network price or exchange-rate lookup occurs during a
run, preserving determinism. If a provider charges credits rather than a
published per-request currency amount, the recorded amount must be derived
from the user's purchased-credit price and documented formula before that
provider can enter the benchmark.

Before any live request, every selected provider must have a finite,
non-negative price record, a valid price source URL and observation date, and
a positive finite conversion rate. A CNY record requires both exchange-rate
fields; a USD record requires a conversion rate of exactly `1` and forbids
those fields. The report records the pricing evidence but never a key.

## 7. Live Validation Sequence

Live validation is deliberately split from the full benchmark:

1. Resolve exactly the operative four v1 candidates, four keys and four
   price records (zhipu removed per §0).
2. Run one inexpensive contract query per provider.
3. Validate status, response bounds and the strict documented result shape.
4. Stop on API drift, authentication failure or a missing URL field; update a
   reviewed fixture and adapter before continuing.
5. Freeze the final benchmark candidate set. Removing a failed candidate
   requires an explicit reviewed exclusion record; the code must never narrow
   the set automatically.
6. Present the exact maximum provider-call count and estimated spend, and
   obtain fresh user approval before making the full paid run.
7. Run the frozen ten-query benchmark twice per query with top 20.
8. Produce the existing ambiguous classification queue and pause for human
   review.
9. Apply the existing hard gates and select exactly one eligible provider.

Contract smokes and benchmark calls are separately reported so a schema test
cannot be mistaken for a quality measurement. An interrupted or partial run
cannot select a provider. With the operative four candidates, the next full run is 10 queries x 1 run =
40 provider search calls plus the four one-query contract smokes (the earlier
five-candidate plan counted 100 calls; superseded by §0). No such calls occur
while writing or implementing the offline expansion.

## 8. Failure and Eligibility Rules

All existing P2-T8 hard gates remain. Additionally:

- a provider that cannot authenticate with its documented key is incomplete;
- a provider that cannot return stable HTTP(S) result URLs is ineligible;
- a provider that silently truncates or rewrites an over-limit query fails its
  adapter contract;
- a provider with only generated answers and no independent result array is
  ineligible;
- a provider may be individually ineligible without poisoning complete runs
  from other candidates;
- at least two providers must complete the full benchmark and pass every hard
  gate, or P2-T9 remains blocked and `search_web v1` is not registered.

## 9. Scope Boundaries

This expansion does not add:

- automatic provider failover or provider blending;
- runtime selection among multiple search providers;
- proxy support for Brave;
- generated search answers;
- provider full-page-content options;
- storage of raw live responses;
- automatic purchase, subscription or account creation;
- production storage of all benchmark keys;
- changes to Capability A fields, report generation or the Chat UI.

The outcome remains one measured, encrypted-key-backed provider registered as
`search_web v1`.

## 10. Required Plan Change

The existing P2 plan is amended by inserting a separately reviewable
**P2-T8A: Domestic Candidate and Pricing Expansion** before P2-T9. P2-T8A
delivered the Baidu, Zhipu and MetaSo adapters and the five-candidate live config (historical execution record; superseded by §0),
currency-neutral pricing evidence and offline/live contract tests. It does not
select a winner.

P2-T9 historically ran a five-candidate live benchmark plan (superseded by §0: operative benchmark is the four candidates x 10 x 1 = 40 calls), pauses for the existing
human annotation review, applies hard gates, records the selection and
configures only the winning provider.

## 11. Primary Sources

- Baidu basic search API: <https://cloud.baidu.com/doc/qianfan/s/2mh4su4uy>
- Baidu basic search pricing: <https://cloud.baidu.com/doc/qianfan/s/1mh4sv6c4>
- MetaSo API playground: <https://metaso.cn/search-api/playground>
