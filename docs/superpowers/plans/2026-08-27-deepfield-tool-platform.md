# Deepfield Reusable Tool Platform Implementation Plan

> **Plan status update (2026-09-07):** Historical implementation plan for the
> Tool Platform baseline. Current product work proceeds from Chat-1 under
> `docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`; the
> benchmark sequence in this file is no longer a product-development gate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi-native, versioned and policy-controlled Tool execution platform, then validate it with safe public-web retrieval and a measured humanoid-robot search-provider benchmark.

**Architecture:** Pi continues to own LLM Tool Calling through native `AgentTool` objects. A Deepfield adapter turns each registered Tool Definition into an `AgentTool`, while Pi Agents, future Capabilities and deterministic backend services all execute through the same Tool Runner in the existing Electron utility process. The Runner enforces schemas, ToolSets, permissions, budgets, retries, cancellation, concurrency, audit and a single terminal event; public web bodies remain in a trace-scoped in-memory ResourceStore and are never persisted.

**Tech Stack:** Node.js 24.18.x, Electron 43.4.0, TypeScript 7.0.2 ESM, TypeBox 1.3.7, Pi Agent Core/Pi AI 0.84.3, `node:sqlite`, Vitest 4.1.11, React 19.2.7, Playwright Electron 1.62.1, `ipaddr.js` 2.2.0, `cheerio` 1.1.2, `pdfjs-dist` 4.10.38.

**Spec:** `docs/superpowers/specs/2026-08-27-deepfield-tool-platform-design.md`

## Global Constraints

- Start from accepted P1 commit `2d43a3e` plus approved Plan 2 design commit `e1815e5`; create `codex/tool-platform` when execution begins.
- Keep Electron `43.4.0`, Pi packages `0.84.3`, TypeBox `1.3.7` and every dependency exact; use `--save-exact`.
- Do not fork or patch Pi. Agent-facing tools are Pi `AgentTool` adapters backed by Deepfield definitions.
- Run Tool executors in the existing Electron utility process, never Renderer and never Electron Main.
- Keep SQLite and SecretStore in Main. Utility uses one typed, correlated Host RPC for required audit acknowledgements and permitted Provider-secret lookup; no generic database or secret primitive crosses the boundary.
- Renderer receives no arbitrary Tool, URL, network, filesystem, shell, secret or database primitive.
- ToolSet and policy are deny-by-default; an Agent cannot add tools or raise budgets.
- Only public HTTP/HTTPS on ports 80/443 is allowed; validate the address used by the actual connection and every redirect.
- Never send Chromium cookies or browser session state; never bypass login, paywalls or CAPTCHA.
- Full HTML and PDF bodies are trace-scoped in-memory resources only. SQLite, logs, IPC events and Agent transcripts must not contain full bodies.
- Default request limits: connect 10 s, total 30 s, 5 redirects, HTML 8 MiB, PDF 32 MiB, link-check fallback 1 MiB.
- Default trace limits: 12 Tool calls, 1 search, 3 link checks, 3 fetches, global concurrency 4 and per-network-Tool concurrency 2.
- Per trace ResourceStore limits: 4 resources, 40 MiB total, 10-minute TTL.
- Retry at most twice after the initial attempt and only for classified transient failures.
- All failures exposed outside an executor use stable safe codes; do not leak inputs, keys, provider messages, response bodies or exception causes.
- Preserve P1 Chat behavior: normal Chat remains `tools: []` in this plan.
- Preserve ignored `docs/架构图/`; do not read, modify, stage or delete user-owned architecture images during implementation.
- Prefer focused files below 200 lines; split production files before 300 lines.
- Every task follows RED → GREEN → full relevant regression → `git diff --check` → one focused commit.
- Live DeepSeek and search-provider tests are opt-in only. Default unit, integration and E2E suites are deterministic and network-free.

---

## Planned File Structure

```text
packages/contracts/src/tools.ts                  serializable Tool identities, calls, results and events
packages/contracts/src/worker.ts                 Chat/Tool utility request and event unions

packages/tool-platform/package.json
packages/tool-platform/src/definition.ts         Tool Definition, Executor and run context types
packages/tool-platform/src/registry.ts           immutable versioned Registry
packages/tool-platform/src/tool-set.ts           exact Tool grants
packages/tool-platform/src/policy.ts              authorization and confirmation decisions
packages/tool-platform/src/budget.ts              atomic call/byte/time/concurrency budgets
packages/tool-platform/src/errors.ts              stable safe failures
packages/tool-platform/src/events.ts              event sequencing and terminal guard
packages/tool-platform/src/retry.ts               cancellable retry policy and injected clock
packages/tool-platform/src/runner.ts              single execution pipeline
packages/tool-platform/src/audit.ts               audit port
packages/tool-platform/src/testing.ts             deterministic test doubles
packages/tool-platform/src/index.ts               public exports

packages/retrieval/package.json
packages/retrieval/src/url-policy.ts               scheme/host/port/address policy
packages/retrieval/src/http-transport.ts           bounded HTTP/HTTPS with checked lookup/redirects
packages/retrieval/src/resource-store.ts           trace-scoped ephemeral bodies
packages/retrieval/src/fetch-tools.ts              fetch_url and fetch_pdf
packages/retrieval/src/link-tool.ts                check_link_accessibility
packages/retrieval/src/html-tool.ts                parse_html
packages/retrieval/src/pdf-tool.ts                 parse_pdf
packages/retrieval/src/search-provider.ts          normalized provider contract
packages/retrieval/src/provider-http-client.ts      fixed-origin authenticated provider transport
packages/retrieval/src/providers/*.ts              candidate adapters
packages/retrieval/src/search-tool.ts              selected search_web executor factory
packages/retrieval/src/benchmark/*.ts              fixed queries, scoring and report writer
packages/retrieval/src/index.ts                    public exports

packages/persistence/src/tool-execution-repository.ts
packages/application/src/tool-audit.ts
packages/application/src/retrieval-probe-service.ts

apps/desktop/src/worker/tool-runtime.ts             Registry/Runner/ResourceStore composition
apps/desktop/src/worker/pi-tool-adapter.ts           Definition to Pi AgentTool conversion
apps/desktop/src/worker/host-client.ts               correlated audit/secret Host RPC client
apps/desktop/src/main/tool-worker-host.ts            narrow Main-side audit/secret dispatcher
apps/desktop/src/main/tool-event-router.ts           per-sender Tool event routing
apps/desktop/src/renderer/features/developer/ToolTraceView.tsx

tests/fixtures/retrieval/*.html
tests/fixtures/retrieval/*.pdf
tests/e2e/tool-platform.spec.ts
benchmarks/humanoid-robot/*.json                    definitions and final selection record
```

Ignored generated paths:

```text
benchmark-results/
test-results/
playwright-report/
```

---

### Task 1: Tool Contracts and Immutable Versioned Registry

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.base.json`
- Create: `packages/tool-platform/package.json`
- Create: `packages/contracts/src/tools.ts`
- Create: `packages/tool-platform/src/definition.ts`
- Create: `packages/tool-platform/src/registry.ts`
- Create: `packages/tool-platform/src/index.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/tools.test.ts`
- Test: `packages/tool-platform/src/registry.test.ts`

**Interfaces:**
- Produces `ToolIdentity`, `ToolCallRequest`, `ToolExecutionResult`, `ToolExecutionEvent` and `ToolManifestEntry` schemas.
- Produces `ToolDefinition<TInput, TOutput>`, `ToolExecutor`, `ToolRegistry.register()`, `ToolRegistry.freeze()`, `ToolRegistry.resolve()` and `ToolRegistry.manifest()`.
- Registry lookup always uses exact `{ name, version }`; version is a positive integer.

- [ ] **Step 1: Write failing serializable-contract tests**

Define tests that accept a minimal call and reject blank names, version `0`, extra properties, non-object input, malformed success/failure results and events without execution/trace correlation.

```ts
const call = {
  executionId: "exec-1",
  traceId: "trace-1",
  tool: { name: "fetch_url", version: 1 },
  input: { url: "https://example.com" },
};
expect(Value.Check(ToolCallRequestSchema, call)).toBe(true);
expect(Value.Check(ToolCallRequestSchema, { ...call, tool: { name: "", version: 0 } })).toBe(false);
```

- [ ] **Step 2: Run the contract test and record RED**

Run: `npm test -- packages/contracts/src/tools.test.ts`

Expected: FAIL because `tools.ts` and its schemas do not exist.

- [ ] **Step 3: Add the workspace package and exact core types**

Add `@deepfield/tool-platform` to TypeScript paths and include patterns. Do not add external dependencies in this task. Define JSON-safe request/result/event fields with `additionalProperties: false` at every trust boundary.

```ts
export interface ToolDefinition<TInput extends TSchema, TOutput extends TSchema> {
  identity: { name: string; version: number };
  label: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  effect: ToolEffect;
  timeoutMs: number;
  retry: ToolRetryPolicy;
  concurrency: number;
  meter: ToolMeter;
  model?: { formatOutput(output: Static<TOutput>): string };
  execute: ToolExecutor<Static<TInput>, Static<TOutput>>;
}
```

- [ ] **Step 4: Write failing Registry tests**

Test exact resolution, duplicate rejection, unknown versions, freeze behavior, deterministic manifest order and manifest executor omission.

```ts
const registry = new ToolRegistry();
registry.register(definitionV1);
expect(registry.resolve({ name: "echo", version: 1 })).toBe(definitionV1);
expect(() => registry.register(definitionV1)).toThrow(ToolRegistryError);
registry.freeze();
expect(() => registry.register(definitionV2)).toThrow(/frozen/);
expect(JSON.stringify(registry.manifest())).not.toContain("execute");
```

- [ ] **Step 5: Implement the minimal immutable Registry**

Normalize no names silently: invalid definitions fail. Freeze returns no mutation handle. Manifest order is name ascending then version ascending, so tests and Pi Tool construction are deterministic.

- [ ] **Step 6: Verify Task 1**

Run:

```bash
npm test -- packages/contracts/src/tools.test.ts packages/tool-platform/src/registry.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: all tests pass; existing P1 tests remain green; no Renderer or worker changes.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json packages/contracts packages/tool-platform
git commit -m "feat: add versioned tool registry contracts"
```

---

### Task 2: ToolSet, Policy Decisions and Atomic Budgets

**Files:**
- Create: `packages/tool-platform/src/tool-set.ts`
- Create: `packages/tool-platform/src/policy.ts`
- Create: `packages/tool-platform/src/budget.ts`
- Modify: `packages/tool-platform/src/definition.ts`
- Modify: `packages/tool-platform/src/index.ts`
- Test: `packages/tool-platform/src/policy.test.ts`
- Test: `packages/tool-platform/src/budget.test.ts`

**Interfaces:**
- Produces immutable `ToolSet`, `ToolGrant`, `ToolRunContext`, `PolicyDecision` and `ToolPolicy.evaluate()`.
- Produces `ToolBudgetLedger.reserve()`, `recordBytes()`, `complete()` and `release()`.
- Policy runs before an executor and returns only `allow`, `deny` or `confirmation_required`.

- [ ] **Step 1: Write failing deny-by-default Policy tests**

Cover no ToolSet, exact version mismatch, actor mismatch, project mismatch, disallowed effect, missing confirmation and a valid developer probe grant.

```ts
expect(policy.evaluate(request, contextWithoutGrant)).toEqual({
  decision: "deny",
  code: "tool_not_allowed",
});
expect(executorCalls).toBe(0);
```

- [ ] **Step 2: Run Policy tests and record RED**

Run: `npm test -- packages/tool-platform/src/policy.test.ts`

Expected: FAIL because Policy and ToolSet do not exist.

- [ ] **Step 3: Implement immutable exact-version ToolSets**

Use plain readonly data copied and frozen at construction. A grant includes exact identity, allowed actor/effect, optional project ID, optional allowed host patterns and maximum parameter limits. Reject duplicate grants and wildcard versions.

```ts
export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; code: "tool_not_allowed" | "permission_denied" }
  | { decision: "confirmation_required"; confirmationKind: string };
```

- [ ] **Step 4: Write failing atomic-budget tests**

Test call count, per-tool count, search/fetch/check categories, bytes, elapsed deadline, global concurrency and per-tool concurrency. Start two reservations simultaneously against one remaining call and assert exactly one succeeds.

```ts
const results = await Promise.allSettled([
  ledger.reserve(searchIdentity),
  ledger.reserve(searchIdentity),
]);
expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
```

- [ ] **Step 5: Implement synchronous reservation tokens**

JavaScript execution is single-threaded inside one worker, so reservation mutation must complete synchronously before returning a token. Tokens are single-use; completion reconciles actual bytes and release removes only concurrency, not already consumed attempts.

- [ ] **Step 6: Verify Task 2**

Run:

```bash
npm test -- packages/tool-platform/src/policy.test.ts packages/tool-platform/src/budget.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: all matrix and race tests pass; denied operations never call an executor.

- [ ] **Step 7: Commit**

```bash
git add packages/tool-platform/src
git commit -m "feat: enforce tool sets and execution budgets"
```

---

### Task 3: Tool Runner Lifecycle, Safe Errors and Test Kit

**Files:**
- Create: `packages/tool-platform/src/errors.ts`
- Create: `packages/tool-platform/src/events.ts`
- Create: `packages/tool-platform/src/retry.ts`
- Create: `packages/tool-platform/src/audit.ts`
- Create: `packages/tool-platform/src/runner.ts`
- Create: `packages/tool-platform/src/testing.ts`
- Modify: `packages/tool-platform/src/index.ts`
- Test: `packages/tool-platform/src/runner.test.ts`
- Test: `packages/tool-platform/src/runner-lifecycle.test.ts`
- Test: `packages/tool-platform/src/runner-secrecy.test.ts`

**Interfaces:**
- Produces `ToolRunner.execute(call, context, signal, onEvent): Promise<ToolExecutionResult>`.
- Produces `ToolFailureCode`, `ToolExecutionError`, `ToolEventSink`, `ToolAuditSink`, `RetryClock` and deterministic fakes.
- Runner emits ordered events with monotonically increasing sequence and exactly one terminal event.

- [ ] **Step 1: Write failing happy-path and validation tests**

Assert the executor sees validated typed input, output is schema-checked, budget/audit finalize before `completed`, and event order is `accepted → validated → policy_checked → started → completed`.

```ts
const result = await runner.execute(call, context, signal, events.push.bind(events));
expect(result).toMatchObject({ status: "completed", executionId: "exec-1" });
expect(events.map((event) => event.type)).toEqual([
  "accepted", "validated", "policy_checked", "started", "completed",
]);
```

- [ ] **Step 2: Run Runner tests and record RED**

Run: `npm test -- packages/tool-platform/src/runner.test.ts`

Expected: FAIL because Runner does not exist.

- [ ] **Step 3: Implement the single execution pipeline**

Resolve exact Tool, validate with `Value.Check`, evaluate Policy, reserve Budget, execute, validate output, finalize Audit/Budget, then emit terminal. Never call `completed` before required audit persistence succeeds.

- [ ] **Step 4: Write failing timeout/retry/cancel/race tests**

Cover pre-aborted, mid-run abort, timeout, executor reject, invalid output, audit failure, retryable 429/5xx, non-retryable 401/input/policy/parse failures, abort during backoff, late progress and simultaneous timeout/completion.

Use `FakeRetryClock`; tests must not sleep.

- [ ] **Step 5: Implement classified retry and a terminal guard**

One initial attempt plus at most two retries. A settled execution suppresses all late progress/results. Cancellation maps to `cancelled`, timeout to `timeout`, and executor exceptions to fixed `executor_failed`; raw causes remain private and non-enumerable or are discarded.

- [ ] **Step 6: Write and pass secrecy tests**

Inject a secret in input, thrown error message, `cause`, enumerable properties, progress and malformed output. Assert the serialized result, every event and audit record contain none of it.

```ts
const serialized = JSON.stringify({ result, events, audit: audit.records });
expect(serialized).not.toContain("sk-secret-value");
expect(serialized).not.toContain("provider raw response");
```

- [ ] **Step 7: Verify Task 3**

Run:

```bash
npm test -- packages/tool-platform/src/runner.test.ts packages/tool-platform/src/runner-lifecycle.test.ts packages/tool-platform/src/runner-secrecy.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: deterministic tests pass with no network and no real waits; each execution has one terminal event.

- [ ] **Step 8: Commit**

```bash
git add packages/tool-platform/src
git commit -m "feat: add policy controlled tool runner"
```

---
### Task 4: Durable Sanitized Tool Audit

**Files:**
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/repositories.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `packages/persistence/src/tool-execution-repository.ts`
- Create: `packages/application/src/tool-audit.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/persistence/src/tool-execution.test.ts`
- Test: `packages/application/src/tool-audit.test.ts`

**Interfaces:**
- Produces `ToolExecutionRepository.start()`, `finish()`, `getById()` and `listRecent()`.
- Produces `SqliteToolAudit` implementing `ToolAuditSink`.
- `SqliteToolAudit` is a Main-process adapter; the Utility-process bridge is added in Task 5.
- Persists sanitized execution metadata only; no body, parse text, key, header or exception payload column exists.

- [ ] **Step 1: Write a failing migration and repository test**

Open a P1-version database, migrate, start an execution, finish it, close/reopen and assert the record survives. Assert migration 2 is applied exactly once.

Use this table shape:

```sql
CREATE TABLE tool_executions(
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  project_id TEXT,
  actor TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
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
```

- [ ] **Step 2: Run persistence tests and record RED**

Run: `npm test -- packages/persistence/src/tool-execution.test.ts`

Expected: FAIL because migration 2 and repository do not exist.

- [ ] **Step 3: Implement migration 2 and repository**

Follow the existing transaction model. Add indexes on `trace_id`, `project_id` and `(started_at, id)`. Validate terminal transition: only `running` can finish; finishing twice or finishing an unknown ID fails.

- [ ] **Step 4: Add rollback and no-body tests**

Force migration creation and final update failures. Verify tracking and business tables roll back. Store adversarial summaries and reject keys named `body`, `html`, `pdf`, `text`, `apiKey`, `authorization`, `cookie`, `cause` or `stack` recursively.

- [ ] **Step 5: Implement `SqliteToolAudit`**

Map Runner audit data to the repository, whitelist summary fields per Tool identity and discard all unknown properties. Runner completion must fail safely if final audit persistence fails.

- [ ] **Step 6: Verify Task 4**

Run:

```bash
npm test -- packages/persistence/src/tool-execution.test.ts packages/application/src/tool-audit.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: audit survives reopen; rollback works; recursive leak scan finds no forbidden content.

- [ ] **Step 7: Commit**

```bash
git add packages/persistence/src packages/application/src
git commit -m "feat: persist sanitized tool executions"
```

---

### Task 5: Utility Worker Tool Protocol and Pi AgentTool Adapter

**Files:**
- Create: `packages/contracts/src/worker.ts`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/application/src/ports.ts`
- Modify: `apps/desktop/src/main/agent-worker-client.ts`
- Modify: `apps/desktop/src/main/agent-worker-client.test.ts`
- Modify: `apps/desktop/src/main/agent-worker-client-lifecycle.test.ts`
- Create: `apps/desktop/src/main/tool-worker-host.ts`
- Create: `apps/desktop/src/main/tool-worker-host.test.ts`
- Modify: `apps/desktop/src/worker/message-loop.ts`
- Modify: `apps/desktop/src/worker/message-loop.test.ts`
- Modify: `apps/desktop/src/worker/message-loop-lifecycle.test.ts`
- Create: `apps/desktop/src/worker/tool-runtime.ts`
- Create: `apps/desktop/src/worker/pi-tool-adapter.ts`
- Create: `apps/desktop/src/worker/pi-tool-adapter.test.ts`
- Create: `apps/desktop/src/worker/host-client.ts`
- Create: `apps/desktop/src/worker/host-client.test.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent.ts`
- Modify: `apps/desktop/src/worker/index.ts`

**Interfaces:**
- Produces `UtilityWorkerRequestSchema = chat.prompt | tool.run` and matching event union without weakening existing Chat schemas.
- Extends the existing utility client with `sendTool(request): AsyncIterable<ToolExecutionEvent>` while preserving `AgentWorkerPort.send()`.
- Produces `createPiAgentTools(registry, runner, context): AgentTool[]` from the same Definitions used by direct calls.
- Produces a correlated internal Host RPC with only `audit.start`, `audit.finish` and `secret.getProviderKey`; `RemoteToolAuditSink` waits for Main acknowledgement before Runner completion.

- [ ] **Step 1: Write failing protocol and correlation tests**

Test valid Chat and Tool union members, malformed kinds, duplicate execution IDs, wrong execution/trace IDs, unknown events, utility exit, client dispose and request ID reuse after terminal.

```ts
const stream = client.sendTool(toolRequest);
endpoint.emitMessage({ ...startedEvent, executionId: "wrong" });
await expect(collect(stream)).rejects.toThrow(/invalid worker event/);
expect(client.pendingCount()).toBe(0);
```

- [ ] **Step 2: Run worker/client tests and record RED**

Run: `npm test -- apps/desktop/src/main/agent-worker-client apps/desktop/src/worker/message-loop`

Expected: FAIL because the protocol accepts Chat only.

- [ ] **Step 3: Extend the existing protocol with discriminated routing**

Do not create a second listener on the same utility endpoint. The existing client/message loop owns one listener and routes by request kind plus correlation ID. Keep Chat active-map semantics unchanged. Tool terminal events release pending state immediately even before consumer iteration.

- [ ] **Step 4: Write failing Host RPC boundary tests**

Test bidirectional request/response correlation for concurrent audit calls, unknown kinds, wrong correlation IDs, Main disposal, Utility disposal, worker exit, timeout and duplicate terminal replies. Assert `audit.finish` does not resolve before `SqliteToolAudit` acknowledges persistence. Assert an audit failure becomes a safe Runner failure rather than `completed`.

Test Provider-secret lookup separately: only a compiled allowlisted Provider ID is accepted; the request contains no key; the reply is delivered only to the requesting Utility client; neither key, audit summary, raw exception nor request payload appears in logs, Tool events or safe errors. The Host API must not accept arbitrary secret names, SQL, repository methods or Renderer senders.

- [ ] **Step 5: Implement the narrow Main/Utility Host RPC**

Use the existing child-process transport with a separate discriminated internal message union and one correlation map per side. Main owns `SqliteToolAudit` and `SecretStore`; Utility owns `RemoteToolAuditSink` and an allowlisted Provider-secret client. Both sides reject malformed or late messages, clear pending requests on dispose/exit and return fixed safe codes. This bridge is internal to Main and Utility and is never exposed through Preload.

- [ ] **Step 6: Write failing Pi adapter tests**

Register one fake `lookup_fact` Definition. Generate Pi tools, call `execute`, and assert input reaches Runner, progress reaches `onUpdate`, output uses Definition `model.formatOutput`, cancellation propagates and a Tool outside ToolSet is absent.

```ts
const tools = createPiAgentTools(registry, runner, runContext);
expect(tools.map((tool) => tool.name)).toEqual(["lookup_fact"]);
const result = await tools[0]!.execute("pi-call-1", { subject: "robot" }, signal, onUpdate);
expect(result.content[0]).toEqual({ type: "text", text: "fact: robot" });
```

- [ ] **Step 7: Implement the Pi adapter without duplicating policy**

Pi parameters reference Definition input Schema. `execute()` constructs a Deepfield call with fresh execution ID, invokes Runner and converts only successful structured output. Runner failures throw a safe fixed error so Pi marks `isError`; no API key or raw cause is included.

- [ ] **Step 8: Prove direct and Pi paths share one Runner**

Use a counting fake Definition and invoke it once through direct worker `tool.run` and once through Pi adapter. Assert one Registry instance, one Policy, one Budget implementation and the same `RemoteToolAuditSink` handled both, with Main persistence acknowledged before either call receives `completed`. Normal `createPiChatAgent` remains `tools: []` unless explicitly supplied a tested ToolSet.

- [ ] **Step 9: Add opt-in real DeepSeek Tool Calling smoke**

Use an offline `echo_probe` Tool and real DeepSeek only when `DEEPSEEK_API_KEY` is present. Assert the model calls the Tool and returns after Tool result; skip otherwise. The Tool itself performs no network.

- [ ] **Step 10: Verify Task 5**

Run:

```bash
npm test -- apps/desktop/src/main apps/desktop/src/worker packages/tool-platform packages/application/src/tool-audit.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all lifecycle/race tests pass; audit acknowledgement gates success; secret lookup is narrow and leak-free; build emits the utility entry; default suite makes no provider call.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts packages/application/src apps/desktop/src/main apps/desktop/src/worker
git commit -m "feat: bridge tool runner into pi utility runtime"
```

---

### Task 6: Safe HTTP/HTTPS Transport and Trace-Scoped ResourceStore

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.base.json`
- Create: `packages/retrieval/package.json`
- Create: `packages/retrieval/src/url-policy.ts`
- Create: `packages/retrieval/src/http-transport.ts`
- Create: `packages/retrieval/src/resource-store.ts`
- Create: `packages/retrieval/src/fetch-tools.ts`
- Create: `packages/retrieval/src/link-tool.ts`
- Create: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/src/url-policy.test.ts`
- Test: `packages/retrieval/src/http-transport.test.ts`
- Test: `packages/retrieval/src/resource-store.test.ts`
- Test: `packages/retrieval/src/fetch-tools.test.ts`
- Test: `packages/retrieval/src/link-tool.test.ts`

**Interfaces:**
- Produces `UrlPolicy.assertAllowed(url)` and a checked `lookup` hook used by the actual socket connection.
- Produces `SafeHttpTransport.request()` with manual redirects and bounded streaming.
- Produces `ResourceStore.put()`, `get()`, `consume()`, `releaseTrace()` and `dispose()`.
- Registers `fetch_url v1`, `fetch_pdf v1` and `check_link_accessibility v1` Definitions.

- [ ] **Step 1: Install and pin IP parsing support**

Run: `npm install --save-exact ipaddr.js@2.2.0`

Before implementation, add a compatibility test importing it under Node ESM and the Electron utility build. If the exact package fails either environment, stop this task and return a dependency decision instead of replacing it silently.

- [ ] **Step 2: Write failing URL/address policy tests**

Cover HTTP/HTTPS ports 80/443; credentials; `file:`, `data:` and unsupported schemes; IPv4 loopback/private/link-local/multicast/unspecified/metadata; IPv6 loopback/link-local/ULA/multicast/IPv4-mapped; decimal/hex-normalized hosts; DNS returning mixed public/private answers.

```ts
await expect(policy.resolveAndAssert("https://public.example", dnsReturning("10.0.0.8")))
  .rejects.toMatchObject({ code: "url_blocked" });
```

- [ ] **Step 3: Implement policy at the connection lookup boundary**

Use `node:http`, `node:https`, `node:dns` and `ipaddr.js`. Pass the checked lookup function to the request so the address validated is the address connected. Reject if any selected answer is forbidden; do not perform a safe preflight followed by an unchecked second lookup.

- [ ] **Step 4: Write failing transport tests**

Inject request/socket adapters rather than opening localhost, because production policy correctly blocks localhost. Test 10 s connect/30 s total timeout, 5 redirects, redirect revalidation, cookie/header stripping, gzip/deflate bounds, content-length precheck, streaming overrun and AbortSignal.

- [ ] **Step 5: Implement bounded manual redirects and streaming**

Disable automatic redirects. Validate every Location before the next request. Count decompressed bytes toward limits and destroy the response immediately at limit; never buffer a full oversized body.

- [ ] **Step 6: Write failing ResourceStore isolation tests**

Test opaque IDs, owner trace/project/ToolSet checks, 4-item and 40 MiB caps, 10-minute fake-clock TTL, consume/release, cancel cleanup, worker dispose and non-enumerability.

- [ ] **Step 7: Implement fetch/link Definitions**

`fetch_url` accepts HTML only and caps at 8 MiB. `fetch_pdf` accepts PDF only and caps at 32 MiB. Both return metadata plus `resourceId`, never body. Link check uses HEAD first and a 1 MiB capped GET fallback only for servers that reject or do not implement HEAD.

- [ ] **Step 8: Verify no cookies and no body persistence**

Run leak scans over Tool events, audit rows and serialized results using distinctive HTML/PDF markers. Assert request headers contain no `Cookie`, browser authorization or Chromium user profile data.

- [ ] **Step 9: Verify Task 6**

Run:

```bash
npm test -- packages/retrieval/src/url-policy.test.ts packages/retrieval/src/http-transport.test.ts packages/retrieval/src/resource-store.test.ts packages/retrieval/src/fetch-tools.test.ts packages/retrieval/src/link-tool.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: security matrix and resource cleanup pass without real network.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json packages/retrieval
git commit -m "feat: add safe public web retrieval tools"
```

---

### Task 7: HTML and PDF Parsing Tools

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/retrieval/src/html-tool.ts`
- Create: `packages/retrieval/src/pdf-tool.ts`
- Modify: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/src/html-tool.test.ts`
- Test: `packages/retrieval/src/pdf-tool.test.ts`
- Create: `tests/fixtures/retrieval/article-zh.html`
- Create: `tests/fixtures/retrieval/table-links.html`
- Create: `tests/fixtures/retrieval/noise-hidden.html`
- Create: `tests/fixtures/retrieval/report-two-pages.pdf`
- Create: `tests/fixtures/retrieval/report-empty-page.pdf`
- Create: `tests/fixtures/retrieval/report-damaged.pdf`

**Interfaces:**
- Registers `parse_html v1` and `parse_pdf v1` Definitions.
- Both consume a ResourceStore handle scoped to the current ToolRunContext.
- HTML returns title, canonical URL, normalized text, structural locators, links and truncation metadata.
- PDF returns metadata and ordered `{ page, text }` entries with truncation metadata.

- [ ] **Step 1: Pin parser dependencies and prove runtime compatibility**

Run:

```bash
npm install --save-exact cheerio@1.1.2 pdfjs-dist@4.10.38
```

Add a compatibility test that imports both packages in Node ESM, parses the smallest fixture, builds Electron and loads the same parser code in the utility bundle. If either exact version fails Node 24, Electron 43, ESM or packaging, stop and request a reviewed version change; do not silently select another release.

- [ ] **Step 2: Write failing HTML fixture tests**

Test Chinese title/body, headings, list order, table cell order, absolute/relative links, canonical URL, removal of script/style/template/noscript and hidden elements, whitespace normalization, invalid encoding fallback, 500-link cap and 200,000-character cap with `truncated: true`.

```ts
const output = await executeParseHtml(resourceId);
expect(output.title).toBe("人形机器人产业进展");
expect(output.text).toContain("量产计划");
expect(output.text).not.toContain("window.__STATE__");
expect(output.links[0]).toMatchObject({ href: "https://example.com/report" });
```

- [ ] **Step 3: Implement deterministic HTML extraction**

Use Cheerio only as a parser; do not execute scripts or load subresources. Remove unsafe/noise nodes before walking headings, paragraphs, list items, table cells and anchors in document order. Preserve enough structural locator data for later evidence work, but do not create EvidenceFragments in Plan 2.

- [ ] **Step 4: Write failing PDF fixture tests**

Test two pages with Chinese/English text, empty page retention, page numbering from 1, metadata, damaged input, password/encryption failure, 400,000-character total cap and 200-page cap.

- [ ] **Step 5: Implement text-only PDF extraction**

Use the legacy/server PDF.js ESM entry that requires no DOM or canvas for text extraction. Disable external resource fetching. Concatenate text items in stable reading order per page and retain empty pages. Destroy the loaded document and consume/release the Resource in `finally`.

- [ ] **Step 6: Prove parser failures and audit do not retain bodies**

Inject distinctive source markers into fixtures. Assert neither successful audit metadata nor failure events contain full input or more than the allowed preview/summary fields. ResourceStore no longer returns the consumed handle after success or failure.

- [ ] **Step 7: Verify Task 7**

Run:

```bash
npm test -- packages/retrieval/src/html-tool.test.ts packages/retrieval/src/pdf-tool.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all fixtures pass; utility build has no native/canvas runtime requirement; production files remain below 300 lines.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json packages/retrieval tests/fixtures/retrieval
git commit -m "feat: parse bounded html and pdf resources"
```

---

### Task 8: SearchProvider Contract, Candidate Adapters and Offline Benchmark Harness

**Files:**
- Create: `packages/retrieval/src/search-provider.ts`
- Create: `packages/retrieval/src/provider-http-client.ts`
- Create: `packages/retrieval/src/providers/brave.ts`
- Create: `packages/retrieval/src/providers/tavily.ts`
- Create: `packages/retrieval/src/providers/serper.ts`
- Create: `packages/retrieval/src/search-tool.ts`
- Create: `packages/retrieval/src/benchmark/queries.ts`
- Create: `packages/retrieval/src/benchmark/reference-companies.ts`
- Create: `packages/retrieval/src/benchmark/scoring.ts`
- Create: `packages/retrieval/src/benchmark/report.ts`
- Modify: `packages/retrieval/src/index.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `vitest.config.ts`
- Create: `vitest.live.config.ts`
- Test: `packages/retrieval/src/search-provider.test.ts`
- Test: `packages/retrieval/src/providers/provider-contract.test.ts`
- Test: `packages/retrieval/src/providers/provider-contract.live.test.ts`
- Test: `packages/retrieval/src/benchmark/scoring.test.ts`
- Test: `packages/retrieval/src/benchmark/search-benchmark.live.test.ts`
- Create: `packages/retrieval/src/providers/fixtures/*.json`
- Create: `benchmarks/humanoid-robot/queries-v1.json`
- Create: `benchmarks/humanoid-robot/reference-companies-v1.json`

**Interfaces:**
- Produces `SearchProvider.search(request, signal): Promise<NormalizedSearchResponse>`.
- Produces fixed-origin candidate adapters and `createSearchWebDefinition(provider)`.
- Produces `scoreBenchmark()` and a report writer; live output goes under ignored `benchmark-results/`.

- [ ] **Step 1: Write failing normalized-provider contract tests**

The normalized request contains query, `maxResults <= 20` and optional time range. Results contain only title, URL, snippet, one-based rank, provider and optional date. Reject extra fields, unsafe URLs, duplicate ranks and malformed dates.

```ts
expect(normalize(providerFixture)).toEqual({
  provider: "fake",
  results: [{ title: "Official", url: "https://example.com", snippet: "...", rank: 1 }],
});
```

- [ ] **Step 2: Implement fixed-origin Provider HTTP client**

Provider requests are separate from public-page fetching: base origins and paths are compiled into adapters, secrets are injected only inside Utility Process, redirects are disabled or same-origin only, response size is capped, and authorization headers are removed from every diagnostic/audit object. Use the same timeout/cancel primitives and safe error classification.

- [ ] **Step 3: Add fixture-driven candidate adapters**

For Brave, Tavily and Serper, encode current official request/response fields in one focused adapter each. Tests cover success, zero results, 401, 429 with Retry-After, 5xx, invalid JSON, missing result arrays, unsafe result URL and secret-bearing provider error. Default tests never contact providers.

- [ ] **Step 4: Reconfirm live API compatibility before accepting adapters**

With explicit opt-in and local test keys, run one query per candidate against official endpoints and record status/schema compatibility only. If a provider has changed or is unavailable, update its adapter through a reviewed change and fixture before benchmark; do not hide it behind normalization fallbacks.

- [ ] **Step 5: Freeze benchmark v1 data**

Commit exactly the ten approved queries and twelve technical reference companies from the design spec. Each live provider runs every query twice with top 20. Keep the journalist's future hidden blind-test list separate.

- [ ] **Step 6: Write failing scoring tests**

Test domain-normalized company matching, official-site coverage, link-validity denominator, noise, duplicate rate, p50/p95 latency, cost and weights `35/25/20/10/5/5`. Test hard failure when fewer than two providers complete, link validity is below 95%, Chinese queries are empty or a dangerous URL appears.

- [ ] **Step 7: Implement deterministic scoring and report output**

Separate raw measured values from normalized score. Never silently impute a missing provider run. Report query set version, reference set version, timestamps, provider configuration excluding secrets, failures, metrics and hard-gate status.

- [ ] **Step 8: Add benchmark scripts**

Keep live files outside the default suite by excluding `**/*.live.test.ts` in `vitest.config.ts`. Add `vitest.live.config.ts` that includes only `**/*.live.test.ts`, then add these exact scripts using the already installed Vitest runtime:

```json
{
  "benchmark:search": "vitest run --config vitest.live.config.ts packages/retrieval/src/benchmark/search-benchmark.live.test.ts",
  "test:providers:live": "vitest run --config vitest.live.config.ts packages/retrieval/src/providers/provider-contract.live.test.ts"
}
```

Do not add `tsx` or another runtime loader. The live benchmark test writes reports through the same report writer exercised by offline tests and fails when required environment keys are absent; it is never silently skipped after Task 9 has passed its external-key gate.

- [ ] **Step 9: Verify Task 8 offline**

Run:

```bash
npm test -- packages/retrieval/src/search-provider.test.ts packages/retrieval/src/providers/provider-contract.test.ts packages/retrieval/src/benchmark/scoring.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all fixtures and scores pass without network; `benchmark-results/` is ignored.

- [ ] **Step 10: Commit**

```bash
git add .gitignore package.json package-lock.json vitest.config.ts vitest.live.config.ts packages/retrieval benchmarks/humanoid-robot
git commit -m "feat: add search provider benchmark harness"
```

---

### Task 9: Run the Live Benchmark and Register the Selected `search_web` Tool

**Files:**
- Create: `benchmarks/humanoid-robot/provider-selection-v1.md`
- Create: `packages/retrieval/src/providers/selected-provider.ts`
- Modify: `packages/retrieval/src/search-tool.ts`
- Modify: `packages/retrieval/src/index.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/renderer/features/settings/SettingsView.tsx`
- Test: `packages/retrieval/src/search-tool.test.ts`
- Test: `apps/desktop/src/main/ipc.test.ts`
- Test: `apps/desktop/src/preload/preload-api.test.ts`
- Test: `apps/desktop/src/renderer/App-settings.test.tsx`

**Interfaces:**
- Selects exactly one Provider ID for `search_web v1` from measured results.
- Adds narrow encrypted-key APIs `settings.hasSearchProviderKey()` and `setSearchProviderKey(value)` for the selected Provider only.
- Registers `search_web v1` with normalized output and no Provider raw payload.

- [ ] **Step 1: Confirm the external benchmark gate**

Before any live call, obtain local test keys for at least two of Brave, Tavily and Serper. Verify the user has approved any account creation or paid usage. If fewer than two providers can be tested, report Task 9 blocked; do not select from fixture scores.

- [ ] **Step 2: Run live provider contract smokes**

Run: `npm run test:providers:live`

Expected: each supplied Provider performs one official-endpoint query, validates its live response and emits no secret in stdout, test reports or errors. Fix any documented API drift through a fixture-backed reviewed adapter change before the benchmark.

- [ ] **Step 3: Run the complete fixed benchmark twice per query**

Run: `npm run benchmark:search`

Expected: ignored raw result files plus a deterministic summary containing all ten queries, two runs each, top 20, metrics, hard gates, latency and cost. Interrupting the run preserves completed provider/query measurements and marks the report incomplete; an incomplete report cannot select a winner.

- [ ] **Step 4: Review automatic classifications**

Stop and return the generated ambiguous-item review queue to the main planning window/user. Do not let DSH or the benchmark code decide subjective official-domain and noise labels. Human corrections are recorded as a separate annotation file with URL, old label, new label and reason; do not edit raw provider output. Resume selection only after that review is explicitly accepted.

- [ ] **Step 5: Apply hard gates and select the highest eligible score**

At least two Providers must complete. Reject any with link validity below 95%, empty Chinese-query coverage, dangerous URL or systematic reference-company category gaps. Among eligible Providers, select the highest weighted score. If none qualifies, mark Task 9 blocked and return the measured report without registering `search_web`.

- [ ] **Step 6: Commit the selection record, not raw live output**

`provider-selection-v1.md` records dates, exact query/reference versions, candidates, measured metrics, hard-gate outcomes, selected Provider, known weaknesses and raw ignored result hashes. It contains no key and no full page.

- [ ] **Step 7: Write failing selected-provider and Settings tests**

Assert `search_web v1` uses only the selected adapter, returns normalized results, classifies auth/rate-limit failures and does not expose Provider raw response. Settings only reports configured/not configured, never returns the key. Existing DeepSeek settings remain unchanged.

- [ ] **Step 8: Implement encrypted selected-provider configuration**

Use secret name `search.<selected-provider-id>.apiKey` inside Main. Utility obtains it only through the typed host secret request for a permitted registered Provider; it is never embedded in ToolCallRequest, event, audit or Renderer response.

- [ ] **Step 9: Verify Task 9**

Run:

```bash
npm test -- packages/retrieval/src/search-tool.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/renderer/App-settings.test.tsx
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: selected adapter and settings pass; raw benchmark output remains ignored; no secret appears in tracked files or test output.

- [ ] **Step 10: Commit**

```bash
git add benchmarks/humanoid-robot/provider-selection-v1.md packages/retrieval/src apps/desktop/src packages/contracts/src package.json package-lock.json
git commit -m "feat: select and configure search provider"
```

---

### Task 10: Developer Retrieval Probe, Trace UI and Packaged Vertical Slice

**Files:**
- Create: `packages/application/src/retrieval-probe-service.ts`
- Create: `packages/application/src/retrieval-probe-service.test.ts`
- Modify: `packages/application/src/ports.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Create: `apps/desktop/src/main/tool-event-router.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/ipc.test.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `apps/desktop/src/preload/preload-api.test.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Create: `apps/desktop/src/renderer/features/developer/ToolTraceView.tsx`
- Create: `apps/desktop/src/renderer/features/developer/ToolTraceView.test.tsx`
- Create: `apps/desktop/src/renderer/features/developer/tool-trace.css`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/Sidebar.tsx`
- Create: `tests/e2e/tool-platform.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `docs/development.md`

**Interfaces:**
- Produces `RetrievalProbeService.start(query, senderScope)` and `cancel(traceId)` using a fixed developer ToolSet and budget.
- Adds narrow `DesktopApi.developer.startRetrievalProbe(query)`, `cancelRetrievalProbe(traceId)`, `subscribeToolEvents(listener)` and `listRecentToolExecutions()` only when Main developer mode is enabled.
- UI never accepts a Tool name, version, URL, budget, project scope or secret.

- [ ] **Step 1: Write failing deterministic service tests**

Use Fake Provider, Transport and parsers. Assert one search, deduplicated first three URLs, at most three link checks/fetches/parses, correct HTML/PDF branch, skip reasons, 4,000-character per-page preview, 10,000-character total preview, cleanup and final trace result.

```ts
const trace = await service.start("人形机器人", senderScope);
expect(fakeRunner.calls.map((call) => call.tool.name)).toEqual([
  "search_web", "check_link_accessibility", "fetch_url", "parse_html",
]);
expect(trace.preview.length).toBeLessThanOrEqual(10_000);
```

- [ ] **Step 2: Run service tests and record RED**

Run: `npm test -- packages/application/src/retrieval-probe-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement fixed orchestration without Capability state**

This service is not a Capability and writes no ResearchCycle, Company, Claim or Evidence. It constructs exact calls in code, uses one trace Budget Scope, continues after individual URL failure, releases all resources in `finally` and writes only audit summaries.

- [ ] **Step 4: Write failing IPC/preload/event-router tests**

Assert developer APIs are not registered unless `DEEPFIELD_DEVELOPER_MODE=1`; exact argument counts; blank/oversized query rejection; per-webContents event routing; destroyed sender cleanup; cancellation ownership; unknown/late trace event drop; no generic Tool invocation.

- [ ] **Step 5: Implement narrow developer IPC**

Main reads developer mode at startup and passes an explicit boolean to handler registration. Preload only exposes the fixed developer methods when Main registers them; production UI does not render the navigation item. Do not expose environment variables to Renderer.

- [ ] **Step 6: Write failing Trace UI tests**

Test queued/running/retry/completed/failed/cancelled rows, selected/skipped URLs, attempts, duration, bytes, stable error code, cancel button, no raw body/key/error and accessibility. Test that unmount removes subscriptions.

- [ ] **Step 7: Implement the developer view**

Follow P1 warm editorial styles. Display bounded preview and trace, not full page. Show a clear “开发调试功能” label so it cannot be mistaken for Capability A.

- [ ] **Step 8: Add real Electron fake E2E**

Launch with `DEEPFIELD_DEVELOPER_MODE=1`, fake selected Provider and fake transport. Through UI run “人形机器人”, see all fixed Tool stages and previews, cancel a second delayed probe, restart with the same userData and see final audit summaries but no page body. Assert normal Chat still does not call a Tool.

- [ ] **Step 9: Add an opt-in real retrieval smoke**

Only with the selected Provider key and `DEEPFIELD_LIVE_RETRIEVAL=1`, run one bounded query and one public-page parse. Record trace metrics and inspect that no full body enters SQLite. This smoke is never part of default `npm test` or fake E2E.

- [ ] **Step 10: Run the full Plan 2 verification gate**

Run:

```bash
npm ls --depth=0
npm run check
npm run build
npm run test:e2e
npm run test:e2e
npm run dist:dir
file release/mac-arm64/Deepfield.app/Contents/MacOS/Deepfield
git diff --check
```

Then launch the packaged arm64 app with fake developer dependencies and isolated userData. Verify the probe, Trace UI, cancel path and restart audit. Scan SQLite, logs, IPC fixtures and tracked files for full fixture markers, API keys, authorization headers and raw exceptions.

Expected: all default tests pass without network; Electron E2E passes twice; packaged app runs; no full body/secret leak; P1 Chat/project/settings journeys remain green.

- [ ] **Step 11: Update developer documentation**

Document developer mode, fake retrieval, live opt-in, Provider key storage, benchmark commands, ignored outputs, network limits, audit retention, no-page-body invariant and troubleshooting. Explicitly state that Capability A is still not implemented.

- [ ] **Step 12: Commit**

```bash
git add packages/application/src packages/contracts/src apps/desktop/src tests/e2e playwright.config.ts docs/development.md
git commit -m "test: verify reusable retrieval tool platform"
```

---

## Final Review Gate

Before writing Plan 3, independently verify:

- Pi AgentTool adapters and deterministic backend calls use the same Definition, Registry, Policy, Budget and Runner;
- ordinary Chat still receives no ToolSet;
- denied or over-budget calls never start an executor;
- timeout, retry, cancel, worker exit and late-event races produce one terminal state;
- Main acknowledges required audit writes before Pi or direct callers receive success;
- Renderer has no generic Tool, URL, network, filesystem, database or secret API;
- URL policy covers actual connection addresses and every redirect;
- Resource handles cannot cross trace/project/ToolSet and are released at terminal/TTL/dispose;
- SQLite, logs, events, Agent transcript and benchmark selection record contain no full HTML/PDF or keys;
- HTML and PDF fixtures retain the location information needed by later evidence work;
- at least two real Providers were measured and the selected one passed hard gates;
- developer probe Trace is understandable and bounded;
- P1 regression, two Electron E2E runs and arm64 packaged smoke pass;
- ignored `docs/架构图/` remains unmodified and untracked.

Only after this gate passes may Plan 3 define Capability commands, durable Jobs, confirmation requests and Agent Supervisor roles from these validated Tool interfaces.
