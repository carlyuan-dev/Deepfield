# Batch Company Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Ship the approved batch wizard, persistent sequential two-round queue, cancel control, and topic progress.
**Architecture:** A batch application orchestrator owns durable ordered entries and delegates each run to CompanyResearchService. Main exposes typed snapshots/events to renderer; existing profile loop yields at task boundaries. UI drafts do not create runs.
**Tech Stack:** Existing TypeScript, TypeBox, SQLite, Electron IPC and React; no added dependency.
**Spec:** docs/superpowers/specs/2026-09-17-batch-company-research.md

## Global Constraints

- Preserve existing dirty changes, no commits/pushes. Controller coordinates, agents implement.
- No new prompts/agents or duplicated two-stage workflow. Single global batch, sequential full-company execution.
- Cancel never deletes finished/historical reports and never dispatches next queued entry.
- No historical title/report backfill or live paid multi-company tests.
- Use exact user copy in spec; ready-company selection; all three per-company fields editable via reused form.

### Task 1: Durable orchestration, API and operation snapshots

Files: create packages/contracts/src/batch-research.ts; persistence batch repository and migration; application batch service/tests; modify CompanyResearchService availability boundary, CompanyProfileEnrichmentService coordination/progress, application runtime, Main IPC/preload contracts/tests and fake API defaults.

Interfaces: expose api.companyResearchBatch.start(itemId, entries), getState(itemId), cancel(batchId), resume(batchId), subscribe(listener). Entries contain companyId and input: StartCompanyResearchInput. DTO carries batchId/itemId/status/ordered entries with companyId/input/runId/status/stage plus processed/succeeded/failed/total counts and public issue. Reuse existing public errors. Expose profile progress per topic through typed API snapshot/event, no renderer inference from all historical companies. Implementer records final exact signatures in backend-interface.md for UI handoff.

- [ ] Write focused tests with deferred worker results: two companies dispatch in order only after previous terminal; raw/structure failures independent; queued entries have no run IDs before dispatch.
- [ ] Verify RED for missing batch repository/service.
- [ ] Persist batch/job snapshots, transactional admission/cancellation, reuse existing research service start/retry/cancel, global reservation and profile boundary coordination.
- [ ] Add pause/resume recovery without automatic paid restart; config failure pauses, individual failure continues. If stored source still available retry structure only.
- [ ] Wire typed IPC/preload snapshot/events; teardown unsubscribes; validate owner/target/inputs server-side. Add IPC boundary tests.
- [ ] Verify focused tests + typecheck, self-review cancellation races. Save task-only diff, report and exact interface document for controller review. Do not commit.

### Task 2: Batch wizard and company-list presentation

Files: create BatchCompanyResearchModal.tsx, batch/progress hook and OperationProgress.tsx with focused tests; modify CompanyResearchModal.tsx to support draft-only submit label, IndustryResearchCapability.tsx, renderer styles and test fixtures.

Consumes exact API and DTO in backend-interface.md from Task1. Produces only renderer behavior; no changes to execution rules.

- [ ] Write failing wizard tests: defaults copied, editor confirms without research, edited mark, back/reselection retains edits, input validation and disabled not-ready companies.
- [ ] Add three-step wizard with reuse of existing CompanyResearchModal; configurable title/submit label without breaking start/retry modes. Override drafts by companyId; common fields do not overwrite modified entries.
- [ ] Add 批量调研公司 immediately after import. Render selected-topic status in toolbar left, progress count inside bar; cancel underline action; paused continue/settings action; completed success/failure count.
- [ ] Add per-row queued/active stage without disabling navigation for research; retain existing profile pending/enriching navigation rule.
- [ ] Handle initial snapshots + events when navigating away/back; narrow layouts wrap, buttons nonshrinking. Run focused UI/integration tests + typecheck; report diff and no unrelated changes. Do not commit.

### Task 3: Independent integrated review and release handoff

- [ ] Reviewer checks both tasks against spec: cancellation ownership, resource boundary, persisted restart, UI count semantics and form reuse. Fix findings via implementer and scoped re-review.
- [ ] Controller runs focused integration verification/typecheck/build. Package into staging, quit installed app normally, preserve previous .app then replace exact release/mac-arm64/Deepfield.app.
- [ ] Native UI smoke: wizard selection/defaults/edit/back/cancel before submission without paid research; no historical changes. Leave batch execution for user hand test. Record limitations and hand-test steps.
