# Company profile Agent — implementation result

## Delivered

- Independent `company-profile.enrich` / `company-profile.event` transport and typed identity, fields, field-source references and provenance. No chat conversation or research-report record is created. Internally the stateless capability uses the same adapter shape as company research to invoke `createPiChatAgent` with capability actor and empty history.
- Active LLM and Search snapshots resolve before a pending company is claimed. Existing fields and topic names are data in the prompt, not instructions or evidence.
- Existing registry, Pi loop, batch control, hard budgets and same-run tool-disabled closure: maximum 3 searches, 2 webpage reads, 7 total Agent turns. No provider-native search, second model completion pipeline, or whole-run automatic retry. `ConfiguredLlmService` retains offline recognition and title generation only.
- The successful tool adapter result has a process-local WeakMap association with its original validated output. The profile wrapper builds its ledger from this association, not model text, activity events or asserted success. Raw output is not added to Pi details/history, renderer events or diagnostics. Only referenced, bounded provenance is stored.
- Completion requires a nonempty successful search snippet, matched nonblank identity, at least one valid field and references found in the actual run ledger for identity and every field. Unknown/null/empty-array fields and fabricated references are rejected. Search snippets and opened nonempty webpages are different source kinds. Ambiguous/unresolved identities save no new fields and remain failed with a persisted “needs confirmation” presentation.
- Serial queue pauses once on typed public configuration errors before marking enriching. A persisted pending issue supports later page reads; a separate in-memory queue issue survives deletion of the original blocked company. Restart rechecks configuration. Successful Settings save/activate/delete IPC operations clear the issue and resume; reads/diagnostics do not. Foreground company research prevents claiming the next company.
- Migration 15 stores provenance/issues outside the editable fields. One status-guarded SQL statement merges only absent fields and commits their evidence atomically. Manual editing sets ready and clears old provenance; both preflight and in-flight stale completions lose to edits. New pending/enriching attempts also clear previous attempt provenance, so a later network failure cannot retain an old ambiguous-identity explanation.
- Minimal UI adds configuration recovery, identity-confirmation notice and collapsed source links labelled “搜索摘要” / “已读取网页”. Existing manual retry and edit actions are retained.

## Files changed in this task

Contracts: `packages/contracts/src/{company-profile.ts,capability-items.ts,worker.ts,index.ts}`.

Application: `packages/application/src/{ports.ts,index.ts,company-profile-enrichment-service.ts,industry-research-service.ts,company-profile-enrichment-service.test.ts,company-profile-test-fixtures.ts}`.

Persistence: `packages/persistence/src/{migrations.ts,types.ts,mappers.ts,company-repository.ts,capability-persistence.test.ts}`.

Main: `apps/desktop/src/main/{company-profile-completer.ts,company-profile-completer.test.ts,agent-worker-client.ts,agent-worker-protocol.ts,application-runtime.ts,application-runtime.test.ts,configured-llm-service.ts,configured-llm-service.test.ts,index.ts,ipc.ts,ipc.test.ts,ipc-test-helpers.ts}`.

Worker: `apps/desktop/src/worker/{company-profile-agent.ts,company-profile-agent.test.ts,company-profile-run.test.ts,pi-tool-adapter.ts,message-loop.ts,message-loop-types.ts,assembly.ts}`.

Renderer: `apps/desktop/src/renderer/features/industry-research/{IndustryResearchCapability.tsx,company-profile-recovery.test.tsx}`.

Other dirty changes predate this task and are preserved.

## Verification

`npm run typecheck` — passed.

`npx vitest run apps/desktop/src/main/company-profile-completer.test.ts apps/desktop/src/main/application-runtime.test.ts apps/desktop/src/main/configured-llm-service.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/agent-worker-client.test.ts apps/desktop/src/worker/company-profile-agent.test.ts apps/desktop/src/worker/company-profile-run.test.ts apps/desktop/src/worker/pi-tool-adapter.test.ts apps/desktop/src/worker/message-loop.test.ts apps/desktop/src/worker/assembly.test.ts packages/application/src/company-profile-enrichment-service.test.ts packages/application/src/industry-research-service.test.ts packages/persistence/src/capability-persistence.test.ts apps/desktop/src/renderer/features/industry-research/company-profile-recovery.test.tsx --maxWorkers=4`

Initial result: 14 files passed, 159 tests passed, 1 existing skipped test. Final review regression command is the same plus `apps/desktop/src/renderer/App-shell.test.tsx`: 15 files passed, 174 tests passed, 1 existing skipped test. Covers actual installed Pi with fake model/provider/HTTP transport, hard quotas and closure, empty/failed/no search, invented citations, source-kind distinction, partial profiles, ambiguity, safe errors, serial/config pause/resume, deleted blocked target, manual edits, deletion/disposal during execution, final queue-probe storage failure, stale evidence on manual retry, main/worker correlation and renderer recovery.

`git diff --check` — passed. `npm run build` — passed (repeated after final identity-contract tightening). No Electron/Playwright/app launch, real API calls, process termination or commit performed.

## Approved directory package and reversible installation

After independent review PASS, packaged with the already installed Electron runtime; no application launch:

`CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac --arm64 --dir --config.mac.identity=null --config.electronDist=/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/node_modules/electron/dist --config.directories.output=/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/release/company-profile-package-20260916-A3Ckwn`

- Packaging passed, unsigned arm64 directory build; no download was needed (custom local Electron distribution).
- New source app: `/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/release/company-profile-package-20260916-A3Ckwn/mac-arm64/Deepfield.app`.
- Installed app: `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app`.
- Exact prior app was moved intact, not deleted, to `/Users/carl/Project/Deepfield/release/mac-arm64/company-profile-backup-20260916-Be0Qnl/Deepfield.app` before `ditto` copied the new app into place.
- Source and installed `Contents/Resources/app.asar` SHA-256 both: `75d6c27f7e062568f3e535aca1f414f0739d72ada3b6cadff9b9c76e367d72fd`; byte-for-byte `cmp` passed.
- Backup `app.asar` SHA-256: `27a191aa004c2b569362df132c0f00f608c17584c92a16fe0ff872a5cb521863`, matching the measured pre-replacement app.
- No git operation was performed during packaging/install. The user can manually relaunch the installed app when ready; no running process was touched.

## Boundaries and remaining limits

Programmatic checks establish that sources actually came from successful tools and that every proposed field cites one. They do **not** prove that a cited page semantically entails a fact, that the model disambiguated the correct legal entity, or that a public source is truthful/current. These remain model judgments constrained by the prompt and available for manual correction; do not describe this as fully verified truth.

Provenance retains referenced excerpts up to 4,000 characters per source, not a complete forensic snapshot. Manual edits deliberately clear automatic provenance rather than imply that it supports the changed values. Fake mode fails enrichment honestly without fabricating online evidence. Provider authentication errors surfaced only as opaque Agent/tool failures are not guessed by parsing messages; preflight missing/invalid configuration pauses the shared queue, execution failures remain manual per-company retry.

## Manual checks for the owner (not executed here)

1. With active LLM/Search configured, add one company and then import a batch. Observe serial pending → enriching → ready/failed, inspect collapsed source-kind labels, and confirm duplicate imports reuse the existing company.
2. Remove the active Search credential, add several companies, and confirm one shared configuration prompt with all companies pending. Open Search settings from that prompt, save valid configuration, and verify the queue resumes without reloading.
3. Edit a company while its in-flight job is still open in its detail view; the eventual completion must not replace the edit or attach stale provenance. Ambiguous company names should remain manually editable and require confirmation.
