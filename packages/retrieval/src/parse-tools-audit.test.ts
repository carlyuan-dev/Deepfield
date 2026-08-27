import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FakeAuditSink,
  FakeRetryClock,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import type { ToolExecutionEvent } from "@deepfield/contracts";
import { ResourceStore } from "./resource-store.js";
import { createParseHtmlDefinition } from "./html-tool.js";
import { createParsePdfDefinition } from "./pdf-tool.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "retrieval");

const toolSet = new ToolSet([
  { identity: { name: "parse_html", version: 1 }, actor: "main_agent", effect: "project.read" },
  { identity: { name: "parse_pdf", version: 1 }, actor: "main_agent", effect: "project.read" },
]);

const FP = toolSet.fingerprint();

function scope() {
  return { traceId: "audit-trace", toolSetFingerprint: FP };
}

function setup(store: ResourceStore) {
  const clock = new FakeRetryClock();
  const registry = new ToolRegistry();
  registry.register(createParseHtmlDefinition({ store }));
  registry.register(createParsePdfDefinition({ store }));
  registry.freeze();
  const audit = new FakeAuditSink();
  const runner = new ToolRunner({
    registry,
    policy: new ToolPolicy(),
    budget: new ToolBudgetLedger({}, () => clock.now()),
    audit,
    clock,
  });
  const context = {
    traceId: "audit-trace",
    actor: "main_agent" as const,
    toolSet,
  };
  const events: ToolExecutionEvent[] = [];
  const signal = new AbortController().signal;
  return { runner, context, events, audit, signal };
}

function seed(store: ResourceStore, body: Buffer, contentType: string): string {
  const { id } = store.put(scope(), body, { finalUrl: "https://example.com/original", contentType, size: body.length, sha256: "abc" });
  return id;
}

/** Lifecycle events that never carry the executor output (the terminal completed event does). */
function nonTerminalEvents(events: ToolExecutionEvent[]): ToolExecutionEvent[] {
  return events.filter((event) => event.type !== "completed");
}

describe("parse tools runner/audit leak boundary (focused revision)", () => {
  it("html success: the result carries the visible marker but audit and lifecycle events never do", async () => {
    const store = new ResourceStore({ idFactory: () => "html-audit" });
    const id = seed(store, readFileSync(join(FIXTURES, "article-zh.html")), "text/html");
    const { runner, context, events, audit } = setup(store);
    const result = await runner.execute(
      { executionId: "e1", traceId: "audit-trace", tool: { name: "parse_html", version: 1 }, input: { resourceId: id } },
      context,
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("completed");
    // the bounded parsed text is legitimate agent output and MUST contain the marker
    const resultJson = JSON.stringify(result);
    expect(resultJson).toContain("MARKER_HTML_BODY_7f3a");
    // the audit records and non-output lifecycle events must be clean
    expect(JSON.stringify(audit.records)).not.toContain("MARKER_HTML_BODY_7f3a");
    expect(JSON.stringify(audit.records)).not.toContain("window.__STATE__");
    expect(JSON.stringify(nonTerminalEvents(events))).not.toContain("MARKER_HTML_BODY_7f3a");
    expect(JSON.stringify(nonTerminalEvents(events))).not.toContain("window.__STATE__");
    expect(store.get(id, scope())).toBeUndefined(); // consumed
  });

  it("html failure with a real marker-carrying resource: no marker/URL/raw cause anywhere", async () => {
    const store = new ResourceStore({ idFactory: () => "html-fail" });
    // a real seeded resource whose MIME is wrong for parse_html
    const body = Buffer.from("<html><body>MARKER_HTML_BODY_7f3a 失败资源</body></html>");
    const id = seed(store, body, "application/pdf");
    const { runner, context, events, audit } = setup(store);
    const result = await runner.execute(
      { executionId: "e2", traceId: "audit-trace", tool: { name: "parse_html", version: 1 }, input: { resourceId: id } },
      context,
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("failed");
    const all = JSON.stringify({ result, events, audit: audit.records });
    expect(all).not.toContain("MARKER_HTML_BODY_7f3a");
    expect(all).not.toContain("失败资源");
    expect(all).not.toContain("<html");
    expect(store.get(id, scope())).toBeUndefined(); // consumed even on failure
  });

  it("pdf success: audit and lifecycle events never contain source bytes or parsed text", async () => {
    const store = new ResourceStore({ idFactory: () => "pdf-audit" });
    const id = seed(store, readFileSync(join(FIXTURES, "report-two-pages.pdf")), "application/pdf");
    const { runner, context, events, audit } = setup(store);
    const result = await runner.execute(
      { executionId: "e3", traceId: "audit-trace", tool: { name: "parse_pdf", version: 1 }, input: { resourceId: id } },
      context,
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("completed");
    // the completed result legitimately contains the bounded parsed text
    const resultJson = JSON.stringify(result);
    expect(resultJson).toContain("Report: Page One");
    // audit and non-output events never do
    expect(JSON.stringify(audit.records)).not.toContain("Report: Page One");
    expect(JSON.stringify(audit.records)).not.toContain("4EBA5F62");
    expect(JSON.stringify(audit.records)).not.toContain("startxref");
    expect(JSON.stringify(nonTerminalEvents(events))).not.toContain("Report: Page One");
    expect(JSON.stringify(nonTerminalEvents(events))).not.toContain("startxref");
    expect(store.get(id, scope())).toBeUndefined(); // consumed
  });

  it("pdf failure: result, events and audit carry no PDF bytes, marker or parser exception", async () => {
    const store = new ResourceStore({ idFactory: () => "pdf-fail" });
    const id = seed(store, readFileSync(join(FIXTURES, "report-damaged.pdf")), "application/pdf");
    const { runner, context, events, audit } = setup(store);
    const result = await runner.execute(
      { executionId: "e4", traceId: "audit-trace", tool: { name: "parse_pdf", version: 1 }, input: { resourceId: id } },
      context,
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("failed");
    const all = JSON.stringify({ result, events, audit: audit.records });
    expect(all).not.toContain("%PDF");
    expect(all).not.toContain("InvalidPDFException");
    expect(all).not.toContain("startxref");
    expect(store.get(id, scope())).toBeUndefined(); // consumed even on failure
  });
});
