# Settings layout result

Implemented the approved Settings and research-detail layout refinements without changing routing or Settings persistence semantics.

## Changes

- Kept the primary sidebar mounted and unchanged while Settings is open. A dedicated 176px secondary Settings navigation now contains Back, LLM, and Search controls beside the scrollable Settings page.
- Primary conversation, new-conversation, and research actions close Settings and navigate immediately. The hidden workspace remains mounted so chat drafts and prior research state survive a Settings visit.
- Made the Settings content container-responsive. Profile columns stack when the content column (after both sidebars) falls below 720px; form grids use shrinkable tracks, long fields can contract, and diagnostic/action rows wrap.
- Removed separators from the fixed research breadcrumb and contextual navigation rows.
- Renamed the company action to “编辑信息” and gave both company-detail actions an explicit matching 36px, non-wrapping size.

## Verification

- `npm test -- apps/desktop/src/renderer/settings-css.test.ts` — 2 tests passed.
- `npm test -- apps/desktop/src/renderer/App-settings.test.tsx -t "preserves an unsent chat draft"` — 1 test passed.
- Primary verification: focused App/Settings/Sidebar renderer suite — 26 tests passed; `npm run typecheck` passed.
- `npm run build` and the approved unsigned arm64 directory package completed successfully.
- Installed/source `app.asar` SHA-256: `1ecfcd9bd6826f937e335c7eccc03a19199379f25a3227ee31418763148c40c7`.
- Previous package backup: `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app.backup-20260916-112700` (old `app.asar` SHA-256: `99db966e2c3911777dce3a0f1978d134f14218727e5d0b6c1ce93322ca18bd5b`).
- No Electron, Playwright, packaged app, or other GUI process was launched.
