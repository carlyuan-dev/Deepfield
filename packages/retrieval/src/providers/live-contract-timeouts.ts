/**
 * Internal (never package-exported) timeout budgets for the OPT-IN
 * provider-contract live suite. Vitest's default per-test timeout is 5000ms
 * and vitest.live.config.ts sets no testTimeout, so a live probe whose HTTP
 * client budget is 15000ms would be cut short by the test framework before the
 * client can finish or clean up — the observed Tavily failure. The per-test
 * deadline passed to vitest must therefore exceed the client budget with a
 * cleanup margin. The search-benchmark live entry still inherits the 5000ms
 * default and gets its own whole-deadline design before T8A-10.
 */

/** Vitest's documented default per-test timeout when no testTimeout is set. */
export const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;

/** HTTP client total budget for one provider-contract probe (unchanged). */
export const LIVE_CONTRACT_HTTP_TIMEOUT_MS = 15_000;

/** Margin after the client budget so the framework never interrupts cleanup. */
export const LIVE_CONTRACT_CLEANUP_MARGIN_MS = 15_000;

/** Effective per-test deadline passed to vitest: 15000 + 15000 = 30000ms. */
export const LIVE_CONTRACT_TEST_TIMEOUT_MS = LIVE_CONTRACT_HTTP_TIMEOUT_MS + LIVE_CONTRACT_CLEANUP_MARGIN_MS;
