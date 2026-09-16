# Navigation and common errors implementation plan

> For agentic workers: use subagent-driven-development. Parent owns review; implementers do not spawn agents.

**Goal:** Keep research navigation accessible and establish lightweight common error and research retry rules.

**Architecture:** Common contracts own stable codes, categories and allowlisted serializable error data; internal causes never cross IPC. Domain policy owns retry mode, while UI owns context-specific Chinese wording. No HTTP exception hierarchy or new automatic retry engine.

**Tech Stack:** TypeScript, Electron IPC, React, TypeBox, Vitest.

**Spec:** User-approved design in this conversation on 2026-09-16: two fixed navigation rows; common error identity/security with per-module presentation; shared research retry policy; incremental adoption in Settings diagnostics and research start/retry, preserving working raw/structure flow.

## Global constraints

- Work only in existing .worktrees/chat-markdown-rendering; preserve prior uncommitted changes.
- No changes to docs/material or single-company-key-research-discussion.md; no credentials/database inspection, live provider requests, commits, merge or push.
- Keep existing public DesktopApi call shapes where possible; transport envelopes can be internal to IPC/preload.
- Configured credentials must not be lost when draft API Key is blank.
- None/completed retries run raw in place; none/structure_failed also runs raw; unchanged unknown/succeeded structure_failed runs structure only; changed fields run raw; normal completed cannot retry.
- No arbitrary exception message/body/headers in renderer or model-facing errors. Unknown errors map to safe internal fallback.
- User prioritizes focused testing and handoff. Run focused regressions per task and one integrated check; avoid redundant full runs.

## Task 1: Fixed research navigation

Files: renderer App.tsx, app.css, capability.css, IndustryResearchCapability.tsx and focused existing UI tests.

- [ ] Inspect current scroll ancestor and X ownership; unify fixed pane header and contextual back row without duplicate controls.
- [ ] Keep breadcrumb, X and contextual return available while body scrolls, including narrow panes and long labels. Modals stay above header; hidden Settings workspace remains hidden.
- [ ] Test back/close navigation and perform browser/layout verification if practical; do not simulate layout confidence solely with jsdom.
- [ ] Report changed files, commands/results, limitations to parent; no unrelated redesign.

## Task 2: Common errors and shared retry policy

Files: contracts new errors.ts / research-retry-policy.ts and exports; main profile-store/configuration-service/ipc; preload/preload-api; application company-research-service; renderer settings diagnostics/readiness and research hook/modal; related tests. Do not modify Task 1 layout files.

- [ ] Add minimal stable AppError model: code, category and typed allowlisted context (service llm/search). Keep cause internal. A small code registry and normalization helpers provide CONFIG.CREDENTIAL_MISSING, CONFIG.PROFILE_MISSING, CONFIG.INVALID, EXTERNAL.AUTHENTICATION_FAILED, EXTERNAL.TIMEOUT, EXTERNAL.RATE_LIMITED, EXTERNAL.UNAVAILABLE, INPUT.INVALID, BUSINESS.CONFLICT, RESOURCE.NOT_FOUND, STORAGE.FAILED, INTERNAL.UNKNOWN as needed by actual paths.
- [ ] Validate and serialize only public error data; unknown/malformed data maps to INTERNAL.UNKNOWN. Map existing typed provider/gateway failures via adapters, not string matching. Preserve existing tool-loop error protocol unless conversion is explicitly necessary.
- [ ] Carry structured errors over selected IPC request/result envelopes and unwrap in preload so DesktopApi callers keep current success shapes. Do not rely on Electron preserving custom Error properties. Preserve cancellation/stream behavior and validate untrusted payloads.
- [ ] Settings diagnostic failures and research start/retry errors use shared codes. Presentation maps code+service+UI context to safe actionable Chinese text; unknown gets generic fallback. Renderer preflight remains UX only; backend authoritative check retains detail.
- [ ] Extract pure research retry policy returning unavailable/raw/structure using saved run + normalized latest input. UI eligibility/preflight and service share it; repository retains atomic state transition/ownership guards and may reuse compatible eligibility predicate. Old public retryStructuring cannot bypass policy or concurrency guards.
- [ ] Focused regressions: missing LLM/Search versus rejected credentials; timeout/rate limits/unknown fallback; IPC roundtrip and hostile secret-bearing error never surfaced; retry mode table and edited fields; successful existing diagnostics and research flow unchanged.
- [ ] Document public error extension rules, incremental adoption boundary, and what was deliberately not migrated. Report tests and concerns.

## Review and delivery

- [ ] Parent reviews task diffs and safety boundaries; independent final review checks spec and code quality.
- [ ] Run typecheck, focused tests plus integrated suite once; fix relevant failures and rerun only affected tests.
- [ ] Build unsigned arm64 using installed Electron runtime; replace fixed release/mac-arm64/Deepfield.app with recoverable exact-path backup and verify matching app.asar hashes.
- [ ] Report hand tests and remaining limitations; no claim of real-provider validation.

## Progress

- Initial inspection: linked worktree codex/chat-markdown-rendering; prior turn edits are intentional baseline.
- Task boundaries: Task 1 layout files and Task 2 errors/policy files are independent. User explicitly requests delegation and parallel work; use two independent implementers, parent handles integration/review.
- Implementers: /root/fixed_research_navigation and /root/common_errors_retry; in progress.
- Cross-boundary review: Electron contextBridge drops custom Error fields, so public failures must remain validated plain DTOs through renderer boundary. Never rely on renderer instanceof of preload errors.
- Opaque Pi model errors cannot safely distinguish credentials from network by parsing raw text; use an honest external-unavailable fallback while typed Search provider failures retain categories.
- Settings IPC failures must end diagnostic loading and use the existing per-profile request identity guard.
- Task 1 implemented: 13 renderer tests and isolated Electron geometry test passed. Parent reviewed layout; Task 2 implementer will cross-review navigation.
- Additional reviewer dispatch unavailable due agent thread limit. Existing two implementers cross-review each other's code; parent separately checks integration.
- Task 2 review findings pending: precise missing-profile versus missing-credential identity in renderer readiness; strip arbitrary legacy diagnostic message at preload boundary even if current UI ignores it.
- Both findings fixed and cross-reviewed. Task 1 and Task 2 cross-review found no remaining blocking issue. Public diagnostic DTO roundtrip verified in isolated Electron before GUI testing was stopped.
- Integrated check: typecheck passed; full suite 136 files/1443 tests passed, 2 skipped, with six stale envelope expectations in two IPC test files. Those assertions updated without weakening input/sender guards; parent reran four affected boundary files, 53 tests passed.
- User reported desktop crash dialogs. Read-only macOS DiagnosticReports Electron-2026-09-16-105720.ips and Electron-2026-09-16-110513.ips show matching SIGABRT during _RegisterApplication/NSApplication initialization, correlating to two restricted Seatbelt E2E launches. No further GUI launches permitted this turn.
- Added prelaunch guard: reject macOS Seatbelt unconditionally; require explicit GUI opt-in otherwise. Pure unit coverage only, no launch-based revalidation. Agents instructed to build/package only, never open application or kill user processes.
