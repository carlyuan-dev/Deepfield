import { describe, expect, it } from "vitest";
import { runBenchmark, type HarnessProvider, type LinkChecker } from "./run-benchmark.js";
import type { NormalizedSearchResponse } from "../search-provider.js";
import type { LiveProviderId } from "../providers/provider-catalog.js";

const USD = () => ({
  amountPerRequest: 0.01,
  currency: "USD" as const,
  usdPerCurrencyUnit: 1,
  priceSourceUrl: "https://example.com/pricing",
  priceObservedOn: "2026-09-01",
});

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error("wait timeout");
    }
    await settle(5);
  }
}

function providerWithUrls(id: LiveProviderId, urlsFor: (query: string) => string[]): { provider: HarnessProvider; searchCalls: string[] } {
  const searchCalls: string[] = [];
  const provider: HarnessProvider = {
    id,
    endpoint: `https://${id}.example/search`,
    async search(query, maxResults): Promise<NormalizedSearchResponse> {
      searchCalls.push(`${id}:${query}`);
      const urls = urlsFor(query).slice(0, maxResults);
      return {
        provider: id,
        results: urls.map((url, index) => ({
          provider: id,
          title: "t",
          snippet: "s",
          url,
          rank: index + 1,
        })),
      };
    },
  };
  return { provider, searchCalls };
}

function gatedChecker(behavior: { onRelease?: (url: string) => { accessible: boolean } | Error } = {}): {
  checker: LinkChecker;
  started: string[];
  release: () => void;
  gate: Promise<void>;
  activeNow: () => number;
  maxActive: () => number;
} {
  const started: string[] = [];
  const active = new Set<string>();
  let maxSeen = 0;
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const checker: LinkChecker = {
    async check(url: string): Promise<{ url: string; accessible: boolean }> {
      started.push(url);
      active.add(url);
      maxSeen = Math.max(maxSeen, active.size);
      await gate;
      active.delete(url);
      if (behavior.onRelease) {
        const outcome = behavior.onRelease(url);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return { url, accessible: outcome.accessible };
      }
      return { url, accessible: true };
    },
  };
  return {
    checker,
    started,
    release: () => releaseFn!(),
    gate,
    activeNow: () => active.size,
    maxActive: () => maxSeen,
  };
}

function uniqueUrls(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://${prefix}.example/${index + 1}`);
}

function quietProvider(id: "baidu" | "metaso"): HarnessProvider {
  return {
    id,
    endpoint: `https://${id}.example/quiet`,
    async search(): Promise<NormalizedSearchResponse> {
      return { provider: id, results: [] }; // never adds links; harness requires >= 2 providers
    },
  };
}

async function runOnce(providers: HarnessProvider[], linkChecker: LinkChecker, signal?: AbortSignal) {
  const all = providers.length === 1 ? [...providers, quietProvider(providers[0]!.id === "baidu" ? "metaso" : "baidu")] : providers;
  return runBenchmark({
    providers: all,
    runsPerQuery: 1,
    maxResults: 20,
    linkChecker,
    pricing: { baidu: USD(), metaso: USD() },
    writer: () => undefined,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("runBenchmark bounded concurrent link checks (focused revision)", () => {
  it("starts all 20 unique links of one measurement before any resolves (serial implementation starts only 1)", async () => {
    const { provider } = providerWithUrls("baidu", () => uniqueUrls("first", 20));
    const links = gatedChecker();
    const run = runOnce([provider], links.checker);
    await until(() => links.started.length > 0);
    await settle(80); // give a serial implementation every chance to start more
    expect(links.started).toHaveLength(20);
    links.release();
    const report = await run;
    expect(report.benchmarkComplete).toBe(true);
    expect(report.successfulMeasurements).toBe(20); // baidu(10) + quiet metaso(10)
  });

  it("bounds active checks to 20 per measurement and dedupes identical urls to a single global check", async () => {
    // fresh urls every measurement (20/query x 10 queries): every check must
    // run, but never more than 20 concurrently in one batch
    const fresh = providerWithUrls("baidu", (query) => uniqueUrls(`many-${query}`, 20));
    const links = gatedChecker();
    const runFresh = runOnce([fresh.provider], links.checker);
    await until(() => links.started.length >= 20);
    expect(links.maxActive()).toBeLessThanOrEqual(20);
    links.release();
    const freshReport = await runFresh;
    expect(freshReport.benchmarkComplete).toBe(true);
    expect(links.started).toHaveLength(200);

    // identical 20 urls every measurement: the global cache checks them once
    const dedup = providerWithUrls("baidu", () => uniqueUrls("same", 20));
    const dedupLinks = gatedChecker();
    const runDedup = runOnce([dedup.provider], dedupLinks.checker);
    await until(() => dedupLinks.started.length >= 20);
    expect(dedupLinks.maxActive()).toBeLessThanOrEqual(20);
    dedupLinks.release();
    const dedupReport = await runDedup;
    expect(dedupReport.benchmarkComplete).toBe(true);
    expect(dedupLinks.started).toHaveLength(20);
  });

  it("completes a 20-link measurement in roughly one batch of wall-clock time, not 20 batches", async () => {
    const { provider } = providerWithUrls("baidu", () => uniqueUrls("timed", 20));
    const checker: LinkChecker = {
      async check(url) {
        await settle(25); // 20 x 25ms serial would take >= 500ms
        return { url, accessible: true };
      },
    };
    const startedAt = Date.now();
    const report = await runOnce([provider], checker);
    const elapsedMs = Date.now() - startedAt;
    expect(report.benchmarkComplete).toBe(true);
    expect(elapsedMs).toBeLessThan(400);
  });

  it("resolves in arbitrary order but keeps linkEvidence in deterministic first-seen result order", async () => {
    const { provider } = providerWithUrls("baidu", () => uniqueUrls("order", 5));
    const checker: LinkChecker = {
      async check(url) {
        const index = Number(url.split("/").pop());
        await settle((6 - index) * 10); // later urls finish first
        return { url, accessible: true };
      },
    };
    const report = await runOnce([provider], checker);
    const evidence = report.linkEvidence.baidu!.map((entry) => entry.url);
    expect(evidence).toEqual(uniqueUrls("order", 5));
  });

  it("checks a cross-provider shared url only once and projects the outcome to both providers", async () => {
    const shared = "https://shared.example/page";
    const baidu = providerWithUrls("baidu", () => [shared]);
    const metaso = providerWithUrls("metaso", () => [shared]);
    let calls = 0;
    const checker: LinkChecker = {
      async check(url) {
        calls += 1;
        return { url, accessible: true };
      },
    };
    const report = await runOnce([baidu.provider, metaso.provider], checker);
    expect(calls).toBe(1);
    expect(report.linkEvidence.baidu!.map((e) => e.url)).toEqual([shared]);
    expect(report.linkEvidence.metaso!.map((e) => e.url)).toEqual([shared]);
    expect(report.linkEvidence.baidu![0]!.accessible).toBe(true);
  });

  it("observes every started check when one throws unexpectedly: single stable failure, no unhandled rejection", async () => {
    const { provider } = providerWithUrls("baidu", () => uniqueUrls("boom", 6));
    const links = gatedChecker({
      onRelease: (url) => (url.endsWith("/2") ? new Error("unexpected infra boom") : { accessible: true }),
    });
    const run = runOnce([provider], links.checker);
    await until(() => links.started.length >= 6);
    links.release();
    const report = await run;
    const failed = report.failures.filter((failure) => failure.includes("link_check_failed"));
    expect(failed).toHaveLength(1);
    expect(report.linkCheckFailures).toEqual(["baidu"]);
    expect(report.failures.some((failure) => failure.includes("infra boom"))).toBe(false);
  });

  it("aborts promptly on deadline: incomplete report, no later provider searches, no failure records", async () => {
    const { provider, searchCalls } = providerWithUrls("baidu", () => uniqueUrls("abort", 20));
    const links = gatedChecker();
    const controller = new AbortController();
    const abortable: LinkChecker = {
      async check(url, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
          links.started.push(url);
        });
      },
    };
    const run = runOnce([provider], abortable, controller.signal);
    await until(() => links.started.length > 0);
    const startedAt = Date.now();
    controller.abort();
    const report = await run;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(report.benchmarkComplete).toBe(false);
    expect(report.failures).toHaveLength(0);
    const callsAfter = searchCalls.length;
    await settle(50);
    expect(searchCalls.length).toBe(callsAfter); // no later provider searches
  });

  it("keeps provider search order/count identical to the serial semantics", async () => {
    const baidu = providerWithUrls("baidu", (query) => [`https://baidu.example/${encodeURIComponent(query)}`]);
    const metaso = providerWithUrls("metaso", (query) => [`https://metaso.example/${encodeURIComponent(query)}`]);
    const checker: LinkChecker = {
      async check(url) {
        return { url, accessible: true };
      },
    };
    const report = await runOnce([baidu.provider, metaso.provider], checker);
    expect(report.benchmarkComplete).toBe(true);
    expect(report.expectedMeasurements).toBe(20);
    expect(report.attemptedMeasurements).toBe(20);
    // all ten baidu queries run before the first metaso query (serial providers)
    expect(baidu.searchCalls).toHaveLength(10);
    expect(metaso.searchCalls).toHaveLength(10);
    expect(metaso.searchCalls[0]!).toMatch(/^metaso:/);
  });
});
