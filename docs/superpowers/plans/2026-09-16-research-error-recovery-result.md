# Research error recovery result

Implemented typed, context-specific recovery for company research errors.

## Behavior

- Configuration readiness failures now show the specific LLM/Search guidance and a **前往设置** action. They do not offer the ineffective **重新加载** action.
- The recovery action opens the relevant Settings module when the failing service is known. Combined/unknown readiness failures open LLM first.
- Only state/report read failures offer **重新加载**. A successful state or detail read clears only its matching read error, leaving unrelated configuration/action errors intact.
- Persisted execution failures retain the existing **重新尝试** workflow and no longer masquerade as read failures.
- Readiness preflight still runs before `start`/`retry`, so a missing key does not call the research IPC or create a failed paid run.
- A launch/retry modal remains mounted while Settings is open. Its filled fields and error guidance survive the round trip, and Escape in Settings cannot close the hidden modal.

## Verification

- `npm test -- apps/desktop/src/renderer/features/industry-research/research-readiness.test.tsx apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx` — 65 tests passed.
- `npm test -- apps/desktop/src/renderer/features/settings/SettingsView.test.tsx apps/desktop/src/renderer/features/industry-research/research-readiness.test.tsx` — 28 tests passed.
- App-level mocked recovery flow — 1 test passed: missing Search key, targeted Settings recovery, hidden-modal Escape protection, draft retention, save, and explicit manual retry.
- Cross-run error isolation — 1 test passed: selecting a successful history entry clears the previous run's execution error.
- `npm run typecheck` — passed.
- `npm run build` and the approved unsigned arm64 directory package completed successfully. Local and installed `app.asar` SHA-256: `5b390271d4f1e95827730696a81e2d607e4aab57cbef5595f257aebffb9a6d45`.
- Installed package: `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app`.
- Previous package backup: `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app.backup-20260916-130500` (old `app.asar` SHA-256: `1ecfcd9bd6826f937e335c7eccc03a19199379f25a3227ee31418763148c40c7`).
- No real provider request, Electron, packaged app, Playwright, or other GUI process was launched.
