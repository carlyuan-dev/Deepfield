import { writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import type { BenchmarkedRun, HardGateStatus, LinkEvidence, ProviderCompletion, ProviderEligibility, ProviderRawMetrics, ProviderScore } from "./scoring.js";

export const REPORT_FILENAME = "search-benchmark.json";

export interface ProviderConfigSummary {
  provider: string;
  endpoint: string;
  maxResults: number;
  runsPerQuery: number;
}

export interface BenchmarkReport {
  querySetVersion: string;
  referenceSetVersion: string;
  generatedAt: string;
  providerConfig: ProviderConfigSummary[];
  failures: string[];
  runs: BenchmarkedRun[];
  /** Fixed up front: selectedProviders x queries x runsPerQuery; never grows with progress. */
  expectedMeasurements: number;
  /** Success + failed attempts (incremented even when a run fails). */
  attemptedMeasurements: number;
  /** Successful runs only (=== runs.length). */
  successfulMeasurements: number;
  /** True ONLY when attempted === expected AND the outer loop finished normally. */
  benchmarkComplete: boolean;
  /** Non-secret per-request USD pricing (Task-9-confirmed; never contains keys). */
  pricingUsd: Record<string, number>;
  pricingNote: string;
  /** Per-provider per-URL accessibility evidence at this checkpoint. */
  linkEvidence: Record<string, readonly LinkEvidence[]>;
  linkCheckFailures: string[];
  completions: ProviderCompletion[];
  eligibility: ProviderEligibility[];
  /** All expected providers' raw metrics (incomplete providers marked). */
  raw: ProviderRawMetrics[];
  scores: ProviderScore[];
  hardGatePassed: boolean;
  hardGates: HardGateStatus;
}

/**
 * Writes the benchmark report into a CALLER-CONTROLLED directory. The target
 * path is validated to stay inside the directory (no traversal), the write is
 * atomic (temp file + rename), and a failure cleans the temp file. The live
 * output directory is the ignored benchmark-results/.
 */
export function writeBenchmarkReport(directory: string, report: BenchmarkReport): string {
  if (typeof directory !== "string" || directory.length === 0 || !isAbsolute(directory)) {
    throw new Error("invalid report directory");
  }
  const resolved = resolve(directory);
  const target = resolve(join(resolved, REPORT_FILENAME));
  if (!target.startsWith(resolved + "/") && target !== resolved) {
    throw new Error("invalid report directory");
  }
  mkdirSync(resolved, { recursive: true });
  const temp = join(resolved, `.${REPORT_FILENAME}.tmp`);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  try {
    writeFileSync(temp, serialized, "utf8");
    renameSync(temp, target);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
  return target;
}
