import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openTraceStore } from "../../apps/desktop/src/main/trace-store.js";

it("runs both compiled CLI entries and keeps Phoenix's export import free of CLI side effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-cli-test-"));
  const database = join(directory, "trace.sqlite");
  const store = openTraceStore(database);
  const event = { version: 1, rootTraceId: "root", spanId: "span", requestId: "request", processSessionId: "session", kind: "request" };
  store.record({ ...event, eventId: "start", sequence: 1, time: "2026-10-21T00:00:00.000Z", type: "span.start" });
  store.record({ ...event, eventId: "end", sequence: 2, time: "2026-10-21T00:00:01.000Z", type: "span.end", status: "succeeded" });
  store.close();
  const run = (command: string, selector: string) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url)), command, database, selector], { encoding: "utf8", timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    expect(run("export", "--list")).toMatchObject([{ rootTraceId: "root", status: "succeeded" }]);
    expect(run("export", "root")).toMatchObject({ rootTraceId: "root", usageAttemptIds: [] });
    expect(run("phoenix", "root")).toMatchObject({ mode: "dry-run", spanCount: 1 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60000);
