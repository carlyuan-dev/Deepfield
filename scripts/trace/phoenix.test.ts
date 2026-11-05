import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localEndpoint, sendPhoenix, spanId, toPhoenix, traceId } from "./phoenix.ts";
import type { exportTrace } from "./export.ts";
import type { TraceContentRecord } from "../../packages/base/src/trace/content.ts";
import { readPhoenixContent } from "./phoenix-content.ts";

function fixture() {
  const event = (id: string, type: string, parent?: string) => ({ version: 1, eventId: `${id}-${type}`, rootTraceId: "root", spanId: id,
    processSessionId: "session", sequence: 1, requestId: "request", time: type === "span.end" ? "2026-10-21T00:00:01.000Z" : "2026-10-21T00:00:00.000Z",
    type, kind: id === "root" ? "request" : "model", ...(parent ? { parentSpanId: parent } : {}), ...(type === "span.end" ? { status: "succeeded" } : {}) });
  const events = [event("root", "span.start"), event("root", "span.end"), event("model", "span.start", "root"), event("model", "span.end", "root"),
    { ...event("model", "usage.link"), usageAttemptId: "attempt", serviceKind: "llm" },
    { ...event("model", "span.link"), links: [{ rootTraceId: "other", spanId: "upstream" }] }];
  return { rootTraceId: "root", events, spans: ["root", "model"].map(id => ({ spanId: id, kind: id === "root" ? "request" : "model", status: "succeeded", start: events.find(e => e.spanId === id && e.type === "span.start"), end: events.find(e => e.spanId === id && e.type === "span.end") })),
    related: [], coverage: { status: "observed" }, associations: { status: "observed" }, usage: { status: "available", attempts: [
      { attemptId: "attempt", status: "available", serviceKind: "llm", inputTokens: 10, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null }] } } as unknown as ReturnType<typeof exportTrace>;
}
afterEach(() => vi.unstubAllGlobals());
describe("Phoenix metadata adapter", () => {
  it("reads only the selected root without retention writes or creating a missing database", () => {
    const dir = mkdtempSync(join(tmpdir(), "phoenix-content-test-"));
    const file = join(dir, "content.sqlite"); const db = new DatabaseSync(file);
    db.exec("CREATE TABLE content(id TEXT,root_id TEXT,captured_at INTEGER,payload TEXT);PRAGMA user_version=1");
    db.prepare("INSERT INTO content VALUES(?,?,?,?)").run("content-1", "root", 0, JSON.stringify(contentRecord()));
    db.prepare("INSERT INTO content VALUES(?,?,?,?)").run("bad-other", "other", 0, "malformed unrelated payload"); db.close();
    const before = readFileSync(file);
    expect(readPhoenixContent(file, "root")).toHaveLength(1);
    expect(readFileSync(file)).toEqual(before);
    const missing = join(dir, "missing.sqlite"); expect(() => readPhoenixContent(missing, "root")).toThrow("phoenix_content_read_failed");
    expect(existsSync(missing)).toBe(false);
  });
  it("rejects row identity spoofing and duplicate content IDs", () => {
    const record = contentRecord();
    expect(() => toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [record, record] })).toThrow();
    expect(() => toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [{ ...record, rootTraceId: "other" }] })).toThrow();
  });
  it("removes reasoning serialized inside JSON strings rather than exporting it through a tool payload", () => {
    const record = contentRecord({ content: [{ type: "text", text: JSON.stringify({ thinking: "embedded-chain-sentinel", answer: "public answer" }) }] });
    const text = JSON.stringify(toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [record] }));
    expect(text).not.toContain("embedded-chain-sentinel"); expect(text).toContain("public answer");
  });
  it("requires explicit content authorization and uses a separate project", () => {
    const record = contentRecord();
    expect(JSON.stringify(toPhoenix(fixture()))).not.toContain("public answer");
    expect(() => toPhoenix(fixture(), "deepfield-local", { rootTraceId: "root", authorized: false, records: [record] })).toThrow();
    expect(() => toPhoenix(fixture(), "deepfield-local", { rootTraceId: "root", authorized: true, records: [record] })).toThrow();
    const out = toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [record] });
    expect(JSON.stringify(out.body)).toContain("public answer");
    expect(JSON.stringify(out.manifest)).not.toContain("public answer");
  });
  it("projects text but excludes thinking blocks, signatures and credential fields", () => {
    const record = contentRecord({ content: [{ type: "thinking", thinking: "private-chain-sentinel" }, { type: "text", text: "public answer", signature: "signature-sentinel" }], reasoning_content: "private-chain-sentinel", api_key: "credential-sentinel" });
    const out = toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [record] });
    const text = JSON.stringify(out);
    expect(text).toContain("public answer");
    for (const secret of ["private-chain-sentinel", "signature-sentinel", "credential-sentinel"]) expect(text).not.toContain(secret);
    expect(text).toContain("projected");
  });
  it("does not attach content to a different request or a related unselected root", () => {
    const wrong = { ...contentRecord(), requestId: "other" };
    const out = toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [wrong] });
    expect(JSON.stringify(out.body)).not.toContain("public answer");
    expect(out.manifest.content?.unmatched).toBe(1);
    expect(() => toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "other", authorized: true, records: [contentRecord()] })).toThrow();
  });
  it("keeps unavailable and truncated status without exporting an unsafe truncated prefix", () => {
    const body = '{"thinking":"partial-private';
    const record = { ...contentRecord(body), completeness: "truncated" as const, reasonCode: "size_limit" as const };
    const out = toPhoenix(fixture(), "deepfield-content-public", { rootTraceId: "root", authorized: true, records: [record] });
    const text = JSON.stringify(out.body);
    expect(text).not.toContain("partial-private");
    expect(text).toContain("size_limit"); expect(text).toContain("truncated");
    expect(text).toContain("projection_unavailable");
  });
  it("keeps deterministic parent/link IDs and attributes each attempt once without zero-filling unknown tokens", () => {
    const out = toPhoenix(fixture());
    const [root, model] = out.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(root!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(model!.parentSpanId).toBe(root!.spanId);
    expect(model!.links).toEqual([{ traceId: traceId("other"), spanId: spanId("other", "upstream") }]);
    expect(root!.attributes.some(a => a.key === "llm.token_count.prompt")).toBe(false);
    expect(model!.attributes.find(a => a.key === "llm.token_count.prompt")!.value).toEqual({ intValue: "10" });
    expect(model!.attributes.some(a => a.key === "llm.token_count.completion")).toBe(false);
    expect(JSON.stringify(out)).toContain('\\"outputTokens\\":null');
  });
  it("omits spans without genuine endings and marks their usage unattributed", () => {
    const input = fixture(); input.spans[1]!.end = null;
    const out = toPhoenix(input);
    expect(out.manifest.spanCount).toBe(1);
    expect(out.manifest.omitted[0]!.reason).toBe("missing_end");
    expect(out.manifest.coverage).toBe("partial");
    expect(out.manifest.attribution[0]!.status).toBe("unattributed");
  });
  it("does not choose between ambiguous model links", () => {
    const input = fixture();
    input.spans.push({ ...input.spans[1]!, spanId: "second" });
    input.events.push({ ...input.events[4]!, spanId: "second" });
    const out = toPhoenix(input);
    expect(out.manifest.attribution[0]!.status).toBe("unattributed");
    expect(JSON.stringify(out.body)).not.toContain("llm.token_count.prompt");
  });
  it("preserves the fixed terminal error code when usage evidence is missing", () => {
    const input = fixture();
    const model = input.spans[1]!;
    model.status = "failed";
    model.end = { ...model.end!, type: "span.end", status: "failed", errorCode: "transport_failed" } as typeof model.end;
    input.usage = { status: "partial", attempts: [{ attemptId: "attempt", status: "missing" }] };
    const output = toPhoenix(input).body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const projected = output.find(span => span.name === "deepfield.model")!;
    expect(projected.status.code).toBe(2);
    expect(projected.attributes).toContainEqual({ key: "deepfield.error_code", value: { stringValue: "transport_failed" } });
    expect(JSON.stringify(projected)).not.toContain("llm.token_count");
  });
  it("restricts origins to literal loopback and rejects credentials, paths and URL tricks", () => {
    expect(localEndpoint("http://localhost:6006")).toBe("http://127.0.0.1:6006/v1/traces");
    for (const url of ["https://localhost:6006", "http://127.1:6006", "http://remote.test", "http://user@localhost", "http://localhost/path", "http://localhost?next=remote", "http://localhost.evil"]) expect(() => localEndpoint(url)).toThrow();
  });
  it("reserves spans before sending and blocks duplicate and overlapping batches after acceptance", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null)); vi.stubGlobal("fetch", fetcher);
    const ledger = join(mkdtempSync(join(tmpdir(), "phoenix-test-")), "ledger.sqlite");
    const out = toPhoenix(fixture());
    await sendPhoenix(out, "http://localhost:6006", ledger);
    await expect(sendPhoenix(out, "http://127.0.0.1:6006", ledger)).rejects.toThrow("duplicate_or_unresolved");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].redirect).toBe("error");
  });
  it("does not resend after an uncertain network failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("timeout")); vi.stubGlobal("fetch", fetcher);
    const ledger = join(mkdtempSync(join(tmpdir(), "phoenix-test-")), "ledger.sqlite");
    const out = toPhoenix(fixture());
    await expect(sendPhoenix(out, "http://localhost:6006", ledger)).rejects.toThrow("timeout");
    await expect(sendPhoenix(out, "http://localhost:6006", ledger)).rejects.toThrow("duplicate_or_unresolved");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("permits only an explicitly reviewed same-payload pending recovery and retains its history", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Response(null)); vi.stubGlobal("fetch", fetcher);
    const ledger = join(mkdtempSync(join(tmpdir(), "phoenix-recovery-test-")), "ledger.sqlite"); const out = toPhoenix(fixture());
    await expect(sendPhoenix(out, "http://127.0.0.1:6006", ledger)).rejects.toThrow();
    await expect(sendPhoenix(out, "http://127.0.0.1:6006", ledger, false, "wrong-hash")).rejects.toThrow();
    await sendPhoenix(out, "http://127.0.0.1:6006", ledger, false, out.manifest.hash);
    await expect(sendPhoenix(out, "http://127.0.0.1:6006", ledger, false, out.manifest.hash)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const db = new DatabaseSync(ledger, { readOnly: true });
    expect(db.prepare("SELECT count(*) n FROM imports").get()!.n).toBe(2);
    expect(db.prepare("SELECT count(*) n FROM import_history WHERE state='reviewed_retry_unreceived'").get()!.n).toBe(1); db.close();
  });
  it("requires explicit retry for a proven 415 rejection and retains all other reservations", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 415 })).mockResolvedValueOnce(new Response(null));
    vi.stubGlobal("fetch", fetcher);
    const ledger = join(mkdtempSync(join(tmpdir(), "phoenix-test-")), "ledger.sqlite");
    const out = toPhoenix(fixture());
    await expect(sendPhoenix(out, "http://localhost:6006", ledger)).rejects.toThrow("http_415");
    await expect(sendPhoenix(out, "http://localhost:6006", ledger)).rejects.toThrow("duplicate_or_unresolved");
    await sendPhoenix(out, "http://localhost:6006", ledger, true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1].headers["Content-Type"]).toBe("application/x-protobuf");
  });
});

function contentRecord(body: TraceContentRecord["body"] = { content: [{ type: "text", text: "public answer" }], stopReason: "stop" }): TraceContentRecord {
  return { version: 1, contentId: "content-1", rootTraceId: "root", spanId: "model", requestId: "request", kind: "model.response", source: "pi.assistant_message", capturedAt: "2026-10-21T00:00:01.000Z", captureMode: "benchmark", completeness: "complete", redacted: false, body, byteLength: Buffer.byteLength(JSON.stringify(body)), reasonCode: "none" };
}
