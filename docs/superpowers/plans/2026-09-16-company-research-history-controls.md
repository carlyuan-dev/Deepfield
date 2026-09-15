# Company Research History Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve non-cancelled research failures as retryable report entries, retry a failed entry in place with the user's latest fields, render raw reports as Markdown, and let users delete a selected terminal report.

**Architecture:** Extend the persisted run state machine with `research_failed`, then keep all retry and deletion invariants in Repository/Application rather than Renderer. Expose two narrow commands (`retryFailed`, `deleteRun`) through validated IPC; Renderer only chooses a selected version, opens the shared form, and renders server state. Reuse the existing `MarkdownMessage` content boundary for raw and streaming reports.

**Tech Stack:** TypeScript 7, TypeBox, Node SQLite, Electron IPC/preload, React 19, react-markdown/remark-gfm, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-16-company-research-history-design.md`

## Global Constraints

- “重新尝试”复用当前失败 run ID；只有“新的调研”创建新 run。
- 用户修改重试字段后，当前失败版本必须保存并继续预填最新字段。
- 用户取消任何活动调研都删除该活动 run；失败和完成状态才进入历史。
- 重试必须在变更 run 前完成输入、归属、全局占用和所需运行配置预检。
- 原始失败只保存白名单代码，绝不把 Provider 响应、密钥、路径或完整异常持久化/发往 Renderer。
- 不改变搜索预算、LLM 输出预算、报告模板、Chat 生命周期或 Chat Markdown 行为。
- 不修改 `docs/material/` 或 `docs/single-company-key-research-discussion.md`。

---

### Task 1: Persist the failed-run state machine and in-place retry transitions

**Files:**
- Modify: `packages/contracts/src/research.ts`
- Modify: `packages/contracts/src/company-research-templates.test.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/capability-persistence.test.ts`
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/company-research-run-repository.ts`
- Modify: `packages/persistence/src/company-research-run-repository.test.ts`

**Interfaces:**
- Produces: `ResearchFailureCode`, `ResearchFailureCodeSchema`, and history statuses `research_failed | structure_failed | completed`.
- Produces: `failResearching(runId, code)`, `retryResearching(runId, input, context, template, startedAt)`, `retryStructuring(runId, startedAt)`, `deleteActive(runId)`, and `deleteTerminal(itemId, companyId, runId)`.
- Produces: `recoverAbandoned(): { failedResearching: number; failedStructuring: number }`.

- [ ] **Step 1: Write contract and migration tests that fail on `research_failed`**

Add assertions equivalent to:

```ts
const failed: KeyResearchRun = {
  ...validResearching,
  status: "research_failed",
  lastFailureCode: "tool_failed",
};
expect(Value.Check(ResearchRunSchema, failed)).toBe(true);
expect(Value.Check(ResearchRunSummarySchema, withoutSnapshots(failed))).toBe(true);
```

In the migration test, migrate a v12 database containing completed and `structure_failed` rows, then insert a valid `research_failed` row and assert all three history rows remain readable. Also assert SQLite rejects a `research_failed` row with raw content and a raw failure code on `structure_failed`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- packages/contracts/src/company-research-templates.test.ts packages/persistence/src/capability-persistence.test.ts packages/persistence/src/company-research-run-repository.test.ts`

Expected: FAIL because schemas, migration v13, and repository transitions do not accept raw failures.

- [ ] **Step 3: Add the bounded failure types and v13 table rebuild**

Use one exported union everywhere:

```ts
export const ResearchFailureCodeSchema = Type.Union([
  Type.Literal("structuring_failed"),
  Type.Literal("tool_failed"),
  Type.Literal("model_failed"),
  Type.Literal("empty_report"),
  Type.Literal("protocol_leak"),
  Type.Literal("language_validation_failed"),
  Type.Literal("incomplete_response"),
  Type.Literal("protocol_error"),
  Type.Literal("storage_failed"),
]);
export type ResearchFailureCode = Static<typeof ResearchFailureCodeSchema>;
```

Add migration version 13 that rebuilds `company_research_runs`, preserves every column/row and both indexes, adds `research_failed` to `status`, and constrains `last_failure_code` to this exact union. The history index predicate must include `research_failed`.

- [ ] **Step 4: Write failing transition tests**

Cover these exact invariants:

```ts
const failed = repo.failResearching(run.id, "tool_failed");
expect(failed).toMatchObject({ id: run.id, status: "research_failed", lastFailureCode: "tool_failed" });

const retried = repo.retryResearching(
  failed.id,
  { direction: "business_progress", focusScope: "最新量产", asOfDate: "2026-09-16" },
  changedContext,
  changedTemplate,
  "2026-09-16T10:00:00.000Z",
);
expect(retried).toMatchObject({ id: failed.id, status: "researching", focusScope: "最新量产", createdAt: "2026-09-16T10:00:00.000Z", structuringAttempts: 0 });
expect(retried).not.toHaveProperty("rawReportText");
expect(retried).not.toHaveProperty("lastFailureCode");
```

Also cover: changed `structure_failed` clears raw/structured/completion fields; unchanged `retryStructuring` preserves raw text and run ID, increments attempts, clears failure and refreshes `createdAt`; `deleteActive` accepts both active stages but rejects terminal rows; `deleteTerminal` checks item/company ownership and rejects active rows; list ordering includes raw failures; repeated fail/retry/fail remains one row.

- [ ] **Step 5: Implement repository validation and atomic transitions**

Update `validateRun` so:

```ts
researching     => no raw/structure/completion/failure, attempts === 0
research_failed => no raw/structure/completion, attempts === 0, raw failure code required
structuring     => raw required, attempts >= 1, no structure/completion/failure
structure_failed => raw required, attempts >= 1, failure === "structuring_failed"
completed       => raw + structure + completedAt required, no failure
```

Extend the transition SQL to update input/context/template/harness/created-at fields as well as artifacts. Every method must use compare-and-set status predicates and return a validated clone.

Change startup recovery from deleting `researching` to `failResearching(runId, "incomplete_response")`; keep `structuring -> structure_failed`.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- packages/contracts/src/company-research-templates.test.ts packages/persistence/src/capability-persistence.test.ts packages/persistence/src/company-research-run-repository.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/contracts/src/research.ts packages/contracts/src/company-research-templates.test.ts packages/persistence/src/migrations.ts packages/persistence/src/capability-persistence.test.ts packages/persistence/src/types.ts packages/persistence/src/company-research-run-repository.ts packages/persistence/src/company-research-run-repository.test.ts
git commit -m "feat: persist retryable company research failures"
```

---

### Task 2: Orchestrate in-place retry, cancellation, failure persistence, and deletion

**Files:**
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/company-research-diagnostic-repository.ts`
- Modify: `packages/persistence/src/company-research-diagnostic-repository.test.ts`
- Modify: `packages/persistence/src/tool-execution-repository.ts`
- Modify: `packages/persistence/src/tool-execution.test.ts`
- Modify: `packages/application/src/company-research-service.ts`
- Modify: `packages/application/src/company-research-service.test.ts`

**Interfaces:**
- Consumes: Task 1 repository transitions and `ResearchFailureCode`.
- Produces: `retryFailed(itemId, companyId, runId, input): Promise<ResearchRun>`.
- Produces: `deleteRun(itemId, companyId, runId): void`.
- Produces: `companyResearchDiagnostics.deleteByRunId(runId): string[]` returning trace IDs and `toolExecutions.deleteByTraceIds(traceIds): number`.

- [ ] **Step 1: Write failing service tests for raw failure persistence**

For each worker outcome `tool_failed`, `model_failed`, `empty_report`, `protocol_leak`, `language_validation_failed`, `incomplete_response`, plus protocol and storage paths, assert the run becomes `research_failed`, appears in `listRuns`, retains the submitted input, and emits a safe matching `state_changed.outcome`. Assert cancellation from both `researching` and `structuring` removes the run.

- [ ] **Step 2: Run the focused service tests and verify failure**

Run: `npm test -- packages/application/src/company-research-service.test.ts`

Expected: FAIL because the raw failure cleanup currently deletes the run and structuring cancellation currently records a failure.

- [ ] **Step 3: Persist raw failures and make cancellation destructive**

Centralize worker-to-storage mapping:

```ts
function persistedFailure(outcome: ResearchFailureOutcome): ResearchFailureCode {
  if (outcome === "web_search_failed" || outcome === "research_failed") return "tool_failed";
  return outcome;
}
```

On non-cancelled raw failure call `failResearching`; on cancellation call `deleteActive` for either stage. Continue emitting only fixed public outcomes. If failure persistence throws, emit `storage_failed` and leave startup recovery to reconcile the active row.

- [ ] **Step 4: Write failing retry tests for same-ID routing and preflight**

Cover:

```ts
expect(await service.retryFailed(itemId, companyId, failed.id, changedInput))
  .toMatchObject({ id: failed.id, status: "researching", ...changedInput });
expect(repos.companyResearchRuns.listRuns(itemId, companyId)).toHaveLength(0); // active is not history
```

Assert an unchanged `structure_failed` retry uses the same ID, dispatches only structure, and never resolves Search; changed input resolves LLM + Search and dispatches raw. Assert missing profiles, invalid ownership, active occupancy, and invalid input reject before mutating the old failure. Assert a second failure leaves one historical entry with the latest fields.

- [ ] **Step 5: Implement preflight-first `retryFailed`**

Normalize optional scope exactly as `start` does, load the selected terminal run, and compare normalized `direction`, `focusScope`, and `asOfDate`.

```ts
if (run.status === "structure_failed" && inputsEqual(run, normalized)) {
  const llm = await this.profiles.resolveActiveLlm();
  const active = repositories.companyResearchRuns.retryStructuring(run.id, nowIso);
  return dispatchStructure(active, llm);
}
const [llm, search] = await Promise.all([
  this.profiles.resolveActiveLlm(),
  this.profiles.resolveActiveSearch(),
]);
const { context, template } = buildResearchSnapshots(target, normalized, nowDate);
const active = repositories.companyResearchRuns.retryResearching(run.id, normalized, context, template, nowIso);
return dispatchRaw(active, llm, search);
```

Reuse the existing start/dispatch helpers instead of duplicating worker lifecycle code. Only `research_failed` and `structure_failed` are eligible.

- [ ] **Step 6: Write failing deletion cascade tests**

Create two runs with separate diagnostics and tool traces. Delete one terminal run and assert only its run, diagnostics, and trace-linked tools disappear. Assert wrong ownership, active run, and any global active occupancy leave all rows unchanged.

- [ ] **Step 7: Add narrow cleanup repository methods and transactional `deleteRun`**

Implement:

```ts
deleteByRunId(runId: string): string[];      // SELECT distinct trace IDs, then DELETE diagnostics
deleteByTraceIds(traceIds: readonly string[]): number; // explicit placeholders; [] is a no-op
```

In `deleteRun`, validate target/status and global occupancy first, then run trace lookup, tool deletion, diagnostic deletion, and `deleteTerminal` inside `repositories.runInTransaction`.

- [ ] **Step 8: Run focused tests and commit**

Run: `npm test -- packages/persistence/src/company-research-diagnostic-repository.test.ts packages/persistence/src/tool-execution.test.ts packages/application/src/company-research-service.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/persistence/src/types.ts packages/persistence/src/company-research-diagnostic-repository.ts packages/persistence/src/company-research-diagnostic-repository.test.ts packages/persistence/src/tool-execution-repository.ts packages/persistence/src/tool-execution.test.ts packages/application/src/company-research-service.ts packages/application/src/company-research-service.test.ts
git commit -m "feat: retry and delete company research runs"
```

---

### Task 3: Expose validated retry and delete commands through Electron

**Files:**
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `apps/desktop/src/preload/preload-api.test.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/ipc.test.ts`
- Modify: `apps/desktop/src/main/ipc-arity.test.ts`
- Modify: `apps/desktop/src/main/ipc-trusted-adapter.test.ts`

**Interfaces:**
- Consumes: Task 2 service methods.
- Produces Desktop API:

```ts
retryFailed(itemId: string, companyId: string, runId: string, input: StartCompanyResearchInput): Promise<ResearchRun>;
deleteRun(itemId: string, companyId: string, runId: string): Promise<void>;
```

- [ ] **Step 1: Write failing contract, preload, arity, and trusted-adapter tests**

Assert `retryFailed` invokes exactly four arguments and rejects an extra argument; `deleteRun` invokes exactly three and rejects extras. Assert invalid IDs/input never reach the service, valid calls do, and both channels are present in the trusted adapter and teardown lists. Replace all old `retryStructuring` expectations.

- [ ] **Step 2: Run IPC tests and verify failure**

Run: `npm test -- apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts`

Expected: FAIL because the new channels and methods are absent.

- [ ] **Step 3: Implement schemas, channels, handlers, and preload forwarding**

Define tuple schemas:

```ts
export const CompanyResearchRetryFailedArgsSchema = Type.Tuple([
  IdSchema, IdSchema, IdSchema, StartCompanyResearchInputSchema,
]);
export const CompanyResearchDeleteRunArgsSchema = Type.Tuple([IdSchema, IdSchema, IdSchema]);
```

Name channels `deepfield:companyResearch:retryFailed` and `deepfield:companyResearch:deleteRun`. Keep handlers fail-closed and return generic errors (`company research retry failed`, `company research deletion failed`) without leaking caught details.

- [ ] **Step 4: Run IPC tests and commit**

Run: `npm test -- apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/contracts/src/ipc.ts apps/desktop/src/preload/preload-api.ts apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts
git commit -m "feat: expose research history commands"
```

---

### Task 4: Add report controls and shared Markdown rendering

**Files:**
- Modify: `apps/desktop/src/renderer/features/industry-research/company-research-test-fixtures.ts`
- Modify: `apps/desktop/src/renderer/features/industry-research/CompanyResearchModal.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/use-company-research.ts`
- Modify: `apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/ConfirmModal.tsx`
- Modify: `apps/desktop/src/renderer/capability.css`

**Interfaces:**
- Consumes: Task 3 Desktop API.
- Produces hook actions `retry(input)` and `deleteSelected()` plus stable same-ID selection.
- Reuses: `apps/desktop/src/renderer/components/MarkdownMessage.tsx` unchanged unless a report-only wrapper prop is required.

- [ ] **Step 1: Write failing UI tests for controls, labels, and prefill**

Cover these states:

```ts
completed       => button "新的调研" only
research_failed => buttons "重新尝试", "新的调研" in that order
structure_failed => buttons "重新尝试", "新的调研" in that order
no history      => button "开始调研"
```

Assert the selector appends `（失败待重试）`; clicking retry opens the shared modal with the selected failed version's direction/focus/date; editing and submitting calls `retryFailed` with the same run ID and edited input; retry completion does not change selected ID.

- [ ] **Step 2: Write failing UI tests for deletion and Markdown**

Assert “删除此报告” opens a confirmation containing date and status; confirm calls `deleteRun`; refresh selects the next newest remaining summary, or shows empty state. Assert cancel does not delete. Disable delete while any global run is active.

Render raw saved text, streaming draft, `structure_failed` raw text, and legacy text containing headings, tables, lists, emphasis, and an HTTP link. Assert semantic elements (`h1/h2`, `table`, `ul`, `strong`, `a`) exist, literal Markdown markers are not the rendered presentation, and the shared URL popover/copy path remains available.

- [ ] **Step 3: Run Renderer tests and verify failure**

Run: `npm test -- apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`

Expected: FAIL because current UI says “重新调研/重新整理”, has no deletion, and uses `LinkifiedText` for raw reports.

- [ ] **Step 4: Implement hook commands and race-safe selection**

Replace `retry()` with `retry(input)`. After retry, retain `selectedRunId`; refresh authoritative state and load that same run once it becomes terminal. Add `deleteSelected()` which remembers the deleted ID and previous ordered list, invokes the API, refreshes, then selects `remaining[deletedIndex] ?? remaining[deletedIndex - 1] ?? remaining[0]` while preserving existing revision/detail-ticket guards.

- [ ] **Step 5: Implement modal modes, report controls, and failure body**

Give `CompanyResearchModal` a mode/title/submit label so start and retry share validation but display “开始调研” or “重新尝试”. Keep separate local state for opening a new-report modal versus retry modal.

For `research_failed`, show its safe mapped failure text and no report body. For `structure_failed`, show the safe structure failure and keep raw tab available. Use `ConfirmModal` for deletion; never use `window.confirm`.

- [ ] **Step 6: Replace raw `LinkifiedText` with `MarkdownMessage`**

Use the same content component for:

```tsx
<MarkdownMessage content={active.draftText} />
<MarkdownMessage content={run.rawReportText} />
<MarkdownMessage content={legacy.reportText} />
```

Keep `StructuredResearchReport` unchanged. Add only scoped CSS needed to remove chat-bubble assumptions and preserve the report container's width/scroll behavior.

- [ ] **Step 7: Run Renderer tests and commit**

Run: `npm test -- apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`

Expected: PASS.

Commit:

```bash
git add apps/desktop/src/renderer/features/industry-research/company-research-test-fixtures.ts apps/desktop/src/renderer/features/industry-research/CompanyResearchModal.tsx apps/desktop/src/renderer/features/industry-research/use-company-research.ts apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.tsx apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx apps/desktop/src/renderer/features/industry-research/ConfirmModal.tsx apps/desktop/src/renderer/capability.css
git commit -m "feat: add research report history controls"
```

---

### Task 5: Integration verification and macOS arm64 handoff

**Files:**
- Modify only if verification exposes a regression in files already listed above.
- Package target: `release/mac-arm64/Deepfield.app`

**Interfaces:**
- Consumes all prior tasks.
- Produces a packaged app ready for the user's manual verification.

- [ ] **Step 1: Run all focused suites together**

Run:

```bash
npm test -- packages/contracts/src/company-research-templates.test.ts packages/persistence/src/capability-persistence.test.ts packages/persistence/src/company-research-run-repository.test.ts packages/persistence/src/company-research-diagnostic-repository.test.ts packages/persistence/src/tool-execution.test.ts packages/application/src/company-research-service.test.ts apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run repository-wide static and test verification**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm test`

Expected: exit 0 with no failed suites.

Run: `npm run build`

Expected: exit 0 and Electron bundles emitted.

- [ ] **Step 3: Package the current build**

Run: `npm run dist:dir`

Expected: exit 0 and `release/mac-arm64/Deepfield.app` has a fresh modification time and contains the current bundle.

- [ ] **Step 4: Inspect the final diff and package metadata**

Run:

```bash
git status --short
git diff --check HEAD~4..HEAD
plutil -p release/mac-arm64/Deepfield.app/Contents/Info.plist
```

Expected: no uncommitted implementation files, no whitespace errors, and a valid Deepfield bundle plist.
