# Chat session continuity implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User overrides heavyweight process: one coupled implementer, controller review, necessary tests only, no commits or broad branch review.

**Goal:** Preserve tool evidence across Chat turns and reloads, independently of current network permission, with useful persistent tool expansion.

**Architecture:** Reuse Pi native messages and public session/context APIs first. Keep Deepfield conversation ownership and deletion in SQLite; persist model-visible messages, not provider transport payloads. Current tool authorization is independent of historical transcript. Capability stays isolated.

**Tech Stack:** TypeScript, Electron, SQLite, React, Pi 0.84.3.

**Spec:** User-approved design in this conversation: preserve per-turn network permission, actual tool calls/results, offline reuse of earlier evidence, stable expandable tool history, final-answer-only prose. Existing diagnostic evidence: ContextBuilder currently maps only user/assistant text; SqliteToolAudit intentionally drops all input/output; these are separate missing projections, not a Loop failure.

## Global constraints

- Work only in /Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering; preserve inherited dirty changes.
- Prefer public Pi reuse, no private deep imports or hand-copied session engine. Pinned coding-agent 0.84.3 may be added if needed; do not upgrade existing Pi dependencies or enable coding tools/extensions.
- No live paid calls, secrets reads, existing history rewrites, commits, pushes, or destructive cleanup. New records must survive restart; old records may show the existing sparse audit without fabricated evidence.
- Current network off means no NEW web_search/read_webpage; historical evidence remains usable. Do not infer actual search success merely from permission being enabled.
- Persist only normalized model-visible tool inputs/results, original source URLs, and safe event metadata; never provider credentials, HTTP headers, raw responses or transport config. Keep retrieved content in tool-result role, not system authority.
- Do not build long-term memory, vector search, branch UI or LLM-based summarization. Bounded recent history must preserve complete tool-call/result groups. Never truncate raw JSON halfway or split a pair.
- User prioritizes speed: only necessary focused functional tests, typecheck and build/package verification. Exclude **/.superpowers/** from test runs.

## Task 1: Persistent Pi transcript and stable tool history (single coupled implementation)

**Files:** contracts chat/worker schemas and exports; persistence migration/repository/types; application ChatService/ContextBuilder; worker pi-chat-agent and pi-message-mapper plus small focused session adapter; renderer state/chat and ToolActivity + styles; necessary package manifest/lock if using Pi public SessionManager. Keep new responsibilities in small files rather than enlarge pi-chat-agent further.

**Interfaces:** Introduce a validated internal transcript event or completed payload containing native Pi user/assistant/toolResult messages for the current request only; persist against conversationId/requestId with that request's network permission. Do not expose full internal transcript to renderer. Expose a safe tool-history projection with stable call identity, query/URL summary, status/error/duration and title+URL source list. Use the same projection for live and restored views.

- [ ] Read official Pi session audit provided by controller and installed APIs. Choose smallest direct public API reuse; explain any unavoidable local persistence adapter. SQLite remains authoritative; avoid parallel unmanaged JSONL files that survive conversation deletion.
- [ ] Write focused failing coverage for online search -> next OFFLINE request still receives paired result with exact source URL and permission provenance, including after persistence reload. Capture requests from real Pi with fake stream/provider, no live API.
- [ ] Persist messages observed at Pi message_end incrementally, or equivalent request-scoped transcript checkpoints that survive a completed batch and cancellation. Do not persist tool execution details/credentials. Source content is already normalized and bounded by existing Search/read_webpage formatters. Preserve role, toolCallId, toolName, isError, timestamps and original model identity needed by Pi conversion.
- [ ] Connect ChatService and ContextBuilder so native transcript is restored without duplicating user/final assistant messages; fallback to existing plain text for old messages. Include past-turn network permission and actual usage as factual metadata, but current permission always comes from request.toolAccess. Pair-safe bounds and cancellation/error behavior must not create orphaned results or reuse stale terminal answers. Delete transcript with conversation.
- [ ] Ensure internal transcript events are consumed/persisted by application, not sent to renderer; extend exhaustive helpers/worker validation as necessary. No Capability transcript emission or changes to its finalization.
- [ ] Persist UI projection from safe tool events/native messages and merge with existing audits by toolCallId/stable request identity (not generic activity-1 collisions). On navigation/restart retain query, results and errors; running drafts continue rendering. Audit remains minimal and independent; do not change it to dump raw payloads.
- [ ] ToolActivity defaults compact, expands calls in execution order: query or visited URL, success/failure/skipped/reused, duration if known, source title+HTTP(S) link. Reuse existing hover/copy link component; no unsafe javascript links. Persist genuine result counts or omit unavailable ones, never use audit's hardcoded zero as actual results.
- [ ] Prompt changes: permission describes only new calls; earlier evidence can be quoted offline but cannot be claimed as newly checked. Final answers begin with results, not '信息充分/我来整理/先说明我会…'; retain concrete dates and uncertainty inline. No regex answer stripping or extra LLM cleanup call. Require useful source links with web-grounded claims without forcing search on every online question.
- [ ] Run targeted persistence/context/worker/UI tests and typecheck; update directly broken contract fixtures only. Tests must cover reload parity, offline tools excluded while historical URLs remain, no credential/header persistence, old-history fallback and deletion, Capability unchanged. Report precise changed files, decisions, commands/results and remaining limitations to this plan's scratch report. No package/commit by implementer.

Minimum functional assertions:
```ts
expect(nextOfflineRequest.tools.some(t => t.name === 'web_search')).toBe(false);
expect(nextOfflineRequest.messages.some(m => m.role === 'toolResult' && JSON.stringify(m).includes(sourceUrl))).toBe(true);
expect(restoredTool.queryOrSummary).toBe(liveTool.queryOrSummary);
expect(restoredTool.sources.map(s => s.url)).toContain(sourceUrl);
```
Use actual project types/property names when implementing; assertions express required behavior, not mandatory public field names.

## Task 2: Controller review and delivery

- [ ] Inspect task-only changes against pre-task snapshot, not entire inherited dirty diff; verify public Pi reuse and no permission/history coupling.
- [ ] Request focused fixes from original implementer for concrete findings only. No exhaustive repetitive reviews.
- [ ] Build and package arm64 using installed Electron distribution, no raw Electron executable launch. Check app idle/quit normally before recoverable replacement of /Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app.
- [ ] Verify source/installed asar hashes and normal app startup. Hand off: fresh online query -> inspect sources -> switch conversation/back -> disable network and request prior source links -> restart and repeat. Existing missing source evidence cannot be reconstructed retroactively.
