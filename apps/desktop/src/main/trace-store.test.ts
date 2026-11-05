import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openTraceStore } from "./trace-store.js";
import { exportTrace, listTraces } from "../../../../scripts/trace/export.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.reverse()) cleanup(); cleanups.length = 0; });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "deepfield-trace-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "trace.sqlite") };
}
let sequence = 0;
function event(rootTraceId: string, spanId: string, type: "span.start" | "span.end" = "span.start", time = "2026-09-01T00:00:00.000Z") {
  return { version: 1, eventId: `e-${++sequence}`, rootTraceId, spanId, type, kind: "request", requestId: `request-${rootTraceId}`, processSessionId: "session-1", sequence, time, ...(type === "span.end" ? { status: "succeeded" } : {}) };
}
describe("independent Trace SQLite and export", () => {
  it("keeps terminal results immutable, protects active roots and marks restart leftovers interrupted", () => {
    const { path } = fixture();
    let store = openTraceStore(path, { now: () => Date.parse("2026-10-21T00:00:00.000Z") });
    const end = event("done", "root", "span.end", "2026-10-21T00:00:00.000Z");
    expect(store.record(end)).toBe(true); expect(store.record(end)).toBe(true);
    store.record(event("done", "root"));
    store.record({ ...event("done", "root", "span.end"), status: "failed" });
    store.record(event("active", "root"));
    store.record(event("expired", "root")); store.record(event("expired", "root", "span.end"));
    store.cleanup();
    expect(store.query("done").spans[0]?.status).toBe("succeeded");
    expect(store.query("done").events).toHaveLength(2);
    expect(store.query("active").spans[0]?.status).toBe("unknown");
    expect(store.query("expired").coverage.status).toBe("missing");
    store.close();
    store = openTraceStore(path); cleanups.push(() => store.close());
    expect(store.query("active").spans[0]?.status).toBe("interrupted");
    store.cleanup();
    expect(store.query("active").coverage.status).toBe("missing");
  });
  it("accounts for SQLite sidecars, reclaims terminal traces and stops before evicting active traces", () => {
    const { path } = fixture(); const limit = 512 * 1024;
    let now = Date.now();
    const store = openTraceStore(path, { maxBytes: limit, now: () => now }); cleanups.push(() => store.close());
    store.record(event("active", "root", "span.start", new Date(now).toISOString()));
    store.record(event("still-active", "root", "span.start", new Date(now).toISOString()));
    let accepted = 0;
    for (let i = 0; i < 2000; i++) if (store.record({ ...event("active", `child-${i}`, "span.start", new Date().toISOString()), parentSpanId: "root", kind: "tool" })) accepted++;
    expect(accepted).toBeGreaterThan(0); expect(accepted).toBeLessThan(2000);
    expect(store.health().capacityStopped).toBe(true);
    expect(store.health().bytes).toBeLessThanOrEqual(limit);
    expect(store.query("active").events).toHaveLength(accepted + 1);
    store.cleanup();
    expect(store.health().bytes).toBeLessThanOrEqual(limit);
    for (let i = 0; i < accepted; i++) store.record({ ...event("active", `child-${i}`, "span.end", new Date(now).toISOString()), kind: "tool" });
    store.record(event("active", "root", "span.end", new Date(now).toISOString()));
    expect(store.query("active").coverage.status).toBe("partial");
    expect(store.query("active").spans.every(span => span.status !== "succeeded")).toBe(true);
    now += 31 * 86400_000;
    expect(store.record(event("new", "root", "span.start", new Date(now).toISOString()))).toBe(true);
    expect(store.query("active").coverage.status).toBe("missing");
    expect(store.query("still-active").spans[0]?.status).toBe("unknown");
    expect(store.health().bytes).toBeLessThanOrEqual(limit);
  });
  it("exports unique Usage references without initializing missing databases or leaking raw fields", () => {
    const { path, dir } = fixture(); const store = openTraceStore(path); cleanups.push(() => store.close());
    store.record(event("root", "span", "span.start", new Date().toISOString()));
    const base = event("root", "span", "span.start", new Date().toISOString());
    const { kind: _kind, ...link } = base;
    for (let i = 0; i < 2; i++) store.record({ ...link, eventId: `usage-${i}`, type: "usage.link", usageAttemptId: "attempt-1", serviceKind: "llm" });
    expect(store.record({ ...base, eventId: "bad", prompt: "SECRET_SENTINEL" })).toBe(false);
    const missingPath = join(dir, "missing.sqlite");
    const exported = exportTrace(path, "root", missingPath);
    expect(listTraces(path)).toMatchObject([{ rootTraceId: "root", requestId: "request-root", status: "unknown" }]);
    expect(existsSync(missingPath)).toBe(false);
    expect(exported.usage.attempts).toEqual([{ attemptId: "attempt-1", status: "missing" }]);
    expect(JSON.stringify(exported)).not.toContain("SECRET_SENTINEL");
    expect(readFileSync(path).includes(Buffer.from("SECRET_SENTINEL"))).toBe(false);
    const broken = new DatabaseSync(join(dir, "unsupported.sqlite")); broken.exec("PRAGMA user_version=99"); broken.close();
    expect(() => openTraceStore(join(dir, "unsupported.sqlite"))).toThrow("unsupported_trace_version");
    expect(() => exportTrace(missingPath, "root")).toThrow();
    expect(existsSync(missingPath)).toBe(false);
  });
});
