# Capability UI polish report

## Scope

- Base: `d16974a43ec851fbc637360a39e75bcbc8d991c8`
- Implementation head: `de2285e5fa14a77792e81045a1fb8a3a9054d54f`
- Branch: `develop`
- No worktree, GUI, live API, full-suite, merge, push, or userData changes.
- Existing evaluation changes and untracked evaluation/material files were preserved and excluded from staging.

## Changed files

- `.superpowers/capability-ui-polish-report.md`
- `apps/desktop/src/renderer/app.css`
- `apps/desktop/src/renderer/capabilities/management.test.tsx`
- `apps/desktop/src/renderer/components/Sidebar-layout.test.tsx`
- `apps/desktop/src/renderer/components/Sidebar.tsx`
- `apps/desktop/src/renderer/features/settings/CapabilitiesSettings.tsx`
- `apps/desktop/src/renderer/settings.css`

## Verification evidence

1. RED: `npx vitest run apps/desktop/src/renderer/components/Sidebar-layout.test.tsx apps/desktop/src/renderer/capabilities/management.test.tsx`
   - Exit 1 as expected before implementation.
   - Four requirement failures: permanent capability heading/empty state, exact settings copy, and removal of visible repeated checkbox text.
2. GREEN: same focused command after implementation.
   - Exit 0; 2 files, 11 tests passed.
3. `npm run typecheck`
   - Exit 0.
4. `npm run build`
   - Exit 0; Electron main/preload/renderer and capability build completed.
5. `npx electron-builder --mac --arm64 --dir --config.directories.output=release/capability-phase2-test --config.mac.identity=null --config.electronDist=node_modules/electron/dist`
   - Exit 0; only `release/capability-phase2-test/mac-arm64/Deepfield.app` was rebuilt.

## Package evidence

- Test app `Contents/Resources/app.asar` SHA-256: `27d237b71f9bc8bee936176a4c88a776b6f41edff3d7e0076ba709c28243cba7`
- Test app executable SHA-256: `1af684f056a8eb13e49fbd677072e437316086b076e3b9b92de3ddb343edc5b1`
- Stable app executable SHA-256 before and after: `dc841f07d9e0441589829ee0bf44e016acaf3b7e3d9f8b80b0a85a32b944b20b`
- Stable app `Contents/Resources/app.asar` SHA-256 after: `acceca00b35c9f0b553d5eef7ff7bf349b1463250dff871feddec5af7ae78f4d`
- Stable `release/mac-arm64/Deepfield.app` was not rebuilt or modified by the packaging command.

## Behavioral checks

- Sidebar heading is always `能力`; zero ready capabilities show the exact quiet empty text `暂时未启用任何能力`.
- Nonempty sidebar still renders only the supplied ready navigation entries; no next-start runtime logic changed.
- Settings explanation matches the approved copy exactly.
- Each normal capability row is one flex line with non-shrinking checkbox/name/version/status and a shrink-first ellipsized description whose `title` retains the full text.
- The checkbox keeps the accessible name `下次启动启用{name}` without rendering it visibly; toggle behavior remains next-start-only.
- Per-package issue output remains below the row and is rendered only when `item.issue` exists.
