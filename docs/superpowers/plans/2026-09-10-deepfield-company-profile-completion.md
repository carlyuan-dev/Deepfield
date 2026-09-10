# Deepfield Company Profile Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one shared structured Company profile, complete it once per newly discovered company with bounded web-search requests, and allow explicit global edits without coupling profile writes to Company Research.

**Architecture:** Company profile contracts distinguish unknown (property absent) from confirmed none (`[]` or `null`). `IndustryResearchService` deduplicates names, completes only new companies through a narrow `CompanyCompleter`, and creates memberships without overwriting reused profiles. SQLite owns strict current-state persistence; Renderer edits through one narrow service/IPC path, while `CompanyResearchService` receives only a read-only company lookup and passes profile data as identity context.

**Tech Stack:** TypeScript 7, TypeBox, Node SQLite, Electron, React 19, Vitest, DeepSeek Responses API.

**Spec:** User-approved product boundary in the P4 development task dated 2026-09-10.

## Global Constraints

- `name` is the only required creation field; `businessTags` remains unknown when completion fails.
- Missing optional properties mean unknown; empty `aliases`/`stockListings` and `officialWebsite: null` mean confirmed none.
- Existing profiles are never overwritten by import; explicit edit replaces current global profile and creates no history.
- `ItemCompany.note` remains relationship-only data.
- Company Research may read profile data but has no Company update port.
- Automatic completion uses one forced-web-search request per new normalized company and serial execution.
- Preserve unrelated working-tree files, especially `docs/material/`.

---

### Task 1: Structured profile contract and migration

**Files:**
- Modify: `packages/contracts/src/capability-items.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/mappers.ts`
- Modify: `packages/persistence/src/company-repository.ts`
- Test: `packages/persistence/src/capability-persistence.test.ts`

**Interfaces:**
- Produces `CompanyProfileInputSchema`, `CompanyProfileFieldsSchema`, `StockListingSchema`, `CompanyRepository.update`, and `CompanyRepository.getByNormalizedName`.

- [ ] Write a failing persistence test proving unknown/confirmed-none round trips, legacy country migration to headquarters, explicit replacement, duplicate-name rejection, and no overwrite on reuse.
- [ ] Run the focused persistence test and confirm RED for missing fields/methods.
- [ ] Add migration 6 profile columns, strict mappers, repository create/reuse/update behavior, and contract schemas.
- [ ] Run the focused persistence test and confirm GREEN.

### Task 2: One-shot bounded web completion and import orchestration

**Files:**
- Modify: `packages/application/src/ports.ts`
- Modify: `packages/application/src/industry-research-service.ts`
- Modify: `packages/application/src/industry-research-service.test.ts`
- Modify: `apps/desktop/src/main/deepseek-service.ts`
- Modify: `apps/desktop/src/main/deepseek-service.test.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes `CompanyCompleter.complete(name): Promise<CompanyProfileFields>`.
- Produces asynchronous `addCompany/addCompanies`, serial completion, per-company safe fallback, and transient `profileCompletion` feedback.

- [ ] Write failing application tests for exactly-once completion, serial calls, isolated fallback, reused-profile preservation, and shared cross-industry views.
- [ ] Write a failing DeepSeek test proving one `/responses` request with forced `web_search` and strict structured output.
- [ ] Run both tests and confirm RED for missing completer behavior.
- [ ] Implement the narrow port, strict response parser, fake completer, and async service orchestration.
- [ ] Run both focused tests and confirm GREEN.

### Task 3: Explicit global edit and research read-only boundary

**Files:**
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `packages/application/src/company-research-service.ts`
- Modify: `packages/application/src/company-research-service.test.ts`
- Test: `apps/desktop/src/main/ipc.test.ts`

**Interfaces:**
- Produces `industryResearch.updateCompany(companyId, input)` with strict validation and safe errors.
- Company Research consumes a repository type whose Company capability is `getById` only.

- [ ] Write failing service/IPC tests for explicit profile replacement, duplicate rejection, and Company Research preserving the profile while including it in identity context.
- [ ] Run focused tests and confirm RED.
- [ ] Implement the update route and narrow research repository dependency.
- [ ] Run focused tests and confirm GREEN.

### Task 4: Profile detail/edit UI and compatibility cleanup

**Files:**
- Create: `apps/desktop/src/renderer/features/industry-research/CompanyProfileModal.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/IndustryResearchCapability.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/AddCompaniesModal.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/ImportCompaniesModal.tsx`
- Modify: `apps/desktop/src/renderer/renderer-test-helpers.ts`
- Modify: `apps/desktop/src/renderer/App-shell.test.tsx`
- Modify: `apps/desktop/src/renderer/capability.css`

**Interfaces:**
- Consumes `DesktopApi.industryResearch.updateCompany` and structured profile states.
- Produces shared detail rendering, minimal list editors, explicit save, and no user-visible `countryOrRegion`.

- [ ] Write one failing Renderer path covering unknown/confirmed-none labels, edit/save, and the same updated profile in a second industry.
- [ ] Run the focused Renderer test and confirm RED.
- [ ] Implement the profile modal and detail/list compatibility updates.
- [ ] Run focused tests and confirm GREEN.
- [ ] Run all tests, typecheck, build, and `git diff --check`; inspect the final diff without touching `docs/material/`.
