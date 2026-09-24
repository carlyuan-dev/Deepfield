import { describe, expect, it } from "vitest";
import { FakeAuditSink, FakeRetryClock, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import { ToolBudgetLedger } from "@deepfield/tool-platform";
import { ResourceStore } from "@deepfield/retrieval";
import { chatToolDirectory, createToolRuntime, TraceBudgetPool } from "./tool-runtime.js";

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
  it("lists granted registered tools with definition-owned user copy", () => {
    const withoutProbe = chatToolDirectory(makeRuntime(false), false);
    const withProbe = chatToolDirectory(makeRuntime(true), false);
    expect(withoutProbe.some(tool => tool.name === "回显探针")).toBe(false);
    expect(withProbe).toEqual(expect.arrayContaining([{ name: "回显探针", description: "回显输入文本" }]));
    expect(withProbe).toEqual(expect.arrayContaining([{ name: "计算器", description: "计算基本算术表达式" }]));
    expect(chatToolDirectory(makeRuntime(false), false).some(tool => tool.name === "网页搜索")).toBe(false);
    expect(chatToolDirectory(makeRuntime(false), true).some(tool => tool.name === "网页搜索")).toBe(true);
  });
  it("gives each trace its provider query schema and rejects oversized model calls without budget use", async () => {
    const runtime = makeRuntime(false);
    let calls = 0;
    const search = async () => { calls++; return { provider: "test", results: [] }; };
    runtime.bindSearchProvider("doubao-trace", { id: "doubao", capabilities: { timeRange: true, maxQueryLength: 100 }, search });
    runtime.bindSearchProvider("other-trace", { id: "other", capabilities: { timeRange: true }, search });
    const getSearch = (traceId: string) => runtime.createAgentTools({ traceId, actor: "main_agent", networkEnabled: true }).find((tool) => tool.name === "web_search")!;
    const limited = getSearch("doubao-trace");
    expect(limited.parameters.properties.query.maxLength).toBe(100);
    expect(limited.description).toContain("100");
    expect(getSearch("other-trace").parameters.properties.query.maxLength).toBe(512);
    await expect(limited.execute("call-1", { query: "字".repeat(101) }, new AbortController().signal)).rejects.toThrow(/invalid_input/);
    expect(calls).toBe(0);
    expect(runtime.budgetSnapshot("doubao-trace").categories.search.consumed).toBe(0);
    await limited.execute("call-2", { query: "😀".repeat(100) }, new AbortController().signal);
    expect(calls).toBe(1);
  });
  it("constructs without duplicate grants and freezes the registry", () => {
    const runtime = makeRuntime();
    expect(runtime.registry.list()).toHaveLength(11);
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
      "read_webpage",
      "check_link_accessibility",
      "web_search",
    ]);
    expect(runtime.registry.manifest().some((entry) => entry.identity.name === "echo_probe")).toBe(
      false,
    );
  });

  it("binds web_search to one trace and releases it with that trace", () => {
    const runtime = makeRuntime(false);
    const provider = { id: "test", capabilities: { timeRange: false }, search: async () => ({ provider: "test", results: [] }) };
    runtime.bindSearchProvider("search-trace", provider, { maxCalls: 2, categoryCalls: { search: 1, fetch: 1 } });
    expect(runtime.searchSessions.get("search-trace")).toBe(provider);
    expect(runtime.createAgentTools({ traceId: "search-trace", actor: "main_agent", networkEnabled: true }).map((tool) => tool.name)).toContain("web_search");
    expect(runtime.releaseTrace("search-trace")).toBe(true);
    expect(runtime.searchSessions.has("search-trace")).toBe(false);
  });

  it("exposes the authoritative per-trace ledger snapshot", () => {
    const runtime = makeRuntime(false);
    const provider = { id: "test", capabilities: { timeRange: false }, search: async () => ({ provider: "test", results: [] }) };
    runtime.bindSearchProvider("budget-trace", provider, {
      maxCalls: 7,
      categoryCalls: { search: 4, fetch: 3 },
    });

    expect(runtime.budgetSnapshot("budget-trace").categories.search).toEqual({
      limit: 4,
      reserved: 0,
      consumed: 0,
      remaining: 4,
      exhausted: false,
    });
  });

  it("exposes search and composed webpage reading only to a web-enabled agent", () => {
    const runtime = makeRuntime(false);
    const provider = { id: "test", capabilities: { timeRange: false }, search: async () => ({ provider: "test", results: [] }) };
    runtime.bindSearchProvider("web-trace", provider);

    const online = runtime.createAgentTools({
      traceId: "web-trace",
      actor: "main_agent",
      networkEnabled: true,
    }).map((tool) => tool.name);
    const offline = runtime.createAgentTools({
      traceId: "offline-trace",
      actor: "main_agent",
      networkEnabled: false,
    }).map((tool) => tool.name);

    expect(online).toEqual(expect.arrayContaining(["web_search", "read_webpage"]));
    expect(online).not.toContain("fetch_url");
    expect(offline).not.toContain("web_search");
    expect(offline).not.toContain("read_webpage");
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

  it("records synthetic terminal activity without entering the runner pipeline", async () => {
    const audit = new FakeAuditSink();
    const runtime = createToolRuntime({ audit });
    await runtime.recordSynthetic({
      executionId: "skip-1",
      traceId: "req-1",
      actor: "main_agent",
      tool: { name: "web_search", version: 1 },
      status: "skipped",
      errorCode: "budget_trimmed",
      agentTurnIndex: 2,
      batchId: "batch-2",
      toolCallId: "call-5",
      attempts: 0,
      budgetConsumed: false,
    });
    expect(audit.records).toEqual([
      {
        kind: "synthetic",
        record: expect.objectContaining({
          executionId: "skip-1",
          status: "skipped",
          attempts: 0,
          budgetConsumed: false,
        }),
      },
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
