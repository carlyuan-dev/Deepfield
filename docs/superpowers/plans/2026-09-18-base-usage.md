# Base.Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Follow the assigned task brief and approved design; controller reviews each task.

**Goal:** Automatically record observable LLM/Search usage and display a simple Settings dashboard.

**Architecture:** Business-independent `@deepfield/base/usage` defines records, validation, queries and ports. SQLite and process transport are injected through existing application initialization, not a new architecture layer. Unified model/search adapters collect attempts; Settings is a read-only projection.

**Tech Stack:** Existing TypeScript/TypeBox, Node SQLite, React, Vitest, Electron; no new third-party runtime library required.

**Spec:** `docs/base/base.overview.设计文档.md` and `docs/base/base.usage.设计文档.md` (read both).

## Global Constraints

- Work only in `/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering`, branch `codex/chat-markdown-rendering`. Preserve all pre-existing dirty/untracked work. No commit/push or destructive cleanup requested.
- No live paid/model/search calls, credential output, user database edits, or ad-hoc Electron launch. Controller owns packaging and normal native app smoke.
- Base must not import apps, business contracts/application/repositories or UI. Infrastructure implements Base ports. No unnecessary relocation of existing modules.
- Records retain Profile ID and call-time non-secret configuration snapshots. No keys, prompts, queries, completions or raw error bodies stored.
- Null is unknown, not zero. Cache token subsets are never counted twice. Retries count attempts; streaming snapshots and message redelivery do not.
- LLM dashboard groups Provider → model; Search groups Provider. No Profile/source filters or individual-attempt UI. No price/credit/remaining quota calculations.
- Record failure is non-fatal to the business request but visible as usage-health degradation. No fabricated completeness or pre-feature backfill.
- Focused TDD and relevant regressions, not repeated full-suite runs. Each implementer self-reviews and supplies task-only diff + report; no child agents.

## Shared interface and handoff

Task 1 owns exported contracts and publishes `interfaces.md` with exact signatures before Tasks 2/3. Use these names so consumers converge:

```ts
type UsageServiceKind = 'llm' | 'search';
type UsageRange = 'month' | '7d' | '30d';
interface UsageDashboardQuery { serviceKind: UsageServiceKind; range: UsageRange; timeZone: string }
// All response fields below are typed, not any/unknown, in Task 1:
// UsageDashboard = { summary, daily, providers, health, from, to, timeZone }
// providers contain aggregate metrics and models[] for LLM; no profile list.
interface UsageDashboardApi { getDashboard(query: UsageDashboardQuery): Promise<UsageDashboard> }
// DesktopApi gains usage: UsageDashboardApi in Task 2.
// recordStart/recordFinish consume validated typed call-time snapshots,
// nullable token metrics and attempt/operation IDs, never runtime secrets.
```

Public record fields, outcomes, metrics and revision rules follow spec §3. Query/service types live in Base; outward IPC contracts may depend on Base, never the reverse. Task 1 determines exact repository signatures and response metric names, documents them, and must not leave unresolved interfaces for the parallel tasks.

### Task 1: Base contracts, durable ledger and aggregation

**Files:** Create `packages/base/package.json`, `packages/base/src/usage/{index,contracts,service,query}.ts` and focused tests, `packages/base/src/architecture.test.ts`; small extra date helper allowed. Modify root tsconfig/workspace lock only as needed for local package resolution. Create `packages/persistence/src/usage-repository.ts` + tests; modify migrations and persistence public export. Do not add usage to all business repository fixtures: expose a separate factory taking the existing DatabaseSync.

**Produces:** Public Usage record/schema/recorder/repository/dashboard contracts; SQLite repository factory; lifecycle health persistence; typed query and aggregation API. Consumer handoff `interfaces.md` in this plan's scratch directory.

- [ ] Capture task baseline before edits. Write failing tests for finite integer/null metrics, secret-field rejection, duplicate finish and finish-before-start, stale revisions, profile/model snapshot stability, and restart interruption.
- [ ] Implement append/upsert attempt ledger, explicit initialization/clean-close state and independent migrations; no foreign keys cascading from business records. Enforce runtime whitelists and immutable identity/config snapshot semantics. Same attempt completion cannot become running again.
- [ ] Implement summary/daily/provider/model aggregation with nullable sums plus unknown/partial counts; exact range/date behavior. Do not invent zero when no known measurements exist. Empty data vs pre-feature time explicit. Define known input/output/cache normalization invariants in schema helpers; protocol-specific mapping remains Task 2.
- [ ] Tests use actual in-memory SQLite and UTC/Asia-Shanghai/DST fixture dates, not user DB. Example assertions:
```ts
expect(summary.requests).toBe(2); // duplicate delivery did not add a third
expect(summary.inputTokens).toBe(100); // input 100 includes cacheRead 60
expect(summary.unknownUsageRequests).toBe(1);
expect(providers[0].models).toHaveLength(1); // two profiles same provider/model
```
- [ ] Dependency test rejects forbidden imports including transitive re-exports and dynamic imports; keep checks focused and whitelist only actual neutral dependencies.
- [ ] Run `npx --no-install vitest run packages/base packages/persistence/src/usage-repository.test.ts` and `npm run typecheck`; write report, exact interface handoff, task-only diff against baseline. Freeze for review before further task dispatch.

### Task 2: Unified collection and application wiring

**Files:** Existing model gateway + direct service helpers, pi-chat-agent stream setup, search factory/HTTP request boundary, configured diagnostics, ProfileStore/runtime snapshots, main/worker initialization and transport/host files, contracts IPC/worker schemas, main IPC and preload API. Create focused `usage-*` helper files near main/shared/worker as needed. Own shared non-renderer test fixtures needed for new API; do not edit renderer files (Task 3 ownership). Update package lock only through controller coordination if needed.

**Consumes:** Task 1 exact `interfaces.md` and APIs. **Produces:** `DesktopApi.usage.getDashboard(query)` bridge plus automatic collection for every current runtime path. New renderer fake usage API belongs to Task 3.

- [ ] Snapshot task-owned files; read SDK source to identify authoritative raw usage and retry behavior before code. Write failing tests for direct and streamed generation, cache usage and omitted usage, retry and cancel.
- [ ] Collect at model generation/transport boundaries, not UI events or final business results. Preserve stream events/backpressure/cancellation. Cover title, recognition, profile enrichment, raw research, structured research and repair, connection checks and draft diagnostics. Distinguish default SDK zero from explicitly reported zero. No historical mapped-message usage may enter collector.
- [ ] Normalize protocol token counters as spec requires. Disable or individually observe SDK hidden retries without silently changing business retry contracts; report any uncertainty. Each observable attempt gets unique ID, each stream terminal snapshot updates same attempt.
- [ ] Search collection covers Settings diagnosis and worker tools, counts HTTP200 application errors correctly, skips local validation/budget/security rejection and cache reuse, records network failures reaching transport. No wrapper changes provider response values/provenance.
- [ ] Generate opaque non-secret configuration revision IDs on actual saved configuration changes, including key changes; no key-derived hash in ledger. Draft contexts retain separate transient identity. Existing profile compatibility preserved.
- [ ] Wire main-only SQLite writer, validated Worker usage transport with acknowledgement/bounded retry/flush and interruption recovery. Payloads whitelist fields before crossing process boundary; failure health visible; do not let recorder throws abort business work. No unbounded queue.
- [ ] Add validated read-only IPC/preload dashboard endpoint. Example integration expectations:
```ts
expect(await api.usage.getDashboard({ serviceKind:'search', range:'month', timeZone:'Asia/Shanghai' })).toMatchObject({ providers: expect.any(Array) });
expect(searchAttempts).toHaveLength(1); // HTTP200 application error recorded once
expect(localInvalidAttempts).toHaveLength(0);
```
- [ ] Run focused collector/gateway/worker/search/IPC/preload/profile-store tests. Record a coverage table linking every production client-construction path to collection, and evidence for raw usage/retry assumptions. Supply report + task diff, freeze for review.

### Task 3: Settings usage dashboard

**Files:** `apps/desktop/src/renderer/features/settings/SettingsView.tsx` and tests; create `UsageDashboard.tsx`, local CSS + focused tests; `App.tsx` only for settings navigation union if needed; renderer-test-helpers fake API. Do not edit main, preload or Base files; raise contract needs to controller.

**Consumes:** Task 1 `interfaces.md`, Task 2 promised `DesktopApi.usage.getDashboard`. During parallel work, use the agreed Base types and actual eventual DesktopApi property, not an unsafe fallback interface; final typecheck waits for bridge completion.

- [ ] Write failing UI tests for new 用量 navigation, periods/resource switch, grouping, unknown counts, empty/loading/error/degraded states and no Profile/detail controls.
- [ ] Implement consistent existing warm visual style: compact headline metrics, accessible daily CSS/SVG bars with textual values, provider horizontal contribution bars, LLM model rows under provider. Search has provider rows only. No charting dependency or remote assets. Avoid putting Token and request counts on one axis.
- [ ] Fetch on open/filter; poll at low frequency only while visible and active, clean up timers, guard stale responses. Keep reports/chat/settings drafts unaffected by navigation; no side-effect save/activate.
- [ ] Show “已记录” metrics with partial/unknown notices, compilation start time and “仅统计本应用可观测用量，不代表服务商账单或剩余额度。” Unknown is not zero; draft and deleted-profile calls included without exposing profile detail.
- [ ] Accessible keyboard controls, labels and narrow window behavior. Example expectation:
```ts
expect(screen.getByText('DeepSeek')).toBeInTheDocument();
expect(screen.getByText('deepseek-flash')).toBeInTheDocument();
expect(screen.queryByRole('combobox', {name:/Profile/})).toBeNull();
```
- [ ] Run focused Settings/dashboard/renderer tests; report + task-only diff, freeze for review.

## Controller acceptance and delivery

- [ ] Verify Task 1 contracts then dispatch Task 2/3 with disjoint ownership (user-approved parallelism overrides skill default serialization; never simultaneous edits to same file).
- [ ] Per-task independent spec/quality review; fix via original implementer. Broad final integration review once all three tasks complete.
- [ ] Fresh typecheck, focused cross-task tests, build and mac-arm64 directory package. No unnecessary live API testing.
- [ ] Check running app for active user work before normal quit; preserve previous installed app recoverably; install via ditto and verify asar hash. Launch only normal installed application, no raw Electron/Playwright launch.
- [ ] Native Settings dashboard smoke without saving keys or issuing live model/search requests. Supply compact handtest instructions. No commits or GitHub push in this task.
