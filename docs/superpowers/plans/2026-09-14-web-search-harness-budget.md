# Web Search Harness Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a budget-aware Chat tool harness that preflights model-emitted search batches, keeps search and webpage-reading quotas independent, persists skipped/reused calls, and always reserves a streamed tool-free synthesis turn.

**Architecture:** Add committed/reserved snapshots to the atomic budget ledger, then place a request-scoped AgentRunControl and pure ToolBatchAdmission layer above ToolRunner. Integrate them through Pi hooks; Search Providers remain unchanged capability adapters. Extend contracts, SQLite, and Renderer state so activity records carry turn/batch identity and truthful statuses.

**Tech Stack:** TypeScript 7, TypeBox, Pi Agent Core 0.84.3, Node SQLite, React 19, Vitest 4, Electron/Vite.

**Spec:** docs/superpowers/specs/2026-09-14-web-search-harness-budget-design.md

## Global Constraints

- web_search and read_webpage have independent, coexisting quotas.
- Quota is consumed only when an external request is dispatched. Success and external failures both consume it.
- Pre-dispatch rejection, batch trimming, and cached reuse do not consume quota.
- Chat defaults remain four searches, three webpage reads, five tool-decision turns, and one reserved synthesis turn.
- The final synthesis turn has no tools and streams its answer.
- Search Provider interfaces and implementations receive no Agent, Prompt, loop, or budget knowledge.
- Do not modify docs/material/ or docs/single-company-key-research-discussion.md.

---

### Task 1: Add truthful budget reservation, commitment, and snapshots

**Files:**
- Modify: packages/tool-platform/src/budget.ts
- Modify: packages/tool-platform/src/runner.ts
- Modify: packages/tool-platform/src/index.ts
- Test: packages/tool-platform/src/budget.test.ts
- Test: packages/tool-platform/src/runner.test.ts

**Interfaces:**
- Produces: ToolBudgetLedger.commit(token: ToolBudgetToken): void
- Produces: ToolBudgetLedger.snapshot(): ToolBudgetSnapshot
- Preserves existing callers; release before commit stops consuming quota.

- [ ] **Step 1: Write failing reservation and snapshot tests**

~~~ts
it("holds quota at reserve time but consumes only after commit", () => {
  const ledger = new ToolBudgetLedger({ categoryCalls: { search: 1 } });
  const token = ledger.reserve({ name: "web_search", version: 1 }, "search");
  expect(ledger.snapshot().categories.search).toEqual({
    limit: 1, reserved: 1, consumed: 0, remaining: 0, exhausted: true,
  });
  ledger.release(token);
  expect(ledger.snapshot().categories.search.remaining).toBe(1);
});

it("keeps an externally attempted failure consumed", () => {
  const ledger = new ToolBudgetLedger({ categoryCalls: { search: 1 } });
  const token = ledger.reserve({ name: "web_search", version: 1 }, "search");
  ledger.commit(token);
  ledger.release(token);
  expect(ledger.snapshot().categories.search.consumed).toBe(1);
});
~~~

- [ ] **Step 2: Run the tests and observe the missing API**

Run: npx vitest run packages/tool-platform/src/budget.test.ts packages/tool-platform/src/runner.test.ts

Expected: FAIL because commit and snapshot do not exist.

- [ ] **Step 3: Implement reservation and snapshot state**

~~~ts
export interface BudgetDimensionSnapshot {
  limit?: number;
  reserved: number;
  consumed: number;
  remaining?: number;
  exhausted: boolean;
}

export interface ToolBudgetSnapshot {
  total: BudgetDimensionSnapshot;
  categories: Record<ToolMeterCategory, BudgetDimensionSnapshot>;
}

type TokenState = "reserved" | "committed" | "released" | "completed";

commit(token: ToolBudgetToken): void {
  const record = this.#requireOwnedRecord(token);
  if (record.state !== "reserved") throw new ToolBudgetError("invalid budget token state");
  record.state = "committed";
  this.#moveReservedToConsumed(record);
}
~~~

Make reserve check reserved + consumed atomically. Release returns uncommitted quota; release after commit retains consumption. Snapshot returns frozen copies.

- [ ] **Step 4: Commit immediately before executor dispatch**

~~~ts
if (signal.aborted) {
  ledger.release(token);
  return cancel(makeToolFailure("cancelled", 1, false));
}
ledger.commit(token);
attempts = 1;
emit({ type: "started" });
const outcome = await runAttempt(options);
~~~

Keep network tool maxRetries at zero, so a network retry is a new model tool call.

- [ ] **Step 5: Run focused tests and commit**

Run: npx vitest run packages/tool-platform/src/budget.test.ts packages/tool-platform/src/runner.test.ts packages/tool-platform/src/runner-concurrency.test.ts packages/tool-platform/src/runner-network-cap.test.ts

Expected: PASS.

~~~bash
git add packages/tool-platform/src/budget.ts packages/tool-platform/src/runner.ts packages/tool-platform/src/index.ts packages/tool-platform/src/budget.test.ts packages/tool-platform/src/runner.test.ts
git commit -m "feat: expose committed tool budget snapshots"
~~~

---

### Task 2: Add pure run control and batch admission

**Files:**
- Create: apps/desktop/src/worker/agent-run-control.ts
- Create: apps/desktop/src/worker/agent-run-control.test.ts
- Create: apps/desktop/src/worker/tool-batch-admission.ts
- Create: apps/desktop/src/worker/tool-batch-admission.test.ts

**Interfaces:**
- Consumes ToolBudgetSnapshot.
- Produces createAgentRunControl(policy, deadlineAt).
- Produces planToolBatch({ calls, snapshot, priorResults, turnIndex }).
- Has no Pi or Search Provider dependency.

- [ ] **Step 1: Write failing state transition tests**

~~~ts
it("keeps fetch available after search exhaustion", () => {
  const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);
  control.observeSnapshot(snapshot({ search: 0, fetch: 2 }));
  expect(control.availableNetworkTools()).toEqual(["read_webpage"]);
  expect(control.phase()).toBe("deciding");
});

it("reserves the final model turn", () => {
  const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);
  for (let i = 0; i < 5; i += 1) control.recordToolDecisionTurn();
  expect(control.phase()).toBe("synthesizing");
});
~~~

- [ ] **Step 2: Write failing batch trim and reuse tests**

~~~ts
it("trims independently by category", () => {
  const plan = planToolBatch({
    calls: [search("a"), search("b"), search("c"), fetch("https://a.test")],
    snapshot: snapshot({ search: 2, fetch: 1 }),
    priorResults: new Map(),
    turnIndex: 1,
  });
  expect(plan.admitted.map((x) => x.id)).toEqual(["search-a", "search-b", "fetch-a"]);
  expect(plan.skipped.map((x) => x.id)).toEqual(["search-c"]);
});

it("reuses an exact successful query without spending quota", () => {
  const plan = planToolBatch({
    calls: [search("  Unitree  ")],
    snapshot: snapshot({ search: 1, fetch: 1 }),
    priorResults: new Map([["web_search:unitree", completedSearchResult]]),
    turnIndex: 2,
  });
  expect(plan.reused).toHaveLength(1);
  expect(plan.admitted).toHaveLength(0);
});
~~~

- [ ] **Step 3: Run tests and observe missing modules**

Run: npx vitest run apps/desktop/src/worker/agent-run-control.test.ts apps/desktop/src/worker/tool-batch-admission.test.ts

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement focused pure types and functions**

~~~ts
export type PlannedDisposition = "admitted" | "skipped" | "reused";

export interface ToolBatchPlan {
  batchId: string;
  turnIndex: number;
  admitted: PlannedToolCall[];
  skipped: PlannedToolCall[];
  reused: PlannedToolCall[];
  budgetBefore: ToolBudgetSnapshot;
}
~~~

Normalize query by trimming, collapsing whitespace, and lowercasing ASCII. Normalize URLs with new URL(value).href. Do not add semantic similarity.

- [ ] **Step 5: Run tests and commit**

Run: npx vitest run apps/desktop/src/worker/agent-run-control.test.ts apps/desktop/src/worker/tool-batch-admission.test.ts

Expected: PASS.

~~~bash
git add apps/desktop/src/worker/agent-run-control.ts apps/desktop/src/worker/agent-run-control.test.ts apps/desktop/src/worker/tool-batch-admission.ts apps/desktop/src/worker/tool-batch-admission.test.ts
git commit -m "feat: add budget-aware chat run control"
~~~

---

### Task 3: Integrate dynamic budgets and batch admission into Pi Chat

**Files:**
- Create: apps/desktop/src/worker/runtime-budget-context.ts
- Create: apps/desktop/src/worker/runtime-budget-context.test.ts
- Modify: apps/desktop/src/worker/pi-chat-agent.ts
- Modify: apps/desktop/src/worker/pi-chat-agent-test-helpers.ts
- Modify: apps/desktop/src/worker/pi-chat-agent.test.ts
- Modify: apps/desktop/src/worker/pi-tool-adapter.ts
- Modify: apps/desktop/src/worker/pi-tool-adapter.test.ts
- Modify: apps/desktop/src/worker/tool-runtime.ts

**Interfaces:**
- Produces buildRuntimeBudgetContext(control): string.
- Extends PiToolSessionProvider with budgetSnapshot(traceId) and synthetic activity recording.
- Uses Pi beforeToolCall to plan once per assistant tool batch.
- Uses prepareNextTurnWithContext to refresh Prompt and available tools.

- [ ] **Step 1: Write failing Prompt and independent tool tests**

~~~ts
it("reports current independent quotas", () => {
  const text = buildRuntimeBudgetContext(control({ search: 2, fetch: 3, turns: 3 }));
  expect(text).toContain("web_search: remaining 2 of 4");
  expect(text).toContain("read_webpage: remaining 3 of 3");
  expect(text).toContain("final_answer_turns_reserved: 1");
});

it("removes only exhausted search", async () => {
  const next = await runPrepareNextTurn({ searchRemaining: 0, fetchRemaining: 2 });
  expect(next.context.tools.map((tool) => tool.name)).toEqual(["read_webpage"]);
});
~~~

- [ ] **Step 2: Write failing overflow and fatal-error tests**

~~~ts
it("executes only the remaining searches in one emitted batch", async () => {
  const result = await runOnlineBatch({ searches: 8 });
  expect(result.providerSearchCalls).toHaveLength(4);
  expect(result.activities.filter((x) => x.status === "skipped")).toHaveLength(4);
  expect(result.nextTools).not.toContain("web_search");
});

it("closes search after authentication failure but preserves fetch", async () => {
  const result = await runOnlineBatch({
    searchFailure: "authentication_failed",
    knownUrls: ["https://a.test"],
  });
  expect(result.nextTools).toEqual(["read_webpage"]);
});
~~~

- [ ] **Step 3: Run Worker tests and observe current blanket shutdown**

Run: npx vitest run apps/desktop/src/worker/runtime-budget-context.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/pi-tool-adapter.test.ts apps/desktop/src/worker/tool-runtime.test.ts

Expected: FAIL because quota context and skipped/reused states are absent.

- [ ] **Step 4: Implement Pi hook integration**

~~~ts
beforeToolCall: async ({ assistantMessage, toolCall }) => {
  const plan = getOrCreateBatchPlan(assistantMessage, control, toolSessions);
  const decision = plan.byCallId.get(toolCall.id);
  if (decision?.disposition === "skipped") {
    return {
      block: true,
      reason: JSON.stringify({
        status: "skipped",
        code: "budget_trimmed",
        budgetConsumed: false,
      }),
    };
  }
  return undefined;
},
prepareNextTurnWithContext: ({ message, toolResults, context }) => {
  control.recordCompletedTurn(message, toolResults);
  return {
    context: {
      ...context,
      systemPrompt: composeSystemPrompt(basePrompt, buildRuntimeBudgetContext(control)),
      tools: filterTools(requestTools, control.availableNetworkTools()),
    },
  };
}
~~~

Return cached successful payloads through the AgentTool wrapper for reused calls. Preserve one Pi result per original toolCallId. Put the batch summary in next-turn runtime context, never in an unmatched tool result.

- [ ] **Step 5: Replace blanket budget shutdown and verify synthesis**

Delete the current rule that turns any budget_exceeded into tools: []. Only AgentRunControl transitions to synthesis. On transition set tools to [], queue one synthesis follow-up, and stream only that final response.

Run: npx vitest run apps/desktop/src/worker/runtime-budget-context.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/pi-tool-adapter.test.ts apps/desktop/src/worker/tool-runtime.test.ts

Expected: PASS.

- [ ] **Step 6: Commit Worker integration**

~~~bash
git add apps/desktop/src/worker/runtime-budget-context.ts apps/desktop/src/worker/runtime-budget-context.test.ts apps/desktop/src/worker/pi-chat-agent.ts apps/desktop/src/worker/pi-chat-agent-test-helpers.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/pi-tool-adapter.ts apps/desktop/src/worker/pi-tool-adapter.test.ts apps/desktop/src/worker/tool-runtime.ts
git commit -m "feat: enforce budget-aware web tool batches"
~~~

---

### Task 4: Persist turn, batch, skipped, and reused activity

**Files:**
- Modify: packages/contracts/src/chat.ts
- Modify: packages/contracts/src/tools.ts
- Modify: packages/contracts/src/worker.ts
- Modify: packages/contracts/src/contracts.test.ts
- Modify: packages/persistence/src/migrations.ts
- Modify: packages/persistence/src/types.ts
- Modify: packages/persistence/src/tool-execution-repository.ts
- Modify: packages/persistence/src/tool-execution-row-validation.ts
- Modify: packages/persistence/src/tool-execution.test.ts
- Modify: packages/application/src/chat-service.ts
- Modify: packages/application/src/chat-service-persistence.test.ts
- Modify: apps/desktop/src/worker/tool-runtime.ts

**Interfaces:**
- Extends activity and persistence status with skipped and reused.
- Adds agentTurnIndex, batchId, toolCallId, and budgetConsumed.
- Adds recordSynthetic(record) for non-executed terminal activity.
- Adds SQLite migration version 10.

- [ ] **Step 1: Write failing contract and migration tests**

~~~ts
expect(Value.Check(AgentWorkerEventSchema, {
  requestId: "req-1",
  type: "tool_activity",
  callKey: "call-5",
  name: "web_search",
  status: "skipped",
  agentTurnIndex: 2,
  batchId: "batch-2",
  budgetConsumed: false,
})).toBe(true);

expect(columns).toEqual(expect.arrayContaining([
  "agent_turn_index", "batch_id", "tool_call_id", "budget_consumed",
]));
~~~

- [ ] **Step 2: Run tests and observe schema rejection**

Run: npx vitest run packages/contracts/src/contracts.test.ts packages/persistence/src/tool-execution.test.ts packages/application/src/chat-service-persistence.test.ts

Expected: FAIL because the statuses and columns are absent.

- [ ] **Step 3: Implement migration version 10**

~~~sql
CREATE TABLE tool_executions_v10(
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  project_id TEXT,
  actor TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','skipped','reused')),
  agent_turn_index INTEGER,
  batch_id TEXT,
  tool_call_id TEXT,
  budget_consumed INTEGER NOT NULL DEFAULT 0 CHECK(budget_consumed IN (0,1)),
  input_summary_json TEXT,
  output_summary_json TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  bytes_received INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);
~~~

Copy existing rows, rebuild indexes, drop the old table, and rename the new table within the migration transaction.

- [ ] **Step 4: Implement terminal synthetic records and application mapping**

~~~ts
recordSynthetic(record: ToolExecutionSynthetic): void {
  assertSyntheticStatus(record.status);
  assert(record.attempts === 0);
  assert(record.budgetConsumed === false);
  insertTerminalSyntheticRow(record);
}
~~~

Map all display statuses into ChatMessage.toolExecutions. Never expose input/output payloads or raw error text to Renderer.

- [ ] **Step 5: Run tests and commit**

Run: npx vitest run packages/contracts/src/contracts.test.ts packages/persistence/src/tool-execution.test.ts packages/persistence/src/tool-execution-robustness.test.ts packages/application/src/chat-service-persistence.test.ts

Expected: PASS.

~~~bash
git add packages/contracts/src/chat.ts packages/contracts/src/tools.ts packages/contracts/src/worker.ts packages/contracts/src/contracts.test.ts packages/persistence/src/migrations.ts packages/persistence/src/types.ts packages/persistence/src/tool-execution-repository.ts packages/persistence/src/tool-execution-row-validation.ts packages/persistence/src/tool-execution.test.ts packages/application/src/chat-service.ts packages/application/src/chat-service-persistence.test.ts apps/desktop/src/worker/tool-runtime.ts
git commit -m "feat: persist chat tool batch decisions"
~~~

---

### Task 5: Render batch-aware activity without false failures

**Files:**
- Modify: apps/desktop/src/renderer/state/chat.ts
- Modify: apps/desktop/src/renderer/state/chat.test.ts
- Modify: apps/desktop/src/renderer/components/ToolActivity.tsx
- Modify: apps/desktop/src/renderer/App-chat.test.tsx
- Modify: apps/desktop/src/renderer/styles/chat.css

**Interfaces:**
- Consumes the Task 4 contract.
- Groups activities by agentTurnIndex and batchId.
- Uses red only for executed failures; skipped is amber/neutral and reused is gray.

- [ ] **Step 1: Write failing restoration and presentation tests**

~~~ts
it("restores skipped and reused activities", () => {
  const state = reducer(initialChatState, loadMessagesWith([
    { callKey: "a", name: "web_search", status: "skipped", batchId: "b1", agentTurnIndex: 1, budgetConsumed: false },
    { callKey: "b", name: "web_search", status: "reused", batchId: "b1", agentTurnIndex: 1, budgetConsumed: false },
  ]));
  expect(state.messages[0]?.toolActivities.map((x) => x.status))
    .toEqual(["skipped", "reused"]);
});

expect(screen.getByText("3 个搜索因本轮额度跳过")).toBeInTheDocument();
expect(screen.queryAllByText("调用失败")).toHaveLength(0);
~~~

- [ ] **Step 2: Run Renderer tests and observe failure**

Run: npx vitest run apps/desktop/src/renderer/state/chat.test.ts apps/desktop/src/renderer/App-chat.test.tsx

Expected: FAIL because Renderer only knows running/completed/failed.

- [ ] **Step 3: Implement grouped statuses**

~~~ts
const STATUS_LABELS: Record<ToolActivityView["status"], string> = {
  running: "调用中",
  completed: "已完成",
  failed: "调用失败",
  skipped: "已跳过",
  reused: "已复用",
};

const trimmedCount = activities.filter(
  (x) => x.status === "skipped" && x.errorCode === "budget_trimmed",
).length;
~~~

Keep individual rows in expanded batches and show one collapsed trim summary. Preserve current loading and auto-collapse behavior.

- [ ] **Step 4: Run Renderer tests and commit**

Run: npx vitest run apps/desktop/src/renderer/state/chat.test.ts apps/desktop/src/renderer/App-chat.test.tsx apps/desktop/src/renderer/App-chat-edge.test.tsx

Expected: PASS.

~~~bash
git add apps/desktop/src/renderer/state/chat.ts apps/desktop/src/renderer/state/chat.test.ts apps/desktop/src/renderer/components/ToolActivity.tsx apps/desktop/src/renderer/App-chat.test.tsx apps/desktop/src/renderer/styles/chat.css
git commit -m "feat: show budget-aware tool activity"
~~~

---

### Task 6: Verify the complete Chat path and package the manual build

**Files:**
- Test: apps/desktop/src/main/agent-worker-runtime.test.ts
- Test: packages/application/src/chat-service.test.ts
- Output: release/mac-arm64/Deepfield.app

**Interfaces:**
- Verifies online/offline streaming, independent budgets, batch trimming, failure feedback, persistence, and unchanged provider adapters.
- Produces a refreshed unsigned macOS ARM64 app.

- [ ] **Step 1: Add one cross-layer policy test**

~~~ts
it("keeps approved Chat budgets and reserves synthesis", async () => {
  const request = await captureWorkerRequest({ webSearch: true });
  expect(request.toolAccess).toEqual({
    network: "enabled",
    maxAgentTurns: 6,
    maxSearchCalls: 4,
    maxFetchCalls: 3,
  });
});
~~~

- [ ] **Step 2: Run the focused Harness suite**

Run: npx vitest run packages/tool-platform/src/budget.test.ts packages/tool-platform/src/runner.test.ts apps/desktop/src/worker/agent-run-control.test.ts apps/desktop/src/worker/tool-batch-admission.test.ts apps/desktop/src/worker/runtime-budget-context.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/pi-tool-adapter.test.ts packages/persistence/src/tool-execution.test.ts packages/application/src/chat-service-persistence.test.ts apps/desktop/src/renderer/state/chat.test.ts apps/desktop/src/renderer/App-chat.test.tsx

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run: npm run check

Expected: typecheck and every Vitest suite PASS.

Run: npm run build

Expected: all Electron/Vite targets PASS.

- [ ] **Step 4: Package and verify**

Run: npm run dist:dir

Expected: release/mac-arm64/Deepfield.app is rebuilt and app.asar has the current modification time.

- [ ] **Step 5: Commit integration-only fixes if needed**

If verification required no changes, do not create an empty commit. Otherwise:

~~~bash
git add apps/desktop/src/main/agent-worker-runtime.test.ts packages/application/src/chat-service.test.ts apps/desktop/src/worker/pi-chat-agent.ts apps/desktop/src/renderer/state/chat.ts
git commit -m "test: verify budget-aware chat harness"
~~~
