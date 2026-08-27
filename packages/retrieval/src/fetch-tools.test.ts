import { describe, expect, it } from "vitest";
import {
  FakeAuditSink,
  FakeRetryClock,
  ToolBudgetLedger,
  ToolExecutionError,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import { createFetchUrlDefinition, createFetchPdfDefinition, MAX_HTML_BYTES } from "./fetch-tools.js";
import { ResourceStore } from "./resource-store.js";
import { htmlResponse, makeTransport, pdfResponse, scriptedAdapter } from "./transport-test-helpers.js";

const BODY_MARKER = "UNIQUE-HTML-BODY-MARKER-7f3a";
const PDF_MARKER = "UNIQUE-PDF-BODY-MARKER-9c1b";

const toolSet = new ToolSet([
  { identity: { name: "fetch_url", version: 1 }, actor: "main_agent", effect: "network.read.public" },
  { identity: { name: "fetch_pdf", version: 1 }, actor: "main_agent", effect: "network.read.public" },
]);

function makeContext(traceId = "trace-1", projectId?: string) {
  return {
    traceId,
    actor: "main_agent" as const,
    ...(projectId !== undefined ? { projectId } : {}),
    toolSet,
  };
}

async function runFetch(
  definition: ReturnType<typeof createFetchUrlDefinition>,
  url: string,
  options: { traceId?: string; signal?: AbortSignal; store?: ResourceStore } = {},
) {
  const store = options.store ?? new ResourceStore();
  const transport = makeTransport(
    scriptedAdapter([() => htmlResponse(`<html>${BODY_MARKER}</html>`, { "content-type": "text/html" })]),
  );
  return definition.execute(
    { url },
    makeContext(options.traceId),
    options.signal ?? new AbortController().signal,
    () => {},
  );
}

describe("fetch_url definition", () => {
  it("returns metadata only and stores the body in the trace resource store", async () => {
    const store = new ResourceStore();
    const adapter = scriptedAdapter([() => htmlResponse(`<html>${BODY_MARKER}</html>`)]);
    const transport = makeTransport(adapter);
    const definition = createFetchUrlDefinition({ transport, store });
    const result = await definition.execute(
      { url: "https://example.com/page" },
      makeContext("trace-1"),
      new AbortController().signal,
      () => {},
    );
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("resourceId");
    expect(serialized).not.toContain(BODY_MARKER);
    expect(result.contentType).toBe("text/html");
    expect(result.size).toBe(Buffer.byteLength(`<html>${BODY_MARKER}</html>`));
    // the body is only reachable through the store scope
    const body = store.get(result.resourceId, {
      traceId: "trace-1",
      toolSetFingerprint: toolSet.fingerprint(),
    });
    expect(body?.toString()).toContain(BODY_MARKER);
    expect(
      store.get(result.resourceId, {
        traceId: "trace-2",
        toolSetFingerprint: toolSet.fingerprint(),
      }),
    ).toBeUndefined();
  });

  it("accepts application/xhtml+xml and rejects other types without leaving resources", async () => {
    const store = new ResourceStore();
    const xhtml = scriptedAdapter([
      () => htmlResponse("<html/>", { "content-type": "application/xhtml+xml" }),
    ]);
    const definition = createFetchUrlDefinition({ transport: makeTransport(xhtml), store });
    const xhtmlResult = await definition.execute(
      { url: "https://example.com/x" },
      makeContext(),
      new AbortController().signal,
      () => {},
    );
    expect(xhtmlResult.contentType).toBe("application/xhtml+xml");

    const pdf = scriptedAdapter([() => pdfResponse(`%PDF ${PDF_MARKER}`)]);
    const definition2 = createFetchUrlDefinition({ transport: makeTransport(pdf), store });
    await expect(
      definition2.execute({ url: "https://example.com/f.pdf" }, makeContext(), new AbortController().signal, () => {}),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(store.size()).toBe(1); // only the xhtml resource; the pdf never got stored
  });

  it("maps transport failures to stable tool codes", async () => {
    const store = new ResourceStore();
    const blocked = new (class {
      requests: never[] = [];
      async request() {
        throw new Error("ECONNREFUSED 127.0.0.1 secret");
      }
    })();
    const definition = createFetchUrlDefinition({ transport: makeTransport(blocked as never), store });
    await expect(
      definition.execute({ url: "https://example.com/" }, makeContext(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "network_unavailable" });
    expect(store.size()).toBe(0);
  });

  it("never leaves a resource when cancelled before the put", async () => {
    const store = new ResourceStore();
    const adapter = scriptedAdapter([() => htmlResponse(`<html>${BODY_MARKER}</html>`)]);
    const transport = makeTransport(adapter);
    const definition = createFetchUrlDefinition({ transport, store });
    const signal = new AbortController();
    signal.abort();
    await expect(
      definition.execute({ url: "https://example.com/" }, makeContext(), signal.signal, () => {}),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(store.size()).toBe(0);
  });

  it("cleans up when the store rejects a put (no orphans)", async () => {
    const store = new ResourceStore({ maxItemsPerTrace: 1 });
    const first = scriptedAdapter([() => htmlResponse("<html>first</html>")]);
    const definition = createFetchUrlDefinition({ transport: makeTransport(first), store });
    await definition.execute({ url: "https://example.com/1" }, makeContext(), new AbortController().signal, () => {});
    const second = scriptedAdapter([() => htmlResponse("<html>second</html>")]);
    const definition2 = createFetchUrlDefinition({ transport: makeTransport(second), store });
    await expect(
      definition2.execute({ url: "https://example.com/2" }, makeContext(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "executor_failed" });
    expect(store.size()).toBe(1); // only the first resource remains
  });

  it("keeps bodies out of tool events and audit records through the runner", async () => {
    const store = new ResourceStore();
    const adapter = scriptedAdapter([() => htmlResponse(`<html>${BODY_MARKER}</html>`)]);
    const transport = makeTransport(adapter, { maxBodyBytes: MAX_HTML_BYTES });
    const definition = createFetchUrlDefinition({ transport, store });
    const registry = new ToolRegistry();
    registry.register(definition);
    registry.freeze();
    const clock = new FakeRetryClock();
    const audit = new FakeAuditSink();
    const runner = new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget: new ToolBudgetLedger({}, () => clock.now()),
      audit,
      clock,
    });
    const events: unknown[] = [];
    const result = await runner.execute(
      { executionId: "e1", traceId: "t1", tool: { name: "fetch_url", version: 1 }, input: { url: "https://example.com/" } },
      makeContext("t1"),
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(result.status, JSON.stringify(result)).toBe("completed");
    const scan = JSON.stringify({ result, events, audit: audit.records });
    expect(scan).not.toContain(BODY_MARKER);
    expect(scan).not.toContain("secret");
  });
});

describe("fetch_pdf definition", () => {
  it("stores only application/pdf bodies", async () => {
    const store = new ResourceStore();
    const adapter = scriptedAdapter([() => pdfResponse(`%PDF-1.7 ${PDF_MARKER}`)]);
    const definition = createFetchPdfDefinition({ transport: makeTransport(adapter), store });
    const result = await definition.execute(
      { url: "https://example.com/f.pdf" },
      makeContext(),
      new AbortController().signal,
      () => {},
    );
    expect(JSON.stringify(result)).not.toContain(PDF_MARKER);
    expect(result.contentType).toBe("application/pdf");
    expect(store.size()).toBe(1);

    const html = scriptedAdapter([() => htmlResponse(`<html>${BODY_MARKER}</html>`)]);
    const definition2 = createFetchPdfDefinition({ transport: makeTransport(html), store });
    await expect(
      definition2.execute({ url: "https://example.com/f.html" }, makeContext(), new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
    expect(store.size()).toBe(1);
  });
});
