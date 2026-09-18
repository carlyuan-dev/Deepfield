# Generic Pi Agent Loop Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User explicitly prioritizes minimal necessary testing and controller review, not broad repeated review cycles.

**Goal:** Restore generic Chat to Pi's native tool loop; remove network-specific global stopping while preserving Capability report finalization.

**Architecture:** Pi Agent 0.84.3 owns the loop, continuation, tool execution and message context. Deepfield owns authorized tool filtering, existing network budgets/admission/audits, current runtime facts and a last-turn cap. Capability-specific structured finalization stays explicitly isolated from generic Chat.

**Tech Stack:** TypeScript, React, existing Pi Agent/Pi AI, Vitest.

**Spec:** User-approved design in current conversation: natural no-tool response finishes directly; tools continue until maxAgentTurns - 1, then one zero-tool answer; exhausted network tools do not terminate other tools. Per-conversation network persistence already shipped and must remain intact.

## Global Constraints

- Work only in existing isolated `.worktrees/chat-markdown-rendering`; preserve dirty user work. No commits/pushes/dependency upgrades/live API calls.
- No new actual file/code/CRUD tools or broader Base extraction this turn; demonstrate extension using an in-memory test tool.
- Native Pi loop, no hand-written secondary loop and no generic natural-stop followUp.
- Tool errors/results (including final permitted batch) reach next model context; preserve tool-call/result pairing and existing audits/deduplication.
- Chat online/offline final answers stream live. Do not replace streaming with full-answer-at-end fallback as normal behavior.
- Search and fetch limits independently remove those tools; unrelated authorized tools remain. Offline only removes network tools, not all tools.
- Global model cap counts all assistant requests this invocation, not only network batches. No extra call after a natural answer. If maxAgentTurns is one, first request is zero-tool.
- Preserve Capability raw report/identity workflows and their explicit finalizationSystemPrompt; no change to second-round structuring.
- Final prompts distinguish user network permission, current network tool availability and actual execution facts; never equate an exhausted/closed tool with user-disabled networking.
- Necessary focused tests only, always exclude `**/.superpowers/**` to avoid copied baseline suites. Controller runs build/package, not repeated full tests.

### Task 1: Generic loop and live response integration

**Files:** `apps/desktop/src/worker/pi-chat-agent.ts`, `agent-run-control.ts`, `runtime-budget-context.ts`, their targeted tests; if needed a small extracted policy helper in the same worker directory. Streaming lifecycle changes may touch the AgentWorkerEvent contract and `apps/desktop/src/renderer/state/chat.ts` plus exact covering tests. Capability caller files only when explicit mode wiring is necessary.

**Interfaces:** Existing createPiChatAgent/AgentOptions hooks. Preserve exports/callers. Existing `filterRuntimeTools` already keeps non-network tools. Optional run policy switches must default/persist legacy Capability behavior only explicitly; avoid hiding network assumptions in shared generic stop logic.

- [ ] Inspect installed Pi native order: turn_end → prepareNextTurnWithContext → shouldStopAfterTurn. Tool-bearing turns continue automatically; no-tool stops naturally unless followUp queued.
- [ ] Add/update necessary focused real-Pi faux-stream tests: online natural answer uses one request, streams before completion; search then natural answer uses exactly two; search exhausted but custom non-network tool remains and executes; offline non-network tool works; max-1 batch result/error reaches final zero-tool request; max1 begins zero-tool; Capability retains structured finalization.
- [ ] Decouple network tool depletion/auth failure/empty batches from global Chat synthesis. Keep per-category limits and existing failure feedback/reuse. Generic total turns counted independently from network bookkeeping.
- [ ] Chat normal completion uses the actual natural answer/context, no extra synthesis request or evidence-only context reconstruction. At global cap use zero tools plus toolChoice none in streamFn and preserve full paired execution history.
- [ ] Preserve live output with per-assistant-turn lifecycle. If necessary add a narrow `text_reset` event (requestId, type only) to clear transient text before subsequent answer, including first tool-call appearance. Keep tool records/activity intact. Reset only Chat draft text; Capability stream remains final report only. Do not expose thinking or concatenate intermediate plans into the final answer.
- [ ] Include network permission/availability/actual execution facts in runtime context, including forced final context. Retain existing latest-info prompt guidance but do not hardcode search intent keyword gating or mandatory searching on all online messages.
- [ ] Run affected worker/control/render-state tests with explicit scratch exclusion and typecheck. Update stale tests that assert old extra-synthesis behavior; do not weaken unrelated validation.
- [ ] Report exact changed files, tests and unresolved issues. Controller reviews diff and necessary integration boundaries once.

### Task 2: Delivery

- [ ] Controller validates runtime design against user rules and Capability caller boundaries; targeted fixes only if actual gaps found.
- [ ] Build and package local arm64 release using bundled Electron distribution, preserve prior installed app recoverably, do not launch raw Electron binary.
- [ ] Hand off: repeat user's five-turn Chat scenario, test network switch persistence; explain natural answers now cost no automatic extra call. No claim that architecture guarantees model always chooses search.

## Pi tool reuse (user addition)

Pinned official source inspected at `v0.84.3`, matching installed core: https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/tools/index.ts . Existing factories return native `AgentTool`: `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, `createGrepTool`, `createFindTool`, `createLsTool`; grouped factories `createCodingTools` and `createReadOnlyTools` exist. Keep native AgentTool injection, not a Deepfield-only replacement interface.

The coding-agent package is not currently installed. Do not reimplement its tools during this loop refactor; later file/code feature should use official factories with authorized operations/context. Factory `cwd` is path context, not permission isolation. Read/write options expose operations adapters, allowing Deepfield authorization without copying tool implementation. Current web providers remain our existing tools. No implicit new filesystem/shell permissions this turn.
