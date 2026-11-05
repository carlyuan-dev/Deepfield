import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTraceContentCollector } from "@deepfield/base/trace/runtime";
import { openTraceContentStore } from "./trace-content-store.js";

it("persists independently, enforces retention/capacity, and deletes complete roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-content-")); let now = Date.now();
  const store = openTraceContentStore(join(dir, "content.sqlite"), { now: () => now, retentionMs: 100 });
  try {
    const collector = createTraceContentCollector(v => store.record(v), { now: () => now });
    collector.authorize("req", "root", "benchmark");
    collector.capture({ requestId: "req", rootTraceId: "root", spanId: "span" }, { kind: "tool.input", source: "tool.executor" }, () => ({ query: "public benchmark" }));
    await collector.close(); expect(store.query("root")).toHaveLength(1);
    const stored = JSON.stringify(store.query("root")[0]);
    now += 101; expect(store.query("root")).toHaveLength(0);
    const next = createTraceContentCollector(v => store.record(v)); next.authorize("next", "root", "diagnostic");
    next.capture({ requestId: "next", rootTraceId: "root", spanId: "span" }, { kind: "tool.input", source: "tool.executor" }, () => "content");
    await next.close(); store.deleteRoot("root"); expect(store.query("root")).toHaveLength(0);
    const small = openTraceContentStore(join(dir, "small.sqlite"), { maxBytes: 100 });
    try { expect(small.record(stored)).toBe(false); expect(small.health().lastErrorCode).toBe("capacity"); } finally { small.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
