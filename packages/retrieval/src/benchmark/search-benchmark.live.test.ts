import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "../providers/brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "../providers/tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "../providers/serper.js";
import { LIVE_PROVIDER_KEYS, requireProviderKey } from "../providers/live-keys.js";
import { QUERIES_V1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1 } from "./reference-companies.js";
import { scoreBenchmark, type BenchmarkedRun, type LinkValiditySample } from "./scoring.js";
import { writeBenchmarkReport, type BenchmarkReport, type ProviderConfigSummary } from "./report.js";
import { join } from "node:path";

/**
 * OPT-IN live benchmark: runs the frozen v1 query set (10 queries x 2 runs,
 * top 20) against each configured provider, scores the results and writes a
 * CHECKPOINTED report under the ignored benchmark-results/ after every
 * completed/failed measurement (an interrupted run keeps everything recorded
 * so far, marked incomplete; incomplete providers can never be eligible).
 */
const MAX_RESULTS = 20;
const RUNS_PER_QUERY = 2;

function makeClient(endpoint: import("../provider-http-client.js").ProviderEndpoint): ProviderHttpClient {
  return new ProviderHttpClient({ transport: createNodeProviderTransport(), endpoint, totalTimeoutMs: 20_000 });
}

interface HarnessProvider {
  id: keyof typeof LIVE_PROVIDER_KEYS;
  endpoint: string;
  makeClient: () => ProviderHttpClient;
  create: (client: ProviderHttpClient, token: string) => { search(req: { query: string; maxResults: number }, signal: AbortSignal): Promise<{ provider: string; results: BenchmarkedRun["results"] }> };
}

const HARNESS_PROVIDERS: HarnessProvider[] = [
  { id: "brave", endpoint: `${BRAVE_ENDPOINT.origin}${BRAVE_ENDPOINT.pathPrefix}`, makeClient: () => makeClient(BRAVE_ENDPOINT), create: (client, token) => createBraveProvider({ client, token }) },
  { id: "tavily", endpoint: `${TAVILY_ENDPOINT.origin}${TAVILY_ENDPOINT.pathPrefix}`, makeClient: () => makeClient(TAVILY_ENDPOINT), create: (client, token) => createTavilyProvider({ client, token }) },
  { id: "serper", endpoint: `${SERPER_ENDPOINT.origin}${SERPER_ENDPOINT.pathPrefix}`, makeClient: () => makeClient(SERPER_ENDPOINT), create: (client, token) => createSerperProvider({ client, token }) },
];

function buildReport(
  directory: string,
  report: BenchmarkReport,
): void {
  writeBenchmarkReport(directory, report); // atomic checkpoint (temp + rename)
}

describe("search benchmark live (opt-in)", () => {
  it("runs the frozen query set twice per provider, checkpointing after every measurement", async () => {
    const directory = join(process.cwd(), "benchmark-results");
    const failures: string[] = [];
    const runs: BenchmarkedRun[] = [];
    const configs: ProviderConfigSummary[] = [];
    let expected = 0;

    for (const entry of HARNESS_PROVIDERS) {
      let token: string;
      try {
        token = requireProviderKey(entry.id);
      } catch (error) {
        failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const provider = entry.create(entry.makeClient(), token);
      configs.push({ provider: entry.id, endpoint: entry.endpoint, maxResults: MAX_RESULTS, runsPerQuery: RUNS_PER_QUERY });
      for (const query of QUERIES_V1) {
        for (let round = 0; round < RUNS_PER_QUERY; round += 1) {
          expected += 1;
          const startedAt = performance.now();
          try {
            const response = await provider.search({ query: query.query, maxResults: MAX_RESULTS }, new AbortController().signal);
            runs.push({
              provider: entry.id,
              queryId: query.id,
              query: query.query,
              round,
              results: response.results,
              latencyMs: performance.now() - startedAt,
              costUsd: 0, // recorded by the external credential gate in Task 9
            });
          } catch (error) {
            failures.push(`${entry.id}/${query.id}/run${round}: ${error instanceof Error ? error.message : String(error)}`);
          }
          // checkpoint after EVERY measurement: an interrupt keeps this state
          const linkValidity: Record<string, LinkValiditySample> = {};
          for (const providerId of new Set(runs.map((run) => run.provider))) {
            linkValidity[providerId] = { valid: 0, total: 0 }; // link checking happens in Task 9's probe
          }
          const scored = scoreBenchmark({
            runs,
            runsPerQuery: RUNS_PER_QUERY,
            linkValidity,
            queries: { version: "v1", queries: QUERIES_V1 },
            reference: { version: "v1", companies: REFERENCE_COMPANIES_V1 },
          });
          buildReport(directory, {
            querySetVersion: "v1",
            referenceSetVersion: "v1",
            generatedAt: new Date().toISOString(),
            providerConfig: configs,
            failures,
            runs,
            expectedMeasurements: expected,
            completedMeasurements: runs.length,
            completions: scored.completions,
            eligibility: scored.eligibility,
            scores: scored.providers,
            hardGatePassed: scored.hardGatePassed,
            hardGates: scored.hardGates,
          });
        }
      }
    }

    const linkValidityFor = (): Record<string, LinkValiditySample> =>
      Object.fromEntries([...new Set(runs.map((run) => run.provider))].map((provider) => [provider, { valid: 0, total: 0 }]));
    const scored = scoreBenchmark({
      runs,
      runsPerQuery: RUNS_PER_QUERY,
      linkValidity: linkValidityFor(),
      queries: { version: "v1", queries: QUERIES_V1 },
      reference: { version: "v1", companies: REFERENCE_COMPANIES_V1 },
    });
    const finalReport: BenchmarkReport = {
      querySetVersion: "v1",
      referenceSetVersion: "v1",
      generatedAt: new Date().toISOString(),
      providerConfig: configs,
      failures,
      runs,
      expectedMeasurements: expected,
      completedMeasurements: runs.length,
      completions: scored.completions,
      eligibility: scored.eligibility,
      scores: scored.providers,
      hardGatePassed: scored.hardGatePassed,
      hardGates: scored.hardGates,
    };
    const target = writeBenchmarkReport(directory, finalReport);
    expect(target).toContain("benchmark-results");
    // at least one configured provider attempted something
    expect(configs.length + failures.length).toBeGreaterThan(0);
  });
});
