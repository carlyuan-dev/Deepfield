# Deepfield Single Company Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one evidence-seeking DeepSeek research task from a company detail page, stream its report, clean failed work, and retain successful report versions for reporter evaluation.

**Architecture:** A dedicated task-scoped `CompanyResearchAgent` runs in the existing Electron Utility Process and never creates a Chat Conversation. `CompanyResearchService` in the application layer owns one app-wide active run, streams an in-memory draft, and atomically completes or deletes a SQLite `ResearchRun`. Renderer calls the service through narrow IPC and displays one report field plus version history.

**Tech Stack:** Electron 43, React 19, TypeScript 7, Node 24 `node:sqlite`, TypeBox, Vitest, DeepSeek Responses API.

**Spec:** `docs/superpowers/specs/2026-09-09-deepfield-single-company-research-design.md`

## Global Constraints

- Run with Node `>=24.17.0`; this workspace currently uses Node `24.18.0`.
- Research always uses `deepseek-v4-flash`, `stream: true`, forced `web_search`, and `max_output_tokens: 32768`.
- One application-wide Company Research run may be active at a time; ordinary Chat remains usable.
- A run is bound to the exact `(itemId, companyId)` membership, not to Company alone.
- Persist only completed report text and its input metadata. Streaming text stays in Main memory.
- Failed, cancelled, incomplete, empty, or abandoned runs are removed.
- Use focused tests for the three high-risk paths and one final Fake smoke; do not add broad test matrices.
- Automated tests use fakes and make no real DeepSeek or other network calls.
- Keep the current Conversation, Chat, company recognition, and Tool permission behavior unchanged.

---

### Task 1: ResearchRun contracts and SQLite persistence

**Files:**
- Modify: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/research.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/types.ts`
- Create: `packages/persistence/src/company-research-run-repository.ts`
- Modify: `packages/persistence/src/repositories.ts`
- Test: `packages/persistence/src/company-research-run-repository.test.ts`

**Interfaces:**
- Produces `ResearchRunId`, `ResearchRun`, `StartCompanyResearchInput`, `CompanyResearchState`, and `CompanyResearchRunRepository`.
- Later tasks consume the repository without issuing SQL directly.

- [ ] **Step 1: Add the domain contract**

Define the closed input schema and report record:

```ts
export const StartCompanyResearchInputSchema = Type.Object({
  timeScope: Type.String({ minLength: 1, maxLength: 300 }),
  customRequirements: Type.Optional(Type.String({ maxLength: 4000 })),
}, { additionalProperties: false });

export interface ResearchRun {
  id: ResearchRunId;
  itemId: CapabilityItemId;
  companyId: CompanyId;
  status: "running" | "completed";
  timeScope: string;
  customRequirements?: string;
  reportText?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CompanyResearchState {
  active?: { run: ResearchRun; draftText: string };
  completed: ResearchRun[];
}
```

Export these types from `packages/contracts/src/index.ts`.

- [ ] **Step 2: Add migration 5**

Create `company_research_runs` with a composite foreign key to `capability_item_companies(item_id, company_id) ON DELETE CASCADE`. Enforce the invariant that a running row has no report/completion time and a completed row has a non-blank report/completion time.

Use a partial unique index to enforce one global running row:

```sql
CREATE UNIQUE INDEX idx_company_research_one_running
ON company_research_runs(status)
WHERE status = 'running';
```

Add a completed-history index ordered by membership and completion time.

- [ ] **Step 3: Add the repository interface and implementation**

Implement exactly these methods:

```ts
interface CompanyResearchRunRepository {
  createRunning(itemId: CapabilityItemId, companyId: CompanyId,
    input: StartCompanyResearchInput): ResearchRun;
  complete(runId: ResearchRunId, reportText: string): ResearchRun;
  delete(runId: ResearchRunId): boolean;
  deleteAllRunning(): number;
  getById(runId: ResearchRunId): ResearchRun | undefined;
  getRunning(): ResearchRun | undefined;
  listCompleted(itemId: CapabilityItemId, companyId: CompanyId): ResearchRun[];
}
```

Trim `timeScope` and optional requirements at the repository boundary. Reject blank time scope and blank completed report. Return completed history newest-first with a stable row tie-breaker.

- [ ] **Step 4: Add two focused persistence tests**

Test only:

1. create running → complete → create and complete a second run → newest-first history retains both versions;
2. only one global running row is allowed, `deleteAllRunning()` clears it, and deleting the item-company membership cascades its completed history.

Use a temporary SQLite database and existing migration/repository helpers.

- [ ] **Step 5: Verify and commit Task 1**

Run:

```bash
npm test -- packages/persistence/src/company-research-run-repository.test.ts
npm run typecheck
git diff --check
```

Commit:

```bash
git add packages/contracts/src/ids.ts packages/contracts/src/research.ts \
  packages/contracts/src/index.ts packages/persistence/src/migrations.ts \
  packages/persistence/src/types.ts packages/persistence/src/company-research-run-repository.ts \
  packages/persistence/src/repositories.ts packages/persistence/src/company-research-run-repository.test.ts
git commit -m "feat: persist company research runs"
```

**Task acceptance:** Completed versions survive repository reconstruction, one running row is enforced globally, and membership deletion leaves no research rows.

---

### Task 2: Task-scoped CompanyResearchAgent

**Files:**
- Modify: `packages/contracts/src/research.ts`
- Modify: `packages/contracts/src/worker.ts`
- Create: `apps/desktop/src/worker/company-research-prompt.ts`
- Create: `apps/desktop/src/worker/company-research-agent.ts`
- Test: `apps/desktop/src/worker/company-research-agent.test.ts`

**Interfaces:**
- Consumes the ResearchRun identity and an immutable company/industry snapshot.
- Produces `CompanyResearchWorkerRequest`, `CompanyResearchWorkerEvent`, and `CompanyResearchAgent.run(request, emit, signal)`.

- [ ] **Step 1: Define the dedicated worker contract**

The request uses `kind: "company-research.run"`, contains `requestId`, `runId`, API key, model ID, and this snapshot:

```ts
interface CompanyResearchContext {
  currentDate: string;
  companyName: string;
  countryOrRegion?: string;
  industry: string;
  researchScope?: string;
  companyNote?: string;
  timeScope: string;
  customRequirements?: string;
}
```

Events are `started`, `text_delta`, `completed`, `failed`, and `cancelled`, all carrying both `requestId` and `runId`. Add the request to `UtilityWorkerRequestSchema`; keep research events separate from `AgentWorkerEventSchema`.

- [ ] **Step 2: Build the versioned internal prompt**

Export `COMPANY_RESEARCH_PROMPT_VERSION = "company-research-v1"` and a pure prompt builder. It must pass the snapshot without Chat history and encode the approved rules: autonomous structure, Chinese output, evidence-seeking search, one strongest complete URL for each important conclusion, responsible-source preference, and uncertain items stated as unconfirmed.

- [ ] **Step 3: Implement the DeepSeek streaming adapter**

POST to `https://api.deepseek.com/responses` with:

```ts
{
  model: "deepseek-v4-flash",
  instructions,
  input: [{ role: "user", content: researchPrompt }],
  tools: [{ type: "web_search" }],
  tool_choice: { type: "web_search" },
  max_output_tokens: 32768,
  stream: true,
}
```

Map output-text deltas to research events. Emit `completed` only after a normal `response.completed` with non-blank final text. Map `response.incomplete`, `response.failed`, HTTP failure, malformed SSE, empty output, and abort to fixed non-sensitive terminal events.

- [ ] **Step 4: Add two focused adapter tests**

With a fake fetch stream, verify:

1. the request has forced web search, no Chat messages, the full approved context, and emits started/deltas/completed;
2. `response.incomplete` produces a terminal failure and never produces completed text.

- [ ] **Step 5: Verify and commit Task 2**

Run the new agent test and `npm run typecheck`, then commit only Task 2 files with:

```bash
git commit -m "feat: add company research agent"
```

**Task acceptance:** A fake DeepSeek response proves the dedicated Agent uses only the provided research context, forces web search, streams text, and rejects truncated output.

---

### Task 3: Research lifecycle, worker transport, IPC, and cleanup

**Files:**
- Modify: `packages/application/src/ports.ts`
- Create: `packages/application/src/company-research-service.ts`
- Test: `packages/application/src/company-research-service.test.ts`
- Modify: `apps/desktop/src/worker/message-loop.ts`
- Modify: `apps/desktop/src/worker/message-loop-types.ts`
- Modify: `apps/desktop/src/worker/assembly.ts`
- Modify: `apps/desktop/src/main/agent-worker-client.ts`
- Modify: `apps/desktop/src/main/agent-worker-protocol.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Focused tests: existing worker/client/IPC files only where the new route is introduced

**Interfaces:**
- Consumes Task 1 repository and Task 2 agent contract.
- Produces `CompanyResearchService.start/cancel/getState/listCompleted` and `DesktopApi.companyResearch`; `getState` returns the Task 1 `CompanyResearchState` snapshot.

- [ ] **Step 1: Add the worker port and application service**

The service validates the item-company membership, creates one running row, snapshots company/industry data, obtains the DeepSeek key, and starts background consumption. Its in-memory active state contains `run`, `draftText`, and `startedAt`.

Expose:

```ts
start(itemId: string, companyId: string, input: StartCompanyResearchInput): ResearchRun;
cancel(runId: string): Promise<void>;
getState(itemId: string, companyId: string): CompanyResearchState;
listCompleted(itemId: string, companyId: string): ResearchRun[];
cleanupAbandoned(): number;
```

On completed, persist once; on any failure/cancel/stream termination, delete the run and clear memory. Start Main by calling `cleanupAbandoned()` once after migration.

- [ ] **Step 2: Add research routing and explicit cancellation to the Utility transport**

Extend the existing single message loop and client with a `research` stream kind. A `company-research.cancel` control message identifies the active request and aborts only that execution. Terminal research events remove pending client state immediately; late events are dropped.

- [ ] **Step 3: Add IPC and Preload APIs**

Add narrow methods:

```ts
companyResearch.start(itemId, companyId, input)
companyResearch.cancel(runId)
companyResearch.getState(itemId, companyId)
companyResearch.listCompleted(itemId, companyId)
companyResearch.subscribe(listener)
```

Validate every IPC argument with TypeBox and forward only fixed safe errors. The event channel carries only CompanyResearchWorkerEvent data.

- [ ] **Step 4: Add three focused service/transport assertions**

Cover:

1. success completes one run and retains its report;
2. failure and explicit cancel remove the running row and in-memory draft;
3. while one run is active, a second start is rejected but Chat transport can still be used.

Use existing test helpers rather than creating a broad new lifecycle matrix.

- [ ] **Step 5: Verify and commit Task 3**

Run only the new service test plus the directly modified worker/client/IPC tests, then `npm run typecheck` and `git diff --check`. Commit:

```bash
git commit -m "feat: connect company research lifecycle"
```

**Task acceptance:** Main owns one resumable-in-UI active draft, cancellation reaches the Utility AbortSignal, success persists, and all non-success terminals leave no ResearchRun.

---

### Task 4: Company detail report workspace and functional checkpoint

**Files:**
- Create: `apps/desktop/src/renderer/features/industry-research/CompanyResearchModal.tsx`
- Create: `apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.tsx`
- Create: `apps/desktop/src/renderer/features/industry-research/use-company-research.ts`
- Modify: `apps/desktop/src/renderer/features/industry-research/IndustryResearchCapability.tsx`
- Modify: `apps/desktop/src/renderer/capability.css`
- Test: add one company-research path to the existing focused Capability renderer test
- Modify: `docs/development.md`

**Interfaces:**
- Consumes `DesktopApi.companyResearch` from Task 3.
- Produces the user-testable company research path described in the spec.

- [ ] **Step 1: Add the launch modal**

Use a required text input defaulted to “重点调研近一年，必要的公司背景不限时间”, an optional requirements textarea, and cancel/start buttons. A rerun pre-fills the latest completed run's values.

- [ ] **Step 2: Add active and completed report states**

Show genuine elapsed time and streaming text without a percentage. Preserve line breaks and use the existing safe URL-linking component. Add explicit cancel. For completed reports, show newest by default and a completion-time/time-scope history selector.

- [ ] **Step 3: Integrate with company detail without expanding the company-list component**

Extract the research UI into the new focused components. Opening another company or closing the Capability changes only the view; it does not call cancel. On return, query `getState()` and display the current in-memory draft.

- [ ] **Step 4: Add one renderer main-path test**

Using a Fake API, cover: company detail → start → streamed draft → completed report → rerun creates a second selectable history version. Keep cancel cleanup in the service test from Task 3.

- [ ] **Step 5: Run the phase checkpoint**

Run:

```bash
npm test -- apps/desktop/src/renderer/App-shell.test.tsx
npm run typecheck
npm run build
git diff --check
```

Launch one Fake app smoke to confirm the company path and ordinary Chat can coexist. Update `docs/development.md` with the manual real-DeepSeek checklist. Commit:

```bash
git commit -m "feat: add company research workspace"
```

**Task acceptance:** The packaged behavior is ready for the project developer to run two real company reports and one rerun without losing Chat or prior report versions.

---

## Real-effect checkpoint

After Task 4, stop feature development. Run two real companies once each and one of them a second time. Record observed report usefulness, source selection, completion time, visible length, and any truncation. Adjust only the Prompt, token limit, or directly blocking interaction before handing one representative report to the target reporter.

The single-company research stage closes only after the reporter confirms the report is a useful input to her work. Evidence verification, atomic facts, batch research, and incremental research start in later designs.
