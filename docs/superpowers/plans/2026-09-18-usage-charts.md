# Usage Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Controller delegates implementation and independently reviews.

**Goal:** Improve 用量信息 with custom periods, fixed-size interactive charts and truthful cache splits.
**Architecture:** Reuse existing ledger; extend Base query/IPC projection and replace renderer charts. No collector rewrite or ledger migration unless essential and approved by controller.
**Tech Stack:** Existing TypeScript/TypeBox, SQLite, React/SVG/CSS and Vitest; no new chart dependency.
**Spec:** User approved in-chat design (2026-09-18): today hourly, multiple days daily; inclusive custom start/end; Provider/model selector; LLM request line and token stacked bars; Search ordinary bars; full-column tooltips; unknown cache splits gray, not fabricated. Follow existing docs/base/base.usage.设计文档.md for preserved ledger semantics. Latest additions: rename 用量信息, remove visible collection-start timestamp, Search provider contribution uses matching green. No renewed approval needed.

## Global Constraints

- Only /Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering; preserve all existing dirty work. No commit/push/cleanup or user DB/key reads, paid requests, ad-hoc Electron launch.
- User requested controller planning/review, child implementation. No child subagents or child-triggered reviews. Focused tests only.
- Base never imports upper layers; existing data/collector unaffected. Unknown != zero; cache writes count within uncached input, not again.
- Default period remains month. Custom date endpoints inclusive, max existing 366-day bound with friendly validation; today and custom single day hourly, others daily. Local timezone/DST honored. Future hours today should not look like observed zero; untracked coverage retained but collection-start label hidden.
- LLM charts sit side-by-side at wide width, stack at narrow widths. Each chart has fixed height; bucket count cannot wrap into new rows. Full-width responsive plotting area, sparse ticks, entire column hover/focus target. Straight line segments (no invented curve overshoot); integer request ticks.
- Model dropdown identifies Provider + model, only actual ledger models; no Profile filter. Model affects charts, global overview/provider contribution remains all-model and clearly labeled. Empty-period options preserve known model identity when requested.

### Task 1: Query projection and IPC

**Files:** packages/base/src/usage/{contracts,dates,query,index}.ts and focused tests; packages/contracts/src/ipc.ts response schema; main usage fallback and nonrenderer fixtures/tests as required. No renderer production edits.

**Interfaces:** Extend UsageRange with today/custom; UsageDashboardQuery supports startDate/endDate only custom, optional model {providerId,modelId} only LLM. Preserve current summary/daily/providers/health, add trend {granularity:'hour'|'day', points, summary, models:[{providerId,modelId}], selectedModel:{providerId,modelId}|null}. Trend summary/points include existing metrics plus inputCacheHitTokens/inputCacheMissTokens/inputCacheUnknownTokens nullable and cacheSplitUnknownRequests integer. Each point retains from/to/date/coverage and a display label; explicit future marker allowed. Publish exact interfaces.md before freezing.

- [ ] Snapshot task files; failing tests for today24hour, custom3inclusive days, invalid/reversed/excess dates, model filtering and DST23/25-hour buckets. Keep half-open UTC internal query.
- [ ] Per record derive cache segments. Known input100/hit60 => hit60/miss40/unknown0. Another input50/hitnull => unknown50, not miss50. Aggregate must give hit60/miss40/unknown50, not miss90. Known hit with unknown input may show known hit without fabricated remainder. Preserve null when no reported metric. No subtracting aggregate nullable sums.
- [ ] Return chart series filtered by requested Provider/model, deterministic first model if omitted; current-range options plus explicitly requested model if no records, no accidental fallback to other model. Global totals/provider breakdown remain unfiltered. No source/Profile controls.
- [ ] Validate input/output via shared schemas and read-only IPC, including fallback dashboard shape. Retain old recorded data and health. Publish exact handoff.
- [ ] Run focused Base/SQLite/IPC tests, record RED/GREEN, task-only diff and task-1-report.md. Freeze for review; no full suite.

### Task 2: Fixed charts and Settings polish

**Files:** renderer/features/settings/UsageDashboard.tsx/css/test; create UsageCharts.tsx/test/helper if needed; SettingsView label/tests; renderer-test-helpers fakeapi. No nonrenderer edits.
**Consumes:** Task1 published interfaces.md; DesktopApi.usage.getDashboard with new periods/model.

- [ ] Snapshot owned files. RED tests for 用量信息, missing timestamp, five period controls/custom endpoints, model selector, requestline/tokenstack/Searchbar and zero-data fixed charts.
- [ ] Use SVG/CSS fixed chart height (~320px plot) with responsive width and no perday wrapping. Sparse x ticks, nice y ticks, legend color consistent. LLM two cards request count and Tokens, title totals for selected model. Full-column pointer areas trigger tooltip near pointer and keyboard focus shows same data; tooltip clamp/escape/dismiss. Today tooltip names hour, daily names date.
- [ ] Token legend/tooltip shows hit,miss,output and gray unclassified input when needed; never render absent as0. Search chart+Provider contribution use same green family. Keep global provider contribution; clarify all-model global totals.
- [ ] Remove visible collection-start time, not stored field. Change navigation/header to 用量信息; preserve drafts, health/error/empty states and stale-response protection/pollcleanup.
- [ ] Period order 今天、近7天、近30天、本月、自定义. Custom two native date inputs with invalid range feedback; query only valid pair, includes both dates. Model stable when dates change; single model remains single dropdown option. No pretend model when ledger empty.
- [ ] Focused renderer tests only; report+task-only diff, freeze. Controller typecheck/build/native smoke; do not consume real API quota.

## Controller delivery

- [ ] Verify isolated baseline and task gates; scoped reviews per task, one final integration review. No user-owned previous plan scratch cleanup.
- [ ] Update usage design document with implemented projection/UI changes after acceptance.
- [ ] Fresh typecheck/focused tests/build; package mac-arm64 using installed Electron distribution, recoverable installed backup and asar hash verification. Normal app native smoke only after checking no active task; leave ready for user.
