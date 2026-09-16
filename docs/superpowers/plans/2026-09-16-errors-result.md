# Task 2 result — common errors and research retry

Implemented a small common error identity and a shared pure research retry policy. Internal AppError can retain a cause; the public DTO contains only a registered code, its matching category, and optional enum-only service context (`llm`/`search`). Unknown, mismatched or extra-field payloads normalize to INTERNAL.UNKNOWN. Projection excludes Error messages, stacks and causes, including non-enumerable fields.

## Adoption and extension rules

- Add new codes to `APP_ERROR_CATEGORIES`; category matching is enforced by both the mapped public union and runtime schema. Extend the context schema only with reviewed, bounded public values. Do not add raw strings for provider bodies, headers, keys, paths or exception messages.
- Map known provider/gateway error classes in adapters, using typed identities rather than message parsing. Search unauthorized, timeout and rate-limited preserve their distinction. Pi currently exposes opaque ModelGatewayError, so its honest public classification is EXTERNAL.UNAVAILABLE; this change does not infer authentication or timeout from opaque text.
- Settings diagnose and research start/retry use IPC result envelopes. Preload checks the envelope and result schema, returns the existing success shape and rejects with a plain validated DTO. Renderer uses structural normalization for transported errors; no Error prototype/custom property preservation is assumed. Diagnostic legacy code/message fields remain for API compatibility, with fixed safe message/summary at the preload boundary. Chinese presentation belongs to the relevant UI context.
- Renderer readiness remains a UX preflight; backend profile resolution is authoritative. Preflight distinguishes absent active profiles from missing credentials and keeps combined local wording without assigning a misleading single service. Blank UI key fields continue to omit the replacement, retaining saved credentials.
- Retry policy is shared by service, hook preflight and button eligibility. Failed raw research always restarts raw; structure_failed + none and completed + none restart raw; unchanged structure_failed + unknown/succeeded uses structure only; changed normalized input restarts raw; ordinary completed and active runs are unavailable. Legacy retryStructuring delegates to retryFailed so the startup reservation and policy cannot be bypassed. Repository atomic ownership/transitions remain unchanged.
- Intentionally not migrated: Chat/tool-loop/worker failure protocol, automatic retries, settings CRUD/read IPC, research read/cancel/delete IPC, general industry-research errors. No new retry engine or provider calls.

## Exact Task 2 files

- Contracts: `packages/contracts/src/errors.ts`, `errors.test.ts`, `research-retry-policy.ts`, `research-retry-policy.test.ts`, `index.ts`, `settings.ts`.
- Main: `apps/desktop/src/main/profile-store.ts`, `configuration-service.ts`, `configuration-service.test.ts`, `ipc.ts`, `ipc.test.ts`, `ipc-arity.test.ts`, `ipc-trusted-adapter.test.ts`, `errors-ipc.test.ts`.
- Preload: `apps/desktop/src/preload/preload-api.ts`, `preload-api.test.ts`.
- Application: `packages/application/src/company-research-service.ts`, `company-research-service.test.ts`.
- Renderer settings: `apps/desktop/src/renderer/features/settings/error-presentation.ts`, `research-readiness.ts`, `SettingsView.tsx`, `SettingsView.test.tsx`.
- Renderer research: `apps/desktop/src/renderer/features/industry-research/research-error-presentation.ts`, `research-readiness.test.tsx`, `use-company-research.ts`, `CompanyResearchModal.tsx`, `CompanyResearchPanel.tsx`.
- Electron probe: `tests/e2e/errors.spec.ts`.
- This report: `docs/superpowers/plans/2026-09-16-errors-result.md`.

All work preserves the pre-existing uncommitted changes; no commits or Task 1 layout edits were made by this implementer.

## Verification

- `npm run typecheck` — passed after implementation; parent also ran the integrated typecheck.
- Focused error/policy tests — 18 passed initially; additional projection regression is included in the 51-test boundary run below.
- Configuration diagnostics and ProfileStore — 14 passed, covering successful unsaved diagnostics, typed Search failures, missing keys, opaque LLM failures and unknown secret-bearing failures.
- New IPC boundary + application service — 52 passed, including plain DTO round trips, malformed envelopes, backend credential detail, retry modes and legacy structure-retry reservation.
- Settings/readiness/research panel — 73 passed, including stale request handling and exiting testing after transport rejection. Added readiness identity/backend DTO presentation tests subsequently passed with 14/14 readiness tests.
- `npm test -- packages/contracts/src/errors.test.ts apps/desktop/src/main/errors-ipc.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/preload/preload-api.test.ts` — 51 passed.
- `npm test -- apps/desktop/src/main/ipc-arity.test.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts` — 39 passed after updating old envelope assertions; untrusted sender, zero invalid service calls and subscription guards remain intact.
- `npm run build` — passed.
- `npx playwright test tests/e2e/errors.spec.ts` — initial sandbox launch failed with `Process failed to launch!`; same focused command under approved escalation passed 1/1. It used an isolated temporary profile and real contextBridge, proving plain DTO rejections and missing-credential diagnostics survive Electron. No provider requests were made. Successful run quit and awaited close in finally. The launch-failure cleanup was subsequently improved without another Electron run, following the user's stop request.

Parent owns the one integrated full-suite run and packaging. No real-provider credential/authentication verification is claimed. Electron launch diagnostics require separate investigation after the user reported desktop error dialogs; no further launches are authorized in this task's current state.
