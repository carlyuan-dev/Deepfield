import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceStore } from "./trace-store.js";
import { exportTrace } from "../../../../scripts/trace/export.ts";

it("looks up exact package-owned references and reports union execution separately from human and queue waits", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-async-")); const store = openTraceStore(join(dir, "trace.sqlite")); let sequence = 0;
  const record = (spanId: string, kind: string, type: string, ms: number, extra = {}) => store.record({ version: 1, eventId: `e${++sequence}`, processSessionId: "p", sequence, rootTraceId: "root", spanId, kind, type, requestId: "req", time: new Date(Date.now() + ms).toISOString(), ...extra });
  try {
    record("root", "request", "span.start", 0);
    record("wait", "interaction", "span.start", 0); record("wait", "interaction", "span.state", 0, { status: "waiting" }); record("wait", "interaction", "span.end", 100, { status: "succeeded" });
    record("task", "task", "span.start", 0, { capabilityId: "one", taskId: "task" }); record("task", "task", "span.state", 0, { status: "queued" }); record("task", "task", "span.state", 50, { status: "running" }); record("task", "task", "span.end", 250, { status: "succeeded" });
    record("m1", "model", "span.start", 100); record("m1", "model", "span.end", 200, { status: "succeeded" });
    record("m2", "model", "span.start", 150); record("m2", "model", "span.end", 250, { status: "succeeded" }); record("root", "request", "span.end", 250, { status: "succeeded" });
    const timeline = store.query("root") as any;
    expect(timeline.timing.executionMs).toBeGreaterThanOrEqual(150); expect(timeline.timing.executionMs).toBeLessThan(155);
    expect(timeline.timing.humanWaitMs).toBeGreaterThanOrEqual(100); expect(timeline.timing.queueWaitMs).toBeGreaterThanOrEqual(50);
    expect((store as any).find({ kind: "task", id: "task", capabilityId: "one" })).toMatchObject({ rootTraceId: "root", spanId: "task" });
    expect((store as any).find({ kind: "task", id: "task", capabilityId: "other" })).toBeUndefined();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("expires closed UI task roots but protects active descendants, and bounds cyclic linked exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-graph-")); let now = Date.now();
  const path = join(dir, "trace.sqlite"); const store = openTraceStore(path, { now: () => now }); let sequence = 0;
  const record = (root: string, span: string, type: string, extra = {}) => store.record({ version: 1, eventId: `graph-${++sequence}`, processSessionId: "graph", sequence,
    rootTraceId: root, spanId: span, type, requestId: root, time: new Date(now).toISOString(), ...extra });
  try {
    record("ui", "task", "span.start", { kind: "task" }); record("ui", "task", "span.end", { kind: "task", status: "succeeded" });
    expect(store.query("ui").coverage.status).toBe("observed");
    record("active", "parent", "span.start", { kind: "task" }); record("active", "parent", "span.end", { kind: "task", status: "accepted" });
    record("active", "child", "span.start", { kind: "stage", parentSpanId: "parent" });
    record("ui", "task", "span.link", { links: [{ rootTraceId: "active", spanId: "child" }, { rootTraceId: "missing", spanId: "gone" }] });
    record("active", "child", "span.link", { links: [{ rootTraceId: "ui", spanId: "task" }] });
    const exported = exportTrace(path, "ui");
    expect(exported.related.map(item => item.rootTraceId).sort()).toEqual(["active", "missing"]);
    expect(exported.associations).toMatchObject({ status: "partial", missingRoots: ["missing"], truncated: false });
    now += 31 * 86400_000;
    record("new", "request", "span.start", { kind: "request" });
    expect(store.query("ui").events).toHaveLength(0);
    expect(store.query("active").spans.find(span => span.spanId === "child")?.status).toBe("unknown");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
