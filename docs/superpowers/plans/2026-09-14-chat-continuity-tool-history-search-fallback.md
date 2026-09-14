# Chat Continuity, Tool History, and Search Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve live Chat activity across conversation switches, persist tool history, add safe conversation deletion, and make absolute date ranges work on every Search Provider.

**Architecture:** Keep one Renderer chat controller alive and key its state by conversation/request. Link messages to the existing tool audit trace through requestId, and normalize unsupported native date filters into absolute-date query constraints at the canonical search tool boundary.

**Tech Stack:** TypeScript, React, Electron IPC, node:sqlite, TypeBox, Vitest

**Spec:** `docs/superpowers/specs/2026-09-14-chat-continuity-tool-history-search-fallback-design.md`

## Global Constraints

- Use strict red-green-refactor for each behavior.
- Preserve absolute dates; never silently drop or pretend to apply a date range.
- Never expose API keys, raw headers, or unbounded tool payloads to Renderer history.
- Do not modify `docs/material/` or `docs/single-company-key-research-discussion.md`.
- Prefer focused regression tests and the existing full verification commands; avoid unrelated refactors.

---

### Task 1: Provider-aware absolute-date search fallback

**Files:**
- Modify: `packages/retrieval/src/search-tool.ts`
- Test: `packages/retrieval/src/search-tool.test.ts`

**Interfaces:**
- Consumes: `SearchProvider.capabilities.timeRange`, `SearchWebInput`
- Produces: `web_search` accepting optional `maxResults` and provider-valid absolute-date requests

- [ ] Add failing tests proving unsupported providers receive no `timeRange` but their query contains both absolute dates, supported providers retain native `timeRange`, and omitted `maxResults` becomes 5.
- [ ] Run the focused test and verify failures are caused by current rejection/required field behavior.
- [ ] Implement minimal request normalization in `createSearchWebDefinition`; keep invalid dates and reversed ranges rejected.
- [ ] Run the focused retrieval tests green and commit the change.

### Task 2: Durable request-to-conversation and tool-history linkage

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/mappers.ts`
- Modify: `packages/persistence/src/message-repository.ts`
- Modify: `packages/persistence/src/tool-execution-repository.ts`
- Modify: `packages/application/src/chat-service.ts`
- Test: `packages/persistence/src/message-repository.test.ts`
- Test: `packages/application/src/chat-service-persistence.test.ts`

**Interfaces:**
- Produces: optional `ChatMessage.requestId`; bounded safe tool history keyed by traceId/requestId

- [ ] Add failing migration/repository tests for requestId round-trip and lookup of tool executions for a conversation.
- [ ] Add failing ChatService tests proving user and assistant messages share the requestId and history returns associated safe tool records.
- [ ] Add the additive migration and repository/service implementations; do not duplicate tool payloads in messages.
- [ ] Run focused persistence/application tests green and commit.

### Task 3: Live conversation continuity in Renderer

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/ChatView.tsx`
- Modify: `apps/desktop/src/renderer/state/use-chat.ts`
- Modify: `apps/desktop/src/renderer/state/chat.ts`
- Test: `apps/desktop/src/renderer/state/use-chat.test.tsx`
- Test: `apps/desktop/src/renderer/App.test.tsx`

**Interfaces:**
- Consumes: persisted message/tool history and global Agent events
- Produces: chat state keyed by conversationId/requestId that survives view switching

- [ ] Add failing Renderer tests that switch away during deltas/tool activity, switch back, and assert the partial text/activity remain and later events continue updating it.
- [ ] Remove keyed destruction and make one controller own per-conversation state without allowing a late completion to navigate the user.
- [ ] Hydrate terminal tool history when loading a historical conversation.
- [ ] Run focused Renderer tests green and commit.

### Task 4: Safe manual conversation deletion

**Files:**
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/conversation-repository.ts`
- Modify: `packages/application/src/conversation-service.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `apps/desktop/src/renderer/state/use-conversations.ts`
- Modify: `apps/desktop/src/renderer/components/Sidebar.tsx`
- Test: corresponding persistence, application, IPC, preload, hook, and Sidebar test files

**Interfaces:**
- Produces: `conversations.delete(id)` and Renderer deletion guard based on active request state

- [ ] Add failing tests for confirmed idle deletion, cascade cleanup of messages/tool audits, active-run rejection, and active-view fallback to a draft/recent conversation.
- [ ] Implement repository/service/IPC deletion and a hover action with confirmation.
- [ ] Disable or reject deletion while that conversation is generating and show the approved Chinese message.
- [ ] Run focused tests green and commit.

### Task 5: End-to-end verification and hand-test build

**Files:**
- Modify only if verification exposes a regression.

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: restarted development build ready for manual testing

- [ ] Run focused tests for search, persistence, ChatService, IPC, preload, chat state, App, and Sidebar.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Inspect the live audit database after one Serper absolute-date request to confirm `web_search` reaches the provider instead of failing locally with `invalid_input`.
- [ ] Restart the development version and report concise manual-test steps.
