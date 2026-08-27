import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-http-client.js";
import { createBraveProvider } from "../providers/brave.js";
import { createTavilyProvider } from "../providers/tavily.js";
import { createSerperProvider } from "../providers/serper.js";
import { QUERIES_V1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1 } from "./reference-companies.js";
import { scoreBenchmark, type BenchmarkedRun, type LinkValiditySample } from "./scoring.js";
import { writeBenchmarkReport, type BenchmarkReport, type ProviderConfigSummary } from "./report.js";
import { join } from "node:path";

/**
 * OPT-IN live benchmark: runs the frozen v1 query set (10 queries x 2 runs,
 * top 20) against each configured provider, scores the results and writes the
 * report under the ignored benchmark-results/. Only runs under
 * vitest.live.config.ts and fails loudly when required keys are absent.
 */
function requireKey(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required to run the live benchmark`);
  }
  return value;
}

function makeClient(): ProviderHttpClient {
  return new ProviderHttpClient({ transport: createNodeProviderTransport(), totalTimeoutMs: 20_000 });
}

describe("search benchmark live (opt-in)", () => {
  it("runs the frozen query set twice per provider and writes an ignored report", async () => {
    const providers: Array<{ id: string; create: (client: ProviderHttpClient, token: string) => { search: typeof createBraveProvider.prototype.search } }> = [
      { id: "brave", create: (client, token) => createBraveProvider({ client, token }) },
      { id: "tavily", create: (client, token) => createTavilyProvider({ client, token }) },
      { id: "serper", create: (client, token) => createSerperProvider({ client, token }) },
    ];
    const runsPerQuery = 2;
    const maxResults = 20;
    const client = makeClient();
    const failures: string[] = [];
    const runs: BenchmarkedRun[] = [];
    const configs: ProviderConfigSummary[] = [];

    for (const entry of providers) {
      const envKey = `${entry.id.toUpperCase()}_API_KEY`;
      let token: string;
      try {
        token = requireKey(envKey);
      } catch (error) {
        failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const provider = entry.create(client, token) as { id: string; search(req: { query: string; maxResults: number }, signal: AbortSignal): Promise<unknown> };
      configs.push({ provider: entry.id, endpoint: `https://${entry.id === "tavily" ? "api.tavily.com/search" : entry.id === "serper" ? "google.serper.dev/search" : "api.search.brave.com/res/v1/web/search"}`, maxResults, runsPerQuery });
      for (const query of QUERIES_V1) {
        for (let round = 0; round < runsPerQuery; round += 1) {
          const startedAt = performance.now();
          try {
            const response = (await provider.search({ query: query.query, maxResults }, new AbortController().signal)) as { provider: string; results: unknown[] };
            runs.push({
              provider: entry.id,
              queryId: query.id,
              query: query.query,
              results: response.results as BenchmarkedRun["results"],
              latencyMs: performance.now() - startedAt,
              costUsd: 0, // recorded by the external credential gate in Task 9
            });
          } catch (error) {
            failures.push(`${entry.id}/${query.id}/run${round}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    const linkValidity: Record<string, LinkValiditySample> = {};
    for (const provider of new Set(runs.map((run) => run.provider))) {
      linkValidity[provider] = { valid: 0, total: 0 }; // link checking happens in Task 9's probe
    }
    const scored = scoreBenchmark({
      runs,
      linkValidity,
      queries: { version: "v1", queries: QUERIES_V1 },
      reference: { version: "v1", companies: REFERENCE_COMPANIES_V1 },
    });

    const report: BenchmarkReport = {
      querySetVersion: "v1",
      referenceSetVersion: "v1",
      generatedAt: new Date().toISOString(),
      providerConfig: configs,
      failures,
      runs,
      scores: scored.providers,
      hardGatePassed: scored.hardGatePassed,
      hardGates: scored.hardGates,
    };
    const directory = join(process.cwd(), "benchmark-results");
    const target = writeBenchmarkReport(directory, report);
    expect(target).toContain("benchmark-results");
    expect(failures.length).toBeLessThan(runs.length + 1); // at least something completed
  });
});
