# Responsive button layout result

## Root cause

The company-research heading was a single non-wrapping flex row. Its long disclaimer and action group both used the default `flex-shrink: 1`, so the narrow Capability pane compressed “开始调研” below its text's intrinsic width and Chinese characters wrapped one per line. The existing viewport media query did not help because the failure depended on the inner pane width, not the window width.

## Fix and audit coverage

- Capability headings and research status rows now wrap based on their actual available width. Text columns have `min-width: 0`; action groups can move as a unit and wrap internally; action buttons use `flex: 0 0 auto` and `white-space: nowrap`.
- Removed the obsolete viewport-only column breakpoint; combined with the new horizontal flex basis it could incorrectly reserve 280px of vertical space. Actual container width now controls wrapping without changing axes.
- Capability topic/company toolbars, retry/start/cancel controls, list edit/remove/retry controls, report tabs, modal footers, candidate rows, and import controls use the same action-button rule.
- The report version selector remains on one line with its 36px delete action: the label/select shrink through `min-width: 0`, while the delete action remains fixed.
- Modal titles and list text remain flexible; close/action buttons do not shrink.
- Chat composer controls wrap without crushing Send or web-search buttons. Link-popover and load-error actions wrap, while tool-call count labels stay intact and dynamic summaries ellipsize.
- Chat headers keep fixed toggle/close controls; pane error actions wrap. Chat rail header actions remain fixed, and the intentional collapsed vertical button style is preserved.
- Sidebar primary navigation and conversation titles use ellipsis rather than character-by-character wrapping; delete controls remain fixed.
- Settings navigation/Profile names ellipsize. Diagnostics and editor actions wrap as groups while their buttons remain intact.
- No global button width, height, or no-wrap rule was added; cards, navigation, long summaries, and selectable rows retain their intended elasticity.

## Verification

- `npm test -- apps/desktop/src/renderer/button-responsive-css.test.ts apps/desktop/src/renderer/capability-css.test.ts apps/desktop/src/renderer/settings-css.test.ts apps/desktop/src/renderer/components/Sidebar-layout.test.tsx` — 9 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed after the final CSS adjustment.
- Approved unsigned arm64 directory packaging completed and installed at `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app`. Source and installed `app.asar` SHA-256: `27a191aa004c2b569362df132c0f00f608c17584c92a16fe0ff872a5cb521863`.
- Previous package backup: `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app.backup-20260916-135600` (old `app.asar` SHA-256: `5b390271d4f1e95827730696a81e2d607e4aab57cbef5595f257aebffb9a6d45`).
- `git diff --check` — passed.
- No Electron, packaged app, Playwright, GUI process, or real API request was started.
