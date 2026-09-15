# Company Research History final fix report

Date: 2026-09-16

Fix base: `2929738ccc44ac2e19dfb594fafd3dabc849f433`

## Findings resolved

1. Strengthened migration 13's `structure_failed` table invariant. A persisted row now requires non-null raw report text, non-null raw completion time, at least one structuring attempt, and an explicitly non-null `structuring_failed` failure code. This avoids SQLite's behavior of accepting a `CHECK` expression whose result is `NULL`.
2. The renderer now clears `detailLoading` when deletion succeeds but the authoritative state refresh fails. The deleted selection/body stays cleared, the retryable state error remains visible, and an invalidated late detail request cannot restore the deleted report or leave a permanent loading state.
3. Removed the extra blank line at EOF from `provider-http-client.test.ts`; no test behavior changed.

## TDD evidence

### RED: persistence constraint

Command:

```text
npm test -- packages/persistence/src/company-research-run-repository.test.ts
```

Result before the migration change: exit 1, 33 passed and 4 failed. Each new direct-SQL mutation was accepted instead of throwing:

- `last_failure_code = NULL`
- `raw_report_text = NULL`
- `raw_completed_at = NULL`
- `structuring_attempts = 0`

All four failures reported `AssertionError: expected [Function] to throw an error`.

### RED: deletion/detail race

Command:

```text
npm test -- apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx
```

Result before the renderer change: exit 1, 45 passed and 1 failed. After a pending detail request, successful deletion, and failed `getState`, the test found the stale `加载调研报告…` element instead of `null`.

### GREEN: focused fixes

Command:

```text
npm test -- packages/persistence/src/company-research-run-repository.test.ts apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx
```

Result: exit 0, 2 files passed, 83 tests passed.

### GREEN: migration compatibility

Command:

```text
npm test -- packages/persistence/src/capability-persistence.test.ts packages/persistence/src/company-research-run-repository.test.ts
```

Result: exit 0, 2 files passed, 44 tests passed. The existing v12-to-v13 migration coverage retained legal completed and structure-failed history.

## Final verification

- `npm run typecheck`: exit 0.
- `npm test -- apps/desktop/src/renderer/App-shell.test.tsx`: exit 0, 9 tests passed.
- `npm test -- --maxWorkers=4`: exit 0, 134 files passed, 1372 tests passed, 2 skipped (1374 total).
- Focused migration/persistence and CompanyResearchPanel commands above: exit 0.
- `git diff --check 12dd3be4c23a30ed93b36541ff5897a5f561d217..HEAD`: exit 0 with no output.

The literal default-worker `npm test` command was also run twice. Both complete runs reached 133 passed files and 1371 passed tests, with only the pre-existing `apps/desktop/src/renderer/App-shell.test.tsx:179` test crossing its 5000 ms timeout (5010 ms and 5048 ms respectively). The same file passed 9/9 alone, and the complete suite passed with four workers. No production or test timeout was changed to hide this resource-sensitive failure.

## Files changed

- `packages/persistence/src/migrations.ts`
- `packages/persistence/src/company-research-run-repository.test.ts`
- `apps/desktop/src/renderer/features/industry-research/use-company-research.ts`
- `apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`
- `packages/retrieval/src/providers/provider-http-client.test.ts`
- `.superpowers/sdd/2026-09-16-company-research-history-controls/final-fix-report.md`

## Self-review

- Scope is limited to the three confirmed findings and their regression coverage.
- The database fix is expressed at the storage boundary, so direct or abnormal writes cannot create rows that repository reads must reject.
- The strengthened constraint accepts the legal v12 `structure_failed` rows produced by existing repository transitions; migration compatibility tests pass.
- The renderer fix invalidates stale details as before and additionally terminates the only loading flag whose original request can no longer clear it.
- The UI regression test covers the pending request before deletion, the retryable refresh error, removal of the deleted version/body, absence of the loading placeholder, and a late detail resolution.
- The new SQL tests derive expectations from the documented state invariant and exercise the real migrated SQLite table rather than repository validation mocks.
- No API shape, user-facing error wording, unrelated test behavior, or timeout configuration changed.

## Post-commit diff check

`git diff --check 12dd3be4c23a30ed93b36541ff5897a5f561d217..HEAD` completed with exit 0 and no output after the fix commit was created.
