import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import type { Repositories, ToolExecutionStart } from "@deepfield/persistence";

const ISO = "2026-01-01T00:00:00.000Z";

function openRaw(): { db: DatabaseSync; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "df-tool-summary-"));
  const db = openDatabase(join(dir, "t.sqlite"));
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function openTemp(): { db: DatabaseSync; repos: Repositories; cleanup(): void } {
  const raw = openRaw();
  migrate(raw.db);
  return { db: raw.db, repos: createRepositories(raw.db), cleanup: raw.cleanup };
}

function start(
  repos: Repositories,
  id: string,
  overrides: Partial<ToolExecutionStart> = {},
): void {
  repos.toolExecutions.start({
    id,
    traceId: "trace-1",
    actor: "developer_probe",
    toolName: "echo",
    toolVersion: 1,
    startedAt: ISO,
    ...overrides,
  });
}

describe("tool execution summary sanitization", () => {
  it("rejects forbidden summary keys case-insensitively and never lands them", () => {
    const { db, repos, cleanup } = openTemp();
    const variants: Record<string, unknown>[] = [
      { body: "x" },
      { html: 1 },
      { pdf: 1 },
      { text: "x" },
      { apiKey: "k" },
      { authorization: "x" },
      { cookie: "x" },
      { cause: "x" },
      { stack: "x" },
      { HTML: 1 },
      { ApiKey: "k" },
      { nested: { deep: { cookie: "x" } } },
      { constructor: { x: 1 } },
      { prototype: { x: 1 } },
      { __proto__: { polluted: true } },
    ];
    variants.forEach((summary, i) => {
      start(repos, `v${i}`, { inputSummary: summary });
    });
    const rows = db
      .prepare("SELECT input_summary_json FROM tool_executions WHERE id LIKE 'v%'")
      .all() as { input_summary_json: string | null }[];
    expect(rows.every((row) => row.input_summary_json === null)).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    cleanup();
  });

  it("allows forbidden words inside string values", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "ok", {
      inputSummary: { url: "https://example.com/body/text?q=pdf", results: 3 },
    });
    const row = db
      .prepare("SELECT input_summary_json FROM tool_executions WHERE id='ok'")
      .get() as { input_summary_json: string | null };
    expect(JSON.parse(row.input_summary_json!)).toEqual({
      url: "https://example.com/body/text?q=pdf",
      results: 3,
    });
    cleanup();
  });

  it("bounds summary depth, nodes and serialized bytes", () => {
    const { db, repos, cleanup } = openTemp();
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 300; i += 1) {
      many[`k${i}`] = { v: i };
    }
    const big = { list: Array.from({ length: 200 }, () => "x".repeat(200)) };
    start(repos, "deep", { inputSummary: deep });
    start(repos, "many", { inputSummary: many });
    start(repos, "big", { inputSummary: big });
    const rows = db
      .prepare("SELECT input_summary_json FROM tool_executions WHERE id IN ('deep','many','big')")
      .all() as { input_summary_json: string | null }[];
    expect(rows.every((row) => row.input_summary_json === null)).toBe(true);
    cleanup();
  });
});

describe("summary UTF-8 byte limits (focused revision)", () => {
  it("rejects strings whose UTF-8 size exceeds the budget even when code units are small", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "cjk", {
      inputSummary: { values: Array.from({ length: 4 }, () => "汉".repeat(2000)) },
    });
    start(repos, "emoji", { inputSummary: { value: "😀".repeat(2000) } });
    start(repos, "ascii-over", { inputSummary: { value: "a".repeat(4097) } });
    start(repos, "ascii-at-limit", { inputSummary: { value: "a".repeat(4096) } });
    const rows = db
      .prepare("SELECT id, input_summary_json FROM tool_executions")
      .all() as { id: string; input_summary_json: string | null }[];
    const byId = new Map(rows.map((row) => [row.id, row.input_summary_json]));
    expect(byId.get("cjk")).toBeNull();
    expect(byId.get("emoji")).toBeNull();
    expect(byId.get("ascii-over")).toBeNull();
    expect(byId.get("ascii-at-limit")).not.toBeNull();
    cleanup();
  });

  it("rejects serialized output above the UTF-8 byte budget", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "over", {
      inputSummary: { values: Array.from({ length: 6 }, () => "汉".repeat(1000)) },
    });
    start(repos, "under", {
      inputSummary: { values: Array.from({ length: 5 }, () => "汉".repeat(1000)) },
    });
    const rows = db
      .prepare("SELECT id, input_summary_json FROM tool_executions")
      .all() as { id: string; input_summary_json: string | null }[];
    const byId = new Map(rows.map((row) => [row.id, row.input_summary_json]));
    expect(byId.get("over")).toBeNull();
    expect(byId.get("under")).not.toBeNull();
    cleanup();
  });
});
