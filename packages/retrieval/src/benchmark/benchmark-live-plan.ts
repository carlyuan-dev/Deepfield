import { BENCHMARK_CANDIDATES_V1, type LiveProviderId } from "../providers/provider-catalog.js";
import { QUERIES_V1 } from "./queries.js";

/**
 * Immutable live benchmark plan (internal module, no package export): the ONE
 * source of approved facts for the OPT-IN live benchmark. Providers come from
 * the single provider catalog (never a second driftable list), the query count
 * is validated against the frozen query set, and the arithmetic is re-checked
 * fail-closed so no transport/provider request can run under an unapproved
 * configuration. Errors are fixed and value-free: no keys, query text or
 * pricing content is ever echoed.
 */
export interface LiveBenchmarkPlan {
  readonly providers: Readonly<LiveProviderId[]>;
  readonly queryCount: number;
  readonly runsPerQuery: number;
  readonly maxResults: number;
  readonly expectedMeasurements: number;
  readonly automaticProviderRetries: number;
}

const PLAN_ERROR = "live benchmark plan validation failed";

const APPROVED_QUERY_COUNT = 10;
const APPROVED_RUNS_PER_QUERY = 1;
const APPROVED_MAX_RESULTS = 20;
const APPROVED_EXPECTED_MEASUREMENTS = 40;
const APPROVED_AUTO_RETRIES = 0;

export const BENCHMARK_PLAN: LiveBenchmarkPlan = Object.freeze({
  providers: BENCHMARK_CANDIDATES_V1, // frozen canonical baidu,metaso,tavily,serper
  queryCount: QUERIES_V1.length,
  runsPerQuery: APPROVED_RUNS_PER_QUERY,
  maxResults: APPROVED_MAX_RESULTS,
  expectedMeasurements: BENCHMARK_CANDIDATES_V1.length * QUERIES_V1.length * APPROVED_RUNS_PER_QUERY,
  automaticProviderRetries: APPROVED_AUTO_RETRIES,
});

/** Pure fail-closed check used by the lock and by offline drift tests. */
export function assertBenchmarkPlanFacts(facts: Readonly<LiveBenchmarkPlan>): void {
  if (facts.queryCount !== APPROVED_QUERY_COUNT || QUERIES_V1.length !== APPROVED_QUERY_COUNT) {
    throw new Error(PLAN_ERROR);
  }
  if (facts.runsPerQuery !== APPROVED_RUNS_PER_QUERY || facts.maxResults !== APPROVED_MAX_RESULTS) {
    throw new Error(PLAN_ERROR);
  }
  if (facts.automaticProviderRetries !== APPROVED_AUTO_RETRIES) {
    throw new Error(PLAN_ERROR);
  }
  const canonical = [...BENCHMARK_CANDIDATES_V1];
  if (facts.providers.length !== canonical.length || facts.providers.some((id, index) => id !== canonical[index])) {
    throw new Error(PLAN_ERROR);
  }
  if (facts.expectedMeasurements !== canonical.length * APPROVED_QUERY_COUNT * APPROVED_RUNS_PER_QUERY) {
    throw new Error(PLAN_ERROR);
  }
  if (facts.expectedMeasurements !== APPROVED_EXPECTED_MEASUREMENTS) {
    throw new Error(PLAN_ERROR);
  }
}

/**
 * Locks the single plan against catalog/query/config drift. Must run BEFORE
 * any transport/provider request in the live entry. Fixed sanitized errors
 * only.
 */
export function validateLiveBenchmarkPlan(): void {
  assertBenchmarkPlanFacts(BENCHMARK_PLAN);
}

/** Overall application deadline: covers 40 provider searches + destination link checks. */
export const LIVE_BENCHMARK_OVERALL_TIMEOUT_MS = 60 * 60_000; // 60 minutes
/** Vitest per-test deadline margin so vitest never kills before the app deadline. */
export const LIVE_BENCHMARK_TIMEOUT_MARGIN_MS = 60_000; // 1 minute
/** Vitest per-test timeout: overall + margin (61 minutes). */
export const LIVE_BENCHMARK_VITEST_TIMEOUT_MS = LIVE_BENCHMARK_OVERALL_TIMEOUT_MS + LIVE_BENCHMARK_TIMEOUT_MARGIN_MS;

export interface ScheduledHandle {
  cleared: boolean;
}

export interface BenchmarkDeadline {
  readonly controller: AbortController;
  /** Clears the timer; safe to call more than once and after the timer fired. */
  dispose(): void;
}

/**
 * Single overall deadline timer feeding runBenchmark's AbortSignal. The timer
 * is always cleared by dispose() (success/failure/cancel paths) so no handle
 * survives. Injectable scheduler keeps offline tests fast and deterministic;
 * the real path uses setTimeout/clearTimeout and is idempotent.
 */
export function createBenchmarkDeadline(
  overallTimeoutMs: number,
  timers?: {
    schedule: (fn: () => void, ms: number) => ScheduledHandle;
    clear: (handle: ScheduledHandle) => void;
  },
): BenchmarkDeadline {
  const controller = new AbortController();
  if (timers === undefined) {
    const handle = setTimeout(() => controller.abort(), overallTimeoutMs);
    let disposed = false;
    return {
      controller,
      dispose() {
        if (!disposed) {
          disposed = true;
          clearTimeout(handle);
        }
      },
    };
  }
  const scheduled = timers.schedule(() => controller.abort(), overallTimeoutMs);
  let disposed = false;
  return {
    controller,
    dispose() {
      if (!disposed) {
        disposed = true;
        timers.clear(scheduled);
      }
    },
  };
}
