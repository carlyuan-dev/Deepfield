# Chat Web Loop Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an enabled Chat web-search request reliably search, read pages, expose only tool activity while working, and persist one Chinese final answer or a clear failure.

**Architecture:** Keep Pi as the generic tool-calling loop, but add a Deepfield-owned output and termination contract around it. Tool-using assistant turns remain internal; the last tool-free assistant turn is the only final answer. Reserve the final turn for synthesis, pass safe typed failures back to the model, and expose one composed webpage-reading tool backed by the existing safe fetch/parse pipeline.

**Tech Stack:** TypeScript 7, Pi Agent Core 0.84.3, TypeBox, Vitest, Electron worker/application boundaries.

**Spec:** `docs/superpowers/specs/2026-09-11-deepfield-modular-llm-search-agent-loop-design.md`

## Global Constraints

- Chat web access remains controlled exclusively by the user web-search option and the immutable request ToolSet.
- No native provider web-search protocol or automatic Search Provider fallback is introduced.
- Provider secrets, raw exception messages, response headers, and full page bodies never enter UI events or persistence.
- This plan changes the Chat foundation only; Company Research Harness changes are deferred until Chat manual acceptance.
- Add only focused regression tests for the observed failures and core contracts.

---

### Task 1: Final-answer and reserved-synthesis contract

**Files:**
- Modify: `apps/desktop/src/worker/pi-chat-agent.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent.test.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent-test-helpers.ts`

**Interfaces:**
- Consumes: Pi `message_end`, `tool_execution_*`, and `agent_end` events.
- Produces: existing `AgentWorkerEvent` events; `text_delta` and `completed.text` contain only the final tool-free assistant turn.

- [x] Write a failing multi-turn test whose first assistant turns contain English planning text and tool calls, while the final tool-free turn contains a Chinese answer; assert that only the Chinese answer is emitted and completed.
- [x] Run `npx vitest run apps/desktop/src/worker/pi-chat-agent.test.ts` and verify the planning text is currently leaked.
- [x] Buffer assistant text by turn, classify completed assistant messages by whether they contain tool calls, and select only the last tool-free answer candidate.
- [x] Add a failing termination test showing that the penultimate tool-using turn disables tools for the reserved final turn and that a run with no tool-free final answer fails instead of persisting process text.
- [x] Implement `prepareNextTurnWithContext`/`shouldStopAfterTurn` so at most `maxAgentTurns - 1` turns may use tools and the last turn receives an empty tool set for synthesis.
- [x] Strengthen the online system guidance: answer in the user's language, keep planning out of the answer, use tools while available, and always synthesize after tool results.
- [x] Re-run the focused test file and verify it passes.

### Task 2: Typed tool failures and readable webpage tool

**Files:**
- Modify: `apps/desktop/src/worker/pi-tool-adapter.ts`
- Modify: `apps/desktop/src/worker/pi-tool-adapter.test.ts`
- Modify: `apps/desktop/src/worker/tool-runtime.ts`
- Modify: `apps/desktop/src/worker/tool-runtime.test.ts`
- Create: `packages/retrieval/src/read-webpage-tool.ts`
- Modify: `packages/retrieval/src/index.ts`
- Create: `packages/retrieval/src/read-webpage-tool.test.ts`
- Modify: `apps/desktop/src/worker/tool-activity.ts`
- Modify: `apps/desktop/src/renderer/components/ToolActivity.tsx`
- Modify: `packages/retrieval/src/search-tool.ts`
- Modify: `packages/retrieval/src/search-tool.test.ts`

**Interfaces:**
- Produces: safe error text `tool_failed {"code":...,"retryable":...,"attempts":...}` for Pi tool results.
- Produces: `read_webpage` v1 input `{ url }` and compact output `{ title, url, text, truncated, characterCount }`.

- [x] Write a failing adapter test proving `timeout` and `authentication_failed` remain distinguishable without leaking executor/provider details.
- [x] Implement bounded deterministic failure formatting from `ToolExecutionResult.failure`.
- [x] Write focused retrieval tests for a composed HTML read, timeout mapping, output bounds, and resource cleanup; rely on the existing lower-level suite for unsupported content and abort cleanup.
- [x] Implement `read_webpage` by composing the existing safe transport, scoped resource storage, and HTML extraction behavior without exposing raw transport metadata.
- [x] Write a failing runtime test asserting a web-enabled main Agent receives `web_search` and `read_webpage`, while an offline Agent receives neither.
- [x] Register and grant `read_webpage`; remove `fetch_url` from the model-facing Chat grant while retaining lower-level definitions internally.
- [x] Add safe activity labels/summaries for `web_search` and `read_webpage`.
- [x] Add a bounded, always-valid model formatter for large normalized search results so generic UTF-8 truncation cannot corrupt JSON.
- [x] Run the focused test files and verify they pass.

### Task 3: Minimum answer-quality guard

**Files:**
- Modify: `apps/desktop/src/worker/pi-chat-agent.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent.test.ts`

**Interfaces:**
- Consumes: final tool-free assistant candidate and the current user prompt.
- Produces: completion only for a nonblank answer in the user's language that does not contain known DSML/tool protocol markers.

- [x] Write failing tests for an empty final turn, a DSML-only final turn, and an English-only answer to a Chinese prompt.
- [x] Implement a deterministic guard that rejects empty/protocol-only output and clear response-language mismatches with the existing sanitized Agent failure path.
- [x] Run the focused tests and verify they pass.

### Task 4: Verification and handoff

**Files:**
- Modify only if verification reveals a regression in files already in this plan.

**Interfaces:**
- Produces: a development build ready for the user's Chat web-search manual test.

- [x] Run focused worker/retrieval/renderer tests for the changed files.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Review `git diff --check` and confirm protected user files remain unmodified and untracked.
- [ ] Restart the existing development version and provide a concise manual test covering successful search, page timeout degradation, Chinese final answer, and persisted tool history.
