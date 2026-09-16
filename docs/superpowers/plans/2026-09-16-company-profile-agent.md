# Company profile Agent implementation plan

## Approved scope
User approved the preceding company-profile design. Reuse generic Agent execution, not provider-native search. Preserve offline recognition and existing import deduplication. Implement a lightweight stateless profile capability, not chat memory or a second research workflow.

## Constraints
- Work in existing codex/chat-markdown-rendering worktree; preserve unrelated dirty changes. No commits/push without instruction.
- No Electron, GUI, Playwright, real provider calls, or process termination. Use focused mocked tests, typecheck, build and directory packaging only.
- Search maximum 3 calls, read_webpage maximum 2, advertised to model and enforced by existing harness.
- Use active LLM and active Search snapshots. Final JSON comes from the same Agent run with existing tool-disabled closure, not a second independent model pipeline.
- Save only after nonempty successful search, supported identity match, valid fields, and citations from actual tools. Distinguish search snippets from opened webpages. Unknown fields omitted; ambiguity requires confirmation; failed search must not produce ready offline profiles.
- Preserve current fields and user edits. New imports queue serially; existing companies reused. Research foreground blocks fetching the next profile. Public missing configuration pauses queue once and offers Settings recovery, no per-company failure cascade.
- No automatic whole-run retry twice. User retries same company; lower-level transient behavior reused.

## Task 1: Integrated profile capability
Implementation owner inspects worker/runtime interfaces then chooses the smallest typed profile task adapter using existing pi-chat-agent generic loop, tool registry, quotas and closure. Do not label profile runs as chat conversations or company research reports to circumvent contracts.

Files expected: contracts profile/worker schemas, worker profile prompt+runner and dispatch, main worker client/runtime wiring, application company-profile-enrichment-service/ports, repository profile persistence if evidence/status/edit protection need storage, renderer company status/recovery presentation.

- [ ] Add typed profile task/result with identity disposition, existing fields, source references and field-source mappings; persist provenance outside the existing editable field contract if necessary.
- [ ] Add evidence validation against actual successful tool outputs; invalid/empty/unsupported outputs cannot be ready. Retain useful fields only with evidence. Add source-kind distinction.
- [ ] Replace ConfiguredLlmService offline completion production wiring, retaining name recognition/title helpers.
- [ ] Integrate serial queue, configuration pause/resume after settings apply, failure/manual retry, and race-safe manual-edit protection.
- [ ] Minimal user-visible status: pending/enriching/ready/failed or needs confirmation, configuration recovery guidance. No new bulky UI.
- [ ] Test budgets/closure reuse, no/empty search failure, fabricated citations rejected, ambiguity, valid partial result, offline recognition unchanged, config pause/resume, no double whole-run retry, manual edits during run not overwritten.
- [ ] Run focused tests and typecheck, self-review and write result report with commands/results, changed files, remaining limits.

## Task 2: Independent review and handoff
- [ ] Primary reviews approved requirements and implementation; independent reviewer checks evidence gate, runtime integration, queue/resume and edit races.
- [ ] Resolve blocking findings with focused tests.
- [ ] Build and package using local Electron runtime, back up exact prior release app, verify source/installed asar hashes. Do not launch app.
- [ ] Give concise manual test steps covering single/batch imports and Search config failure.
