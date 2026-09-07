/**
 * Internal (never package-exported) timeout budgets for the OPT-IN
 * provider-contract live suite. Observed root cause: vitest reported its
 * default 5000ms per-test deadline while the probe's HTTP client budget was
 * 15000ms, so the framework cut the request short. The per-test deadline
 * passed to vitest must therefore strictly exceed the client budget with a
 * positive cleanup margin. The search-benchmark live entry has its own
 * deadline design, kept separate from these contract budgets.
 */

/** HTTP client total budget for one provider-contract probe (unchanged). */
export const LIVE_CONTRACT_HTTP_TIMEOUT_MS = 15_000;

/** Positive margin after the client budget so the framework never interrupts cleanup. */
export const LIVE_CONTRACT_CLEANUP_MARGIN_MS = 15_000;

/** Effective per-test deadline passed to vitest: HTTP budget + margin. */
export const LIVE_CONTRACT_TEST_TIMEOUT_MS = LIVE_CONTRACT_HTTP_TIMEOUT_MS + LIVE_CONTRACT_CLEANUP_MARGIN_MS;
