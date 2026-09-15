import { describe, expect, it } from "vitest";
import {
  FakeAuditSink,
  FakeRetryClock,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import { ResourceStore } from "./resource-store.js";
import { SafeHttpTransport, TransportError } from "./http-transport.js";
import { UrlPolicy } from "./url-policy.js";
import {
  MAX_READ_WEBPAGE_TEXT_CHARS,
  createReadWebpageDefinition,
} from "./read-webpage-tool.js";

function context() {
  const actor = "main_agent" as const;
  return {
    traceId: "trace-1",
    actor,
    toolSet: new ToolSet([
      {
        identity: { name: "read_webpage", version: 1 },
        actor,
        effect: "network.read.public" as const,
      },
    ]),
  };
}

describe("read_webpage tool", () => {
  it("returns bounded readable text from one safe HTML fetch", async () => {
    const store = new ResourceStore({ idFactory: () => "resource-1" });
    const longText = "宇树科技发布人形机器人进展。".repeat(2000);
    const body = Buffer.from(`<html><head><title>官方进展</title></head><body><main><p>${longText}</p></main></body></html>`);
    const definition = createReadWebpageDefinition({
      store,
      transport: {
        async fetch() {
          return {
            statusCode: 200,
            finalUrl: "https://example.com/news",
            contentType: "text/html",
            body: Buffer.from(body),
            decompressedBytes: body.length,
            sha256: "fixture-sha",
          };
        },
      },
    });

    const output = await definition.execute(
      { url: "https://example.com/news" },
      context(),
      new AbortController().signal,
      () => undefined,
    );

    expect(output.title).toBe("官方进展");
    expect(output.url).toBe("https://example.com/news");
    expect(output.text).toContain("宇树科技发布人形机器人进展");
    expect(output.text.length).toBeLessThanOrEqual(MAX_READ_WEBPAGE_TEXT_CHARS);
    expect(output.truncated).toBe(true);
    expect(store.size()).toBe(0);
  });

  it("preserves a safe timeout classification", async () => {
    const definition = createReadWebpageDefinition({
      store: new ResourceStore(),
      transport: { async fetch() { throw new TransportError("timeout"); } },
    });

    await expect(
      definition.execute(
        { url: "https://example.com/slow" },
        context(),
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not consume fetch quota when URL policy blocks before transport dispatch", async () => {
    let adapterCalls = 0;
    const definition = createReadWebpageDefinition({
      store: new ResourceStore(),
      transport: new SafeHttpTransport({
        policy: new UrlPolicy(),
        adapter: {
          async request() {
            adapterCalls += 1;
            throw new Error("transport must not run");
          },
        },
        maxBodyBytes: 1024,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(definition);
    registry.freeze();
    const clock = new FakeRetryClock();
    const audit = new FakeAuditSink();
    const budget = new ToolBudgetLedger(
      { maxCalls: 1, categoryCalls: { fetch: 1 } },
      () => clock.now(),
    );
    const runner = new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget,
      audit,
      clock,
    });

    const result = await runner.execute(
      {
        executionId: "blocked-read",
        traceId: "trace-blocked-read",
        tool: { name: "read_webpage", version: 1 },
        input: { url: "http://127.0.0.1" },
      },
      {
        traceId: "trace-blocked-read",
        actor: "main_agent",
        toolSet: context().toolSet,
      },
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toMatchObject({
      status: "failed",
      budgetConsumed: false,
      failure: { code: "url_blocked" },
    });
    expect(adapterCalls).toBe(0);
    expect(budget.snapshot().categories.fetch).toMatchObject({ consumed: 0, remaining: 1 });
    expect(audit.records.filter((record) => record.kind === "finish")).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          executionId: "blocked-read",
          status: "failed",
          budgetConsumed: false,
        }),
      }),
    ]);
  });
});
