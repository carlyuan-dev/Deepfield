# Task 1 report: capability package protocol

## Outcome

Implemented the Phase 1 capability SDK manifest contract and lifecycle resource scope without wiring it into production startup.

## Files

- `packages/capability-sdk/package.json`
- `packages/capability-sdk/src/index.ts`
- `packages/capability-sdk/src/manifest.ts`
- `packages/capability-sdk/src/manifest.test.ts`
- `packages/capability-sdk/src/lifecycle.ts`
- `packages/capability-sdk/src/lifecycle.test.ts`
- `tsconfig.base.json`
- `package-lock.json`

No root `package.json`, user documentation, benchmark, evaluation, GUI, live service, build, or package output was changed or run.

## RED evidence

Command:

```text
npx vitest run packages/capability-sdk/src/manifest.test.ts packages/capability-sdk/src/lifecycle.test.ts
```

Result: exit 1. Both suites failed before collecting tests because the deliberately unimplemented `./manifest.js` and `./lifecycle.js` modules could not be found. This confirmed the new tests depended on the missing production APIs.

## GREEN evidence

Final focused verification command:

```text
npx vitest run packages/capability-sdk/src/manifest.test.ts packages/capability-sdk/src/lifecycle.test.ts
```

Result: exit 0; 2 test files passed, 14 tests passed, 0 failed.

Typecheck command:

```text
npm run typecheck
```

Result: exit 0 (`tsc --noEmit -p tsconfig.base.json`).

Diff hygiene command:

```text
git diff --check
```

Result: exit 0.

## Covered contract

- Accepts a closed valid v1 probe manifest.
- Reports protocol or host API major versions other than 1 as `incompatible`.
- Rejects duplicate action IDs, absolute paths, parent traversal, remote `$ref`, unsupported schema keywords, and unknown fields.
- Restricts declared schemas to the Phase 1 keyword subset using the repository's existing TypeBox dependency.
- Provides `createResourceScope()` with LIFO async cleanup, failure isolation, safe `cleanup_failed` issue codes, and concurrent/sequential idempotent disposal.

## Commit

- `848c769 feat: define capability package protocol`
