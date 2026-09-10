# Deepfield Single-Company Key Research V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing single-company research path into a read-only two-stage workflow that persists a web-researched Markdown report, structures it without web access, validates it, and exposes both views for user testing.

**Architecture:** Evolve the existing `ResearchRun` path in place. `CompanyResearchService` owns the durable `researching → structuring → completed | structure_failed` state machine; the Utility Process executes one stage at a time; a deterministic Harness validates structured output against the selected template and URLs present in the raw report. Editing, review status, automatic LLM format repair, and dynamic templates are deliberately excluded.

**Tech Stack:** TypeScript, TypeBox, Node `DatabaseSync` SQLite, Electron Main/Preload/Utility Process, React, Vitest, DeepSeek Responses API.

**Spec:** `docs/superpowers/specs/2026-09-11-deepfield-single-company-key-research-v1-design.md`

## Global Constraints

- Work on the existing `codex/tool-platform` checkout; preserve unrelated user files and never add `docs/material/` or `docs/single-company-key-research-discussion.md` to a commit.
- Reuse the existing Company, Capability Item, Utility Process, IPC, history selector, global single-active-research rule, and Chat concurrency behavior.
- The UI term is “研究主题”; do not rename the existing SQLite `industry` column or component directories in this slice.
- First-stage research must force `web_search`; second-stage structuring must expose no tools.
- Raw Markdown must be committed before structuring starts. Structuring failure or cancellation must retain the raw report and allow a retry.
- Structured output is read-only. Do not add content IDs, editable copies, “人工核验”, add/delete/restore controls, or an LLM format-repair stage.
- The Harness verifies structure and source inheritance, not factual truth or semantic entailment. Product copy must continue to say AI output needs human verification.
- Old free-form completed reports remain readable and are never converted by an LLM.
- Use TDD for each task. Run focused tests after each task and `npm test -- --maxWorkers=1`, `npm run typecheck`, `npm run build`, and `git diff --check` before handoff.

---

### Task 1: Built-in template registry and versioned contracts

**Files:**
- Create: `packages/contracts/src/company-research-templates.ts`
- Modify: `packages/contracts/src/research.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/worker.ts`
- Test: `packages/contracts/src/company-research-templates.test.ts`
- Test: `packages/contracts/src/worker.test.ts`

**Interfaces:**
- Produces: `ResearchDirection`, `CompanyResearchTemplateSnapshot`, `COMPANY_RESEARCH_TEMPLATES`, `getCompanyResearchTemplate(direction)`.
- Produces: `StartCompanyResearchInput`, `StructuredResearchContent`, versioned `ResearchRun`, run summary/detail state, stage worker request/event unions.
- Consumed by: persistence, Harness, Worker, Application, IPC, and Renderer tasks.

- [ ] **Step 1: Write failing registry and schema tests**

```ts
it("defines exactly four templates with five ordered unique sections", () => {
  expect(Object.keys(COMPANY_RESEARCH_TEMPLATES)).toHaveLength(4);
  for (const template of Object.values(COMPANY_RESEARCH_TEMPLATES)) {
    expect(template.templateVersion).toBe(1);
    expect(template.sections).toHaveLength(5);
    expect(new Set(template.sections.map((section) => section.sectionId)).size).toBe(5);
  }
});

it("accepts direction, optional focus and an ISO cutoff date only", () => {
  expect(Value.Check(StartCompanyResearchInputSchema, {
    direction: "product_and_technology",
    focusScope: "手机硅碳负极电池",
    asOfDate: "2026-09-11",
  })).toBe(true);
  expect(Value.Check(StartCompanyResearchInputSchema, {
    direction: "all",
    asOfDate: "tomorrow",
  })).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run packages/contracts/src/company-research-templates.test.ts packages/contracts/src/worker.test.ts`

Expected: FAIL because the registry and stage contracts do not exist.

- [ ] **Step 3: Implement the immutable registry**

Define these exact direction IDs:

```ts
export const RESEARCH_DIRECTIONS = [
  "product_and_technology",
  "market_and_commercialization",
  "value_chain_and_competition",
  "operations_and_performance",
] as const;
export type ResearchDirection = typeof RESEARCH_DIRECTIONS[number];

export interface CompanyResearchTemplateSnapshot {
  templateId: ResearchDirection;
  templateVersion: 1;
  title: string;
  sections: readonly {
    sectionId: string;
    title: string;
    coreQuestion: string;
    coverage: string;
    boundary: string;
  }[];
}
```

Populate the four directions and twenty module IDs from section 6 of `docs/single-company-key-research-discussion.md`. Export a lookup that returns a deep-frozen serializable snapshot rather than a mutable shared object.

- [ ] **Step 4: Replace the legacy input and report contracts**

Use a real calendar-date refinement in Application in addition to this transport schema:

```ts
export const StartCompanyResearchInputSchema = Type.Object({
  direction: Type.Union(RESEARCH_DIRECTIONS.map((value) => Type.Literal(value))),
  focusScope: Type.Optional(Type.String({ maxLength: 1000 })),
  asOfDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
}, { additionalProperties: false });

export const ResearchSectionStatusSchema = Type.Union([
  Type.Literal("found"), Type.Literal("partial"), Type.Literal("not_found"),
  Type.Literal("not_disclosed"), Type.Literal("conflicting"),
]);

export const ResearchClaimTypeSchema = Type.Union([
  Type.Literal("reported_fact"), Type.Literal("company_statement"),
  Type.Literal("plan"), Type.Literal("estimate"), Type.Literal("forecast"),
]);
```

Define `StructuredResearchContentSchema` with only `coreSummary` and `sections`; each section has only `sectionId`, `status`, `summary`, and `facts`; each fact has only `text`, `timeContext`, `claimType`, and `source`; each source has only `title` and `url`. Apply explicit size bounds: core summary 1–4 entries, section facts at most 8, text 1–4000, summary 1–4000 or null, title 1–1000, URL 1–4000.

Represent persisted reports as a discriminated union:

```ts
type ResearchRun = LegacyResearchRun | KeyResearchRun;
type KeyResearchStatus = "researching" | "structuring" | "structure_failed" | "completed";

interface KeyResearchRun {
  schemaVersion: "company-research-report-v1";
  id: ResearchRunId;
  itemId: CapabilityItemId;
  companyId: CompanyId;
  status: KeyResearchStatus;
  direction: ResearchDirection;
  focusScope?: string;
  asOfDate: string;
  researchContext: CompanyResearchContext;
  template: CompanyResearchTemplateSnapshot;
  harnessVersion: 1;
  rawReportText?: string;
  structuredContent?: StructuredResearchContent;
  structuringAttempts: number;
  lastFailureCode?: "structuring_failed";
  createdAt: string;
  rawCompletedAt?: string;
  completedAt?: string;
}
```

Keep legacy completed fields under `schemaVersion: "legacy-freeform-v1"`. Make worker requests a discriminated union with `kind: "company-research.raw.run" | "company-research.structure.run"` and all events carry `requestId`, `runId`, and `stage: "raw" | "structure"`.

- [ ] **Step 5: Run contract tests and typecheck**

Run: `npx vitest run packages/contracts/src/company-research-templates.test.ts packages/contracts/src/worker.test.ts && npm run typecheck`

Expected: registry/schema tests pass; typecheck may fail only in downstream files still using the legacy contract, which Task 3–6 will migrate.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add packages/contracts/src/company-research-templates.ts packages/contracts/src/company-research-templates.test.ts packages/contracts/src/research.ts packages/contracts/src/index.ts packages/contracts/src/ipc.ts packages/contracts/src/worker.ts packages/contracts/src/worker.test.ts
git commit -m "feat: define key research contracts"
```

### Task 2: Deterministic structured-output Harness

**Files:**
- Create: `packages/application/src/company-research-harness.ts`
- Create: `packages/application/src/company-research-harness.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**
- Consumes: `StructuredResearchContentSchema`, `CompanyResearchTemplateSnapshot`.
- Produces: `validateStructuredResearch(candidateText, rawMarkdown, template): StructuredResearchContent`.

- [ ] **Step 1: Write failing Harness tests**

```ts
it("accepts a valid five-section result whose source links occur in the raw report", () => {
  const raw = "- [公司公告](https://example.com/a)";
  expect(validateStructuredResearch(validJson(template, "公司公告", "https://example.com/a"), raw, template)
    .sections).toHaveLength(5);
});

it.each([
  "extra top-level field",
  "missing section",
  "wrong section order",
  "found without facts",
  "not_found with facts",
  "conflicting with fewer than two facts",
  "new URL absent from raw Markdown",
])("rejects %s", (fixture) => {
  expect(() => validateStructuredResearch(invalidJson(fixture), rawReport, template)).toThrow();
});
```

- [ ] **Step 2: Run the Harness test and confirm RED**

Run: `npx vitest run packages/application/src/company-research-harness.test.ts`

Expected: FAIL because the Harness module does not exist.

- [ ] **Step 3: Implement parsing, finite repair, and validation**

Implement these functions as pure code:

```ts
export const COMPANY_RESEARCH_HARNESS_VERSION = 1 as const;
export function extractMarkdownSources(markdown: string): Set<string>;
export function parseStructuredCandidate(text: string): unknown;
export function validateStructuredResearch(
  candidateText: string,
  rawMarkdown: string,
  template: CompanyResearchTemplateSnapshot,
): StructuredResearchContent;
```

`extractMarkdownSources` stores exact `title + "\u0000" + url` pairs from Markdown links whose URLs parse as HTTP or HTTPS. `parseStructuredCandidate` accepts a plain JSON object or one single `json` Markdown fence, and rejects multiple objects or prose around the candidate. Validation must use `Value.Check`, exact template section order, status/content invariants, and exact source-pair inheritance. Do not normalize, repair, or replace source URLs.

- [ ] **Step 4: Run Harness tests and typecheck the package**

Run: `npx vitest run packages/application/src/company-research-harness.test.ts && npm run typecheck`

Expected: Harness tests pass; remaining type errors are confined to legacy consumers.

- [ ] **Step 5: Commit the Harness**

```bash
git add packages/application/src/company-research-harness.ts packages/application/src/company-research-harness.test.ts packages/application/src/index.ts
git commit -m "feat: validate structured research reports"
```

### Task 3: Durable two-stage ResearchRun persistence

**Files:**
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/company-research-run-repository.ts`
- Test: `packages/persistence/src/company-research-run-repository.test.ts`
- Test: `packages/persistence/src/capability-persistence.test.ts`

**Interfaces:**
- Produces repository methods: `createResearching`, `completeRaw`, `failStructuring`, `retryStructuring`, `completeStructured`, `deleteResearching`, `recoverAbandoned`, `getByIdForTarget`, `getActive`, `listRuns`.
- Guarantees conditional state transitions and legacy read compatibility.

- [ ] **Step 1: Write migration and state-transition tests**

```ts
it("migrates completed free-form reports as readable legacy reports", () => {
  const migrated = db.repos.companyResearchRuns.listRuns(item.id, company.id)[0];
  expect(migrated).toMatchObject({
    schemaVersion: "legacy-freeform-v1",
    status: "completed",
    reportText: "旧报告",
  });
});

it("persists raw output before structuring and preserves it on failure", () => {
  const run = repo.createResearching(item.id, company.id, input, context, template);
  repo.completeRaw(run.id, "# 原始报告\n[来源](https://example.com/a)");
  repo.failStructuring(run.id);
  expect(repo.getByIdForTarget(item.id, company.id, run.id)).toMatchObject({
    status: "structure_failed",
    rawReportText: expect.stringContaining("原始报告"),
  });
});
```

- [ ] **Step 2: Run persistence tests and confirm RED**

Run: `npx vitest run packages/persistence/src/company-research-run-repository.test.ts packages/persistence/src/capability-persistence.test.ts`

Expected: FAIL on missing migration columns and methods.

- [ ] **Step 3: Add migration v8**

Rebuild `company_research_runs` through a temporary table. Copy only old `completed` rows as `legacy-freeform-v1`; omit abandoned legacy `running` rows. The new table must persist:

```text
id, item_id, company_id, schema_version, status,
research_direction, focus_scope, as_of_date,
research_context_json, template_id, template_version, template_snapshot_json,
harness_version, raw_report_text, raw_completed_at,
structured_content_json, structuring_attempts, last_failure_code,
legacy_time_scope, legacy_custom_requirements, legacy_report_text,
created_at, completed_at
```

Create one partial unique expression index for all active states:

```sql
CREATE UNIQUE INDEX idx_company_research_one_active
ON company_research_runs((1))
WHERE status IN ('researching', 'structuring');
```

Keep the `(item_id, company_id, completed_at DESC, id DESC)` history index and the existing composite foreign key with cascade deletion.

- [ ] **Step 4: Implement conditional repository transitions**

Each write uses `WHERE id = ? AND status = ?` and throws when `changes === 0`. `completeRaw` atomically writes the raw report and changes `researching → structuring`. `completeStructured` validates the JSON before writing and changes `structuring → completed`. `recoverAbandoned` deletes `researching` and converts `structuring → structure_failed` without touching durable terminal rows.

On read, parse and validate all JSON fields. A malformed row throws a safe repository error; it must not return unvalidated model JSON to Renderer.

- [ ] **Step 5: Run persistence tests**

Run: `npx vitest run packages/persistence/src/company-research-run-repository.test.ts packages/persistence/src/capability-persistence.test.ts`

Expected: all migration, transition, ordering, target ownership, recovery, and cascade tests pass.

- [ ] **Step 6: Commit persistence**

```bash
git add packages/persistence/src/migrations.ts packages/persistence/src/types.ts packages/persistence/src/company-research-run-repository.ts packages/persistence/src/company-research-run-repository.test.ts packages/persistence/src/capability-persistence.test.ts
git commit -m "feat: persist two-stage research runs"
```

### Task 4: Raw-research and structuring Worker stages

**Files:**
- Modify: `apps/desktop/src/worker/company-research-agent.ts`
- Modify: `apps/desktop/src/worker/company-research-prompt.ts`
- Create: `apps/desktop/src/worker/company-research-structuring-prompt.ts`
- Modify: `apps/desktop/src/worker/message-loop.ts`
- Modify: `apps/desktop/src/worker/message-loop-types.ts`
- Modify: `apps/desktop/src/worker/assembly.ts`
- Modify: `apps/desktop/src/main/agent-worker-client.ts`
- Modify: `apps/desktop/src/main/agent-worker-protocol.ts`
- Test: `apps/desktop/src/worker/company-research-agent.test.ts`
- Test: `apps/desktop/src/worker/message-loop.test.ts`
- Test: `apps/desktop/src/main/agent-worker-client.test.ts`

**Interfaces:**
- Consumes the Task 1 stage request/event union.
- Raw stage emits deltas and final Markdown; structure stage emits one final JSON candidate and no visible deltas.

- [ ] **Step 1: Write failing Worker behavior tests**

```ts
it("forces web search only for the raw stage", async () => {
  await agent.run(rawRequest, emit, signal);
  expect(rawBody.tools).toEqual([{ type: "web_search" }]);
  expect(rawBody.tool_choice).toEqual({ type: "web_search" });

  await agent.run(structureRequest, emit, signal);
  expect(structureBody.tools).toBeUndefined();
  expect(structureBody.tool_choice).toBeUndefined();
  expect(structureBody.text).toEqual({ format: { type: "json_object" } });
});

it("includes only the selected template modules in the raw prompt", () => {
  const prompt = buildCompanyResearchPrompt(context, selectedTemplate);
  expect(prompt).toContain("products_and_positioning");
  expect(prompt).not.toContain("financial_performance");
});
```

- [ ] **Step 2: Run Worker tests and confirm RED**

Run: `npx vitest run apps/desktop/src/worker/company-research-agent.test.ts apps/desktop/src/worker/message-loop.test.ts apps/desktop/src/main/agent-worker-client.test.ts`

Expected: FAIL because only `company-research.run` exists.

- [ ] **Step 3: Build the two prompts**

Raw prompt assembly must include: system research rules; topic/company identity; selected direction; optional focus; cutoff; only the selected five module definitions; fixed Markdown headings; one direct Markdown source link per atomic fact; conflict and missing-information sections; prompt-injection boundary. It must not request JSON or a final core conclusion.

Structuring prompt must include: immutable context snapshot, selected template snapshot, raw report inside `<raw_research_report>` delimiters, exact output schema, no-internet/no-tools instruction, source URL/title copying, claim-type mapping, status invariants, and “JSON object only”. It must not ask for IDs, edits, verification status, or a source dictionary.

- [ ] **Step 4: Extend the Worker transport**

Raw requests keep SSE streaming and emit `text_delta` with `stage: "raw"`. Structure requests call the same Responses endpoint without `tools`, request `json_object`, aggregate the output internally, and emit only `completed` with `stage: "structure"` and the raw JSON string. Both paths require `response.completed` with status `completed`, reject empty or incomplete output, observe `AbortSignal`, and emit one safe terminal event.

- [ ] **Step 5: Run Worker and transport tests**

Run: `npx vitest run apps/desktop/src/worker/company-research-agent.test.ts apps/desktop/src/worker/message-loop.test.ts apps/desktop/src/worker/message-loop-lifecycle.test.ts apps/desktop/src/main/agent-worker-client.test.ts apps/desktop/src/main/agent-worker-client-lifecycle.test.ts`

Expected: all stage routing, tool isolation, stream completion, cancellation, and late-event tests pass.

- [ ] **Step 6: Commit Worker changes**

```bash
git add apps/desktop/src/worker/company-research-agent.ts apps/desktop/src/worker/company-research-prompt.ts apps/desktop/src/worker/company-research-structuring-prompt.ts apps/desktop/src/worker/message-loop.ts apps/desktop/src/worker/message-loop-types.ts apps/desktop/src/worker/assembly.ts apps/desktop/src/main/agent-worker-client.ts apps/desktop/src/main/agent-worker-protocol.ts apps/desktop/src/worker/company-research-agent.test.ts apps/desktop/src/worker/message-loop.test.ts apps/desktop/src/main/agent-worker-client.test.ts
git commit -m "feat: add structured research stage"
```

### Task 5: Application-owned two-stage orchestration

**Files:**
- Modify: `packages/application/src/ports.ts`
- Modify: `packages/application/src/company-research-service.ts`
- Test: `packages/application/src/company-research-service.test.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Test: `apps/desktop/src/main/application-runtime.test.ts`

**Interfaces:**
- Produces: `start`, `cancel`, `retryStructuring`, `getState`, `listRuns`, `getRun`, `cleanupAbandoned`, `isRunning`.
- Consumes: repository transitions, stage Worker port, template registry, and Harness.

- [ ] **Step 1: Write failing state-machine tests**

```ts
it("persists raw output before dispatching structuring and completes only after Harness", async () => {
  const run = service.start(item.id, company.id, input);
  worker.finishRaw(run.id, rawMarkdown);
  await worker.waitForStructureRequest();
  expect(repo.getByIdForTarget(item.id, company.id, run.id)?.status).toBe("structuring");
  worker.finishStructure(run.id, validStructuredJson);
  await service.whenIdle();
  expect(service.getRun(item.id, company.id, run.id)).toMatchObject({ status: "completed" });
});

it("retains raw output and retries only structuring", async () => {
  worker.failStructure(run.id);
  await service.whenIdle();
  expect(service.getRun(item.id, company.id, run.id)).toMatchObject({
    status: "structure_failed",
    rawReportText: rawMarkdown,
  });
  service.retryStructuring(item.id, company.id, run.id);
  expect(worker.lastRequest.kind).toBe("company-research.structure.run");
});
```

Also cover raw failure/cancel deletion, structure cancel preservation, invalid Harness output, completed-run retry rejection, wrong-target run read rejection, global single active stage, Chat independence, duplicate/late event rejection, and startup recovery.

- [ ] **Step 2: Run Application tests and confirm RED**

Run: `npx vitest run packages/application/src/company-research-service.test.ts apps/desktop/src/main/application-runtime.test.ts`

Expected: FAIL because the current service has one `running → completed` stage.

- [ ] **Step 3: Implement start validation and context snapshotting**

Validate `focusScope.trim()` and a real calendar `asOfDate` not later than the local current date. Load the Item, Company, and membership once. Save their identity/profile snapshot plus the chosen template snapshot in the run. Do not mutate company profile or parent topic scope.

- [ ] **Step 4: Implement sequential stage dispatch**

Keep one in-memory active object:

```ts
interface ActiveResearch {
  runId: ResearchRunId;
  requestId: string;
  stage: "raw" | "structure";
  rawDraftText: string;
  startedAt: Date;
  done: Promise<void>;
}
```

On raw completion, transactionally call `completeRaw`, emit a state-change event, then dispatch structuring with a new `requestId`. On structure completion, call the Harness and transactionally persist `structuredContent`. On raw failure/cancel delete the empty run; on structure failure/cancel/Harness rejection call `failStructuring`. Clear active state in every terminal path and ignore late or mismatched stage events.

- [ ] **Step 5: Implement retry, reads, cancellation, and recovery**

`retryStructuring(itemId, companyId, runId)` must confirm target ownership and `structure_failed`, acquire the global active slot, conditionally transition to `structuring`, and dispatch only the saved raw/context/template snapshot. `cancel` routes to the active stage. `cleanupAbandoned` delegates to `recoverAbandoned`. `isRunning` returns true for either active stage so company-profile enrichment stays paused until terminal state.

- [ ] **Step 6: Run Application tests**

Run: `npx vitest run packages/application/src/company-research-service.test.ts apps/desktop/src/main/application-runtime.test.ts`

Expected: all orchestration and recovery tests pass.

- [ ] **Step 7: Commit Application orchestration**

```bash
git add packages/application/src/ports.ts packages/application/src/company-research-service.ts packages/application/src/company-research-service.test.ts apps/desktop/src/main/application-runtime.ts apps/desktop/src/main/application-runtime.test.ts
git commit -m "feat: orchestrate two-stage company research"
```

### Task 6: IPC and Preload surface for report details and retry

**Files:**
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/ipc-test-helpers.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Test: `apps/desktop/src/main/ipc.test.ts`
- Test: `apps/desktop/src/main/ipc-arity.test.ts`
- Test: `apps/desktop/src/preload/preload-api.test.ts`

**Interfaces:**
- Produces Desktop API methods: `retryStructuring(itemId, companyId, runId)`, `listRuns(itemId, companyId)`, `getRun(itemId, companyId, runId)`.
- Preserves existing start/cancel/getState/subscribe with versioned return types.

- [ ] **Step 1: Write failing IPC and Preload tests**

```ts
expect(api.companyResearch.retryStructuring).toBeTypeOf("function");
expect(api.companyResearch.getRun).toBeTypeOf("function");
expect(api.companyResearch.listRuns).toBeTypeOf("function");

await expect(invoke(IPC_CHANNELS.companyResearchGetRun, itemId, companyId, "other-run"))
  .rejects.toThrow("company research read failed");
```

- [ ] **Step 2: Run IPC tests and confirm RED**

Run: `npx vitest run apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/preload/preload-api.test.ts`

Expected: FAIL on missing channels and methods.

- [ ] **Step 3: Add exact schemas, channels, handlers, and bridge methods**

All target-sensitive calls accept `(itemId, companyId, runId)` and validate argument count plus TypeBox schemas before invoking Application. Map internal exceptions to the existing safe generic messages. Continue filtering subscribed events through `CompanyResearchWorkerEventSchema`; never send API keys, raw provider errors, or unvalidated JSON to Renderer.

- [ ] **Step 4: Run IPC/Preload tests and typecheck**

Run: `npx vitest run apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/preload/preload-api.test.ts && npm run typecheck`

Expected: all tests and typecheck pass.

- [ ] **Step 5: Commit IPC changes**

```bash
git add apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc-test-helpers.ts apps/desktop/src/preload/preload-api.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/preload/preload-api.test.ts
git commit -m "feat: expose key research reports"
```

### Task 7: Read-only two-stage research UI

**Files:**
- Modify: `apps/desktop/src/renderer/features/industry-research/CompanyResearchModal.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/use-company-research.ts`
- Create: `apps/desktop/src/renderer/features/industry-research/StructuredResearchReport.tsx`
- Modify: `apps/desktop/src/renderer/capability.css`
- Test: `apps/desktop/src/renderer/App-shell.test.tsx`
- Test: `apps/desktop/src/renderer/App-chat-edge.test.tsx`

**Interfaces:**
- Consumes versioned runs and Desktop API from Task 6.
- Produces launch form, stage states, raw/structured tabs, retry action, legacy display, and history selection.

- [ ] **Step 1: Write failing user-path tests**

```tsx
it("starts one direction and switches between structured and raw reports", async () => {
  await user.click(screen.getByRole("button", { name: "开始调研" }));
  await user.selectOptions(screen.getByLabelText("研究方向"), "product_and_technology");
  await user.click(screen.getByRole("button", { name: "开始调研" }));
  expect(api.companyResearch.start).toHaveBeenCalledWith(itemId, companyId, expect.objectContaining({
    direction: "product_and_technology",
  }));
  expect(await screen.findByText("核心结论")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "原始调研报告" }));
  expect(screen.getByText(/公司关键调研原始报告/)).toBeInTheDocument();
});

it("keeps raw output visible and retries a failed structure stage", async () => {
  expect(screen.getByText("整理失败，请重试")).toBeInTheDocument();
  expect(screen.getByText(/原始事实/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新整理" }));
  expect(api.companyResearch.retryStructuring).toHaveBeenCalledWith(itemId, companyId, runId);
});
```

- [ ] **Step 2: Run Renderer tests and confirm RED**

Run: `npx vitest run apps/desktop/src/renderer/App-shell.test.tsx apps/desktop/src/renderer/App-chat-edge.test.tsx`

Expected: FAIL because the current modal uses time scope/custom requirements and the panel only renders one free-form report.

- [ ] **Step 3: Replace launch inputs**

Show inherited topic/company as read-only context, a required four-option direction select, optional `focusScope` up to 1000 characters, and a date input defaulted to the local current date with `max` set to that date. Remove time scope and custom requirements. Reuse the most recent v1 run’s direction/focus/date only where the value remains valid; otherwise use product/technology and today.

- [ ] **Step 4: Render all durable stages**

- `researching`: “正在联网调研…”, elapsed time, raw streaming draft, cancel.
- `structuring`: raw report tab is immediately readable, “正在整理结构化报告…”, cancel.
- `structure_failed`: raw report stays readable, “整理失败，请重试”, retry button.
- `completed` v1: structured tab defaults active, raw tab available.
- `completed` legacy: one “旧版原始报告” view with original inputs.

Do not show a percentage or fabricated progress steps.

- [ ] **Step 5: Render structured content safely**

`StructuredResearchReport` shows 1–4 core summary bullets, then five always-expanded section cards in the persisted template order. Map section statuses to the fixed Chinese copy in the template registry. Each fact shows text, optional time, a Chinese claim-type badge, and one HTTP/HTTPS source link. Render all model text as text nodes or the existing safe Markdown component; never use `dangerouslySetInnerHTML`.

Keep this warning visible: `AI 调研结果仅供参考，重要事实仍需人工核验。`

- [ ] **Step 6: Run Renderer tests**

Run: `npx vitest run apps/desktop/src/renderer/App-shell.test.tsx apps/desktop/src/renderer/App-chat-edge.test.tsx`

Expected: launch, both stages, retry, dual views, history, legacy display, and Chat concurrency tests pass.

- [ ] **Step 7: Commit the UI**

```bash
git add apps/desktop/src/renderer/features/industry-research/CompanyResearchModal.tsx apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.tsx apps/desktop/src/renderer/features/industry-research/use-company-research.ts apps/desktop/src/renderer/features/industry-research/StructuredResearchReport.tsx apps/desktop/src/renderer/capability.css apps/desktop/src/renderer/App-shell.test.tsx apps/desktop/src/renderer/App-chat-edge.test.tsx
git commit -m "feat: show structured company research"
```

### Task 8: Regression verification and hand-test launch

**Files:**
- Modify only files directly required by failures caused by Tasks 1–7.
- Do not modify or commit protected user documents.

**Interfaces:**
- Produces a runnable development build and a `DEEPFIELD_DEV_REPORT_V3` handoff.

- [ ] **Step 1: Run all focused company-research tests**

Run:

```bash
npx vitest run \
  packages/contracts/src/company-research-templates.test.ts \
  packages/contracts/src/worker.test.ts \
  packages/application/src/company-research-harness.test.ts \
  packages/application/src/company-research-service.test.ts \
  packages/persistence/src/company-research-run-repository.test.ts \
  apps/desktop/src/worker/company-research-agent.test.ts \
  apps/desktop/src/worker/message-loop.test.ts \
  apps/desktop/src/main/agent-worker-client.test.ts \
  apps/desktop/src/main/ipc.test.ts \
  apps/desktop/src/preload/preload-api.test.ts \
  apps/desktop/src/renderer/App-shell.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full deterministic verification**

Run:

```bash
git diff --check
npm run typecheck
npm test -- --maxWorkers=1
npm run build
```

Expected: all commands exit 0. Existing React `act(...)` warnings may be recorded, but no failed test is acceptable.

- [ ] **Step 3: Inspect the final diff and repository scope**

Run: `git status --short && git diff --stat && git log --oneline -10`

Expected: only planned application changes plus the approved spec/plan are tracked; `docs/material/` and `docs/single-company-key-research-discussion.md` remain untracked and untouched.

- [ ] **Step 4: Start the real app for user testing**

Run: `npm run dev`

Expected: Electron opens without startup or migration errors. Do not read, print, or log the stored API key. Leave the development session running for the user.

- [ ] **Step 5: Return the handoff contract**

```yaml
DEEPFIELD_DEV_REPORT_V3:
  task_id: "KEY-RESEARCH-V1"
  status: "completed | blocked"
  summary: "one-sentence outcome"
  commits: []
  acceptance:
    raw_research: "passed | failed"
    durable_stage_boundary: "passed | failed"
    offline_structuring: "passed | failed"
    harness: "passed | failed"
    dual_view_ui: "passed | failed"
    legacy_reports: "passed | failed"
  verification:
    focused_tests: "exact result"
    full_tests: "exact result"
    typecheck: "passed | failed"
    build: "passed | failed"
    diff_check: "passed | failed"
  hand_test:
    dev_session: "session id or not started"
    suggested_cases:
      - "one product-and-technology company"
      - "one operations-and-performance company"
      - "retry structuring from preserved raw report"
  deviations: []
  blockers: []
  protected_files: "untouched"
  next: "await user hand-test feedback"
```
