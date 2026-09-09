import { describe, expect, it } from "vitest";
import { FakeAuditSink, FakeRetryClock, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import { ToolBudgetLedger } from "@deepfield/tool-platform";
import { ResourceStore } from "@deepfield/retrieval";
import { createToolRuntime, TraceBudgetPool } from "./tool-runtime.js";

function makeRuntime(registerProbe = true) {
  return createToolRuntime({ audit: new FakeAuditSink(), registerProbe });
}

function retrievalContext(traceId: string) {
  const actor = "capability" as const;
  return {
    traceId,
    actor,
    toolSet: new ToolSet([
      {
        identity: { name: "fetch_url", version: 1 },
        actor,
        effect: "network.read.public",
      },
      {
        identity: { name: "parse_html", version: 1 },
        actor,
        effect: "project.read",
      },
    ]),
  };
}

describe("utility tool runtime assembly (focused revision)", () => {
  it("constructs without duplicate grants and freezes the registry", () => {
    const runtime = makeRuntime();
    expect(runtime.registry.list()).toHaveLength(9);
    expect(() =>
      runtime.registry.register({
        identity: { name: "echo_probe", version: 1 },
        label: "x",
        description: "x",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        effect: "project.read",
        timeoutMs: 1,
        retry: { maxRetries: 0, backoffMs: 0 },
        concurrency: 1,
        meter: { category: "none", countsBytes: false, countsTime: true },
        execute: async () => ({}),
      } as unknown as Parameters<typeof runtime.registry.register>[0]),
    ).toThrow(/frozen/);
  });

  it("does not register probe tools by default", () => {
    const runtime = makeRuntime(false);
    expect(runtime.registry.list().map((definition) => definition.identity.name)).toEqual([
      "get_current_datetime",
      "calculator",
      "convert_timezone",
      "fetch_url",
      "fetch_pdf",
      "parse_html",
      "parse_pdf",
      "check_link_accessibility",
    ]);
    expect(runtime.registry.manifest().some((entry) => entry.identity.name === "echo_probe")).toBe(
      false,
    );
  });

  it("runs echo_probe directly when explicitly registered", async () => {
    const runtime = makeRuntime(true);
    const events: { type: string }[] = [];
    const result = await runtime.run(
      {
        requestId: "req-1",
        kind: "tool.run",
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "echo_probe", version: 1 },
        input: { text: "hi" },
        actor: "developer_probe",
      },
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "started",
      "completed",
    ]);
  });

  it("keeps tool sets actor-scoped", () => {
    const runtime = makeRuntime();
    const mainTools = runtime.createAgentTools({ traceId: "t1", actor: "main_agent", projectId: "p1" });
    const probeTools = runtime.createAgentTools({ traceId: "t2", actor: "developer_probe" });
    const directTools = runtime.createAgentTools({ traceId: "t3", actor: "direct_ui" });
    expect(mainTools.map((tool) => tool.name)).toEqual([
      "get_current_datetime",
      "calculator",
      "convert_timezone",
      "echo_probe",
    ]);
    expect(runtime.registry.list().map((definition) => definition.identity.name)).toEqual(
      expect.arrayContaining([
        "fetch_url",
        "fetch_pdf",
        "parse_html",
        "parse_pdf",
        "check_link_accessibility",
      ]),
    );
    expect(probeTools.map((tool) => tool.name)).toEqual(["echo_probe"]);
    expect(directTools).toEqual([]);
  });

  it("shares one scoped resource store across fetch_url and parse_html", async () => {
    const store = new ResourceStore({ idFactory: () => "resource-1" });
    const html = Buffer.from("<html><head><title>Fixture</title></head><body><p>Shared trace body</p></body></html>");
    const transport = {
      async fetch() {
        return {
          statusCode: 200,
          finalUrl: "https://example.com/page",
          contentType: "text/html",
          body: Buffer.from(html),
          decompressedBytes: html.length,
          sha256: "fixture-sha",
        };
      },
    };
    const runtime = createToolRuntime({
      audit: new FakeAuditSink(),
      retrieval: { store, transport },
    });
    const fetchUrl = runtime.registry.resolve({ name: "fetch_url", version: 1 });
    const parseHtml = runtime.registry.resolve({ name: "parse_html", version: 1 });
    const context = retrievalContext("request-1");
    const fetched = (await fetchUrl.execute(
      { url: "https://example.com/page" },
      context,
      new AbortController().signal,
      () => undefined,
    )) as { resourceId: string };
    const parsed = (await parseHtml.execute(
      { resourceId: fetched.resourceId },
      context,
      new AbortController().signal,
      () => undefined,
    )) as { text: string };
    expect(parsed.text).toContain("Shared trace body");
    expect(store.size()).toBe(0);
  });

  it("clears an unconsumed fetched resource only after the trace ledger releases", async () => {
    const store = new ResourceStore({ idFactory: () => "resource-unconsumed" });
    const body = Buffer.from("<html><body>must not survive</body></html>");
    const runtime = createToolRuntime({
      audit: new FakeAuditSink(),
      retrieval: {
        store,
        transport: {
          async fetch() {
            return {
              statusCode: 200,
              finalUrl: "https://example.com/unconsumed",
              contentType: "text/html",
              body: Buffer.from(body),
              decompressedBytes: body.length,
              sha256: "fixture-sha",
            };
          },
        },
      },
    });
    const ledger = runtime.tracePool.ledgerFor("request-2");
    const heldToken = ledger.reserve({ name: "held", version: 1 }, "none");
    const fetchUrl = runtime.registry.resolve({ name: "fetch_url", version: 1 });
    await fetchUrl.execute(
      { url: "https://example.com/unconsumed" },
      retrievalContext("request-2"),
      new AbortController().signal,
      () => undefined,
    );
    expect(store.size()).toBe(1);

    expect(runtime.releaseTrace("request-2")).toBe(false);
    expect(store.size()).toBe(1);
    ledger.complete(heldToken);
    expect(runtime.releaseTrace("request-2")).toBe(true);
    expect(store.size()).toBe(0);
  });
});

describe("trace budget pool lifecycle (focused revision)", () => {
  it("refuses a new trace when at capacity with no releasable entry", () => {
    const pool = new TraceBudgetPool({ limits: { maxCalls: 12 }, maxTraces: 1, clock: () => 0 });
    const first = pool.ledgerFor("a");
    first.reserve({ name: "echo", version: 1 }, "none");
    expect(pool.size()).toBe(1);
    expect(() => pool.ledgerFor("b")).toThrow(/max traces/);
    expect(pool.size()).toBe(1);
    expect(pool.has("a")).toBe(true);
  });

  it("keeps unreleased traces capped and only resets after releaseTrace", () => {
    const pool = new TraceBudgetPool({ limits: { maxCalls: 2 }, maxTraces: 64, clock: () => 0 });
    const identity = { name: "echo", version: 1 };
    const a = pool.ledgerFor("a");
    const firstToken = a.reserve(identity, "none");
    const secondToken = a.reserve(identity, "none");
    a.complete(firstToken);
    a.complete(secondToken);
    expect(() => a.reserve(identity, "none")).toThrow(/max calls/);
    pool.ledgerFor("b");
    pool.ledgerFor("c");
    expect(pool.has("a")).toBe(true);
    expect(() => pool.ledgerFor("a").reserve(identity, "none")).toThrow(/max calls/);
    expect(pool.releaseTrace("a")).toBe(true);
    expect(pool.has("a")).toBe(false);
    expect(() => pool.ledgerFor("a").reserve(identity, "none")).not.toThrow();
  });

  it("refuses releaseTrace while the trace has in-flight tokens", () => {
    const pool = new TraceBudgetPool({ limits: {}, maxTraces: 4, clock: () => 0 });
    const a = pool.ledgerFor("a");
    a.reserve({ name: "echo", version: 1 }, "none");
    expect(pool.releaseTrace("a")).toBe(false);
    expect(pool.has("a")).toBe(true);
    expect(pool.size()).toBeLessThanOrEqual(4);
  });
});
