import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "./migrations.js";
import { createCapabilityInvocationRepository } from "./capability-invocation-repository.js";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() { const db = new DatabaseSync(":memory:"); databases.push(db); migrate(db); return { db, repo: createCapabilityInvocationRepository(db) }; }
it("claims an issued invocation once and reloads its receipt without business data", () => {
  const { db, repo } = fixture();
  repo.issue({ id: "id", bindingDigest: "digest", capabilityId: "generic", actionId: "run", issuedAt: 100, expiresAt: 200 });
  expect(repo.claim("id", 150)).toBe(true);
  expect(repo.claim("id", 150)).toBe(false);
  repo.complete("id", { status: "accepted" }, "task", 160);
  expect(createCapabilityInvocationRepository(db).get("id")).toMatchObject({ state: "completed", taskId: "task", result: { status: "accepted" } });
});
it("refuses expired issuances and prunes terminal/unknown receipts while retaining live tasks", () => {
  const { repo } = fixture();
  for (const id of ["expired", "live", "terminal", "unknown"]) repo.issue({ id, bindingDigest: "digest", capabilityId: "generic", actionId: "run", issuedAt: 100, expiresAt: 200 });
  expect(repo.claim("expired", 201)).toBe(false);
  repo.claim("live", 150); repo.complete("live", {}, "task", 150);
  repo.claim("terminal", 150); repo.complete("terminal", {}, undefined, 150);
  repo.claim("unknown", 150);
  expect(repo.prune(31 * 86400000)).toBe(3);
  expect(repo.get("live")?.taskId).toBe("task");
  repo.markTaskTerminal("generic", "task", 31 * 86400000);
  expect(repo.prune(62 * 86400000)).toBe(1);
});
it("persists identity and receipt across closing and reopening the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "invocation-reload-")); const path = join(directory, "state.sqlite");
  let db = new DatabaseSync(path);
  try {
    migrate(db); const first = createCapabilityInvocationRepository(db);
    first.issue({ id: "reload", bindingDigest: "digest", capabilityId: "generic", actionId: "run", issuedAt: 100, expiresAt: 200 });
    first.claim("reload", 150); first.complete("reload", { status: "accepted", taskRef: { capabilityId: "generic", taskId: "original" } }, "original", 150);
    db.close(); db = new DatabaseSync(path); migrate(db);
    const second = createCapabilityInvocationRepository(db);
    expect(second.claim("reload", 160)).toBe(false);
    expect(second.get("reload")).toMatchObject({ state: "completed", result: { status: "accepted", taskRef: { taskId: "original" } } });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
it("tightens an observed terminal time when an earlier completion becomes known and never extends it", () => {
  const { repo } = fixture();
  repo.issue({ id: "id", bindingDigest: "digest", capabilityId: "generic", actionId: "run", issuedAt: 100, expiresAt: 200 });
  repo.claim("id", 150); repo.complete("id", {}, "task", 150);
  repo.markTaskTerminal("generic", "task", 31 * 86400000);
  repo.markTaskTerminal("generic", "task", 200);
  repo.markTaskTerminal("generic", "task", 32 * 86400000);
  expect(repo.get("id")?.terminalAt).toBe(200);
  expect(repo.prune(31 * 86400000)).toBe(1);
});
