import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import { createCapabilityInvocationRepository, migrate } from "@deepfield/persistence";
import { ActionGateway } from "./action-gateway.js";
import { ActionCatalog } from "./action-catalog.js";
import { actionFixture, testAction, testContext } from "./action-test-helpers.js";
const fixtures: Awaited<ReturnType<typeof actionFixture>>[] = []; const dbs: DatabaseSync[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); } for (const db of dbs.splice(0)) db.close(); });
async function fixture(handler: Parameters<typeof testAction>[0] = {}) {
  const f = await actionFixture(testAction({ mode: "immediate", requiresConfirmation: false, ...handler })); fixtures.push(f); await f.start();
  const db = new DatabaseSync(":memory:"); dbs.push(db); migrate(db); const repo = createCapabilityInvocationRepository(db); let now = 100;
  const makeGateway = () => new ActionGateway(f.registry, () => new ActionCatalog(f.runtime.actionCatalog.list()), f.runtime.actionConfirmations, repo, () => now);
  return { ...f, repo, makeGateway, gateway: makeGateway(), advance() { now += 3600000; } };
}
it("requires issuance, binds ownership/input, and reuses persisted result without confirmation or replay", async () => {
  let calls = 0; const f = await fixture({ handler: () => { calls++; return { status: "completed", data: "original" }; } });
  expect(await f.gateway.invoke(f.call, testContext)).toMatchObject({ status: "error", error: { code: "not_found" } });
  const context = f.gateway.issue(f.call, testContext);
  expect(await f.gateway.invoke(f.call, { ...context, callerId: "other" })).toMatchObject({ status: "error", error: { code: "invocation_invalid" } });
  expect(await f.gateway.invoke(f.call, context)).toMatchObject({ status: "completed", data: "original" });
  expect(await f.makeGateway().invoke(f.call, { ...context, requireConfirmation: true })).toMatchObject({ status: "completed", data: "original" });
  expect(calls).toBe(1);
  expect(await f.gateway.invoke({ ...f.call, input: { value: "changed" } }, context)).toMatchObject({ status: "error", error: { code: "invocation_invalid" } });
});
it("does not replay expired issuance or pending dispatch without a committed receipt", async () => {
  let calls = 0; const f = await fixture({ handler: () => { calls++; throw new Error("response lost"); } });
  const expired = f.gateway.issue(f.call, testContext); f.advance();
  expect(await f.gateway.invoke(f.call, expired)).toMatchObject({ status: "error", error: { code: "expired" } });
  const context = f.gateway.issue(f.call, testContext);
  await f.gateway.invoke(f.call, context);
  expect(await f.gateway.invoke(f.call, context)).toMatchObject({ status: "error", error: { code: "reconciliation_required" } });
  expect(calls).toBe(1);
  expect(await f.gateway.query(f.call, context)).toMatchObject({ status: "error", error: { code: "reconciliation_required" } });
});
it("recovers the original committed task after a response loss and marks queried terminal tasks for cleanup", async () => {
  let calls = 0; let taskStatus: "running" | "succeeded" = "running"; let invocation = "";
  const taskRef = { capabilityId: "public-package", taskId: "original-task" };
  const snapshot = () => ({ taskRef, status: taskStatus });
  const action = testAction({ mode: "immediate", requiresConfirmation: false, handler: (_input, context) => { calls++; invocation = context.invocationId; throw new Error("lost after commit"); } });
  const f = await actionFixture(action, (registrar, declaration) => {
    registrar.registerAction!({ definition: action, declaration });
    registrar.registerTaskProvider!({ permissions: { read: ["execute"], cancel: ["execute"] }, async get() { return snapshot(); }, async cancel() { return snapshot(); }, async findByInvocation(id) { return id === invocation ? snapshot() : undefined; } });
  }); fixtures.push(f); await f.start();
  const context = f.runtime.actionGateway.issue(f.call, testContext);
  await f.runtime.actionGateway.invoke(f.call, context);
  expect(await f.runtime.actionGateway.query(f.call, context)).toMatchObject({ status: "accepted", taskRef, taskStatus: "running" });
  expect(await f.runtime.actionGateway.invoke(f.call, context)).toMatchObject({ status: "accepted", taskRef });
  expect(calls).toBe(1);
  taskStatus = "succeeded";
  await f.runtime.taskArtifactGateway.get(taskRef, context);
  expect(f.invocations.get(context.invocationId)?.terminalAt).toEqual(expect.any(Number));
});
it("bounds full action/description/confirmation envelopes and rejects cross-package refs", async () => {
  const f = await fixture({ handler: () => ({ status: "accepted", taskRef: { capabilityId: "foreign", taskId: "task" }, taskStatus: "queued" }) });
  const context = f.gateway.issue(f.call, testContext);
  expect(await f.gateway.invoke(f.call, context)).toMatchObject({ status: "error", error: { code: "INTERNAL.UNKNOWN" } });
  const large = await fixture({ handler: () => ({ status: "completed", data: "界".repeat(23000) }) });
  expect(await large.gateway.invoke(large.call, large.gateway.issue(large.call, testContext))).toMatchObject({ status: "error", error: { code: "response_too_large" } });
  const catalog = new ActionCatalog(large.runtime.actionCatalog.list().map(entry => ({ ...entry, documentation: "x".repeat(65536) })));
  const gateway = new ActionGateway(large.registry, () => catalog, large.runtime.actionConfirmations, large.repo);
  expect(await gateway.describe(large.call, testContext)).toMatchObject({ status: "error", error: { code: "response_too_large" } });
  const hugeCall = { ...large.call, input: { value: "界".repeat(23000) } };
  const hugeContext = large.gateway.issue(hugeCall, { ...testContext, requireConfirmation: true });
  expect(await large.gateway.invoke(hugeCall, hugeContext)).toMatchObject({ status: "error", error: { code: "presentation_invalid" } });
});
it("drops invalid or oversized task presentation without hiding a valid task snapshot", async () => {
  const taskRef = { capabilityId: "public-package", taskId: "one" };
  let presentation: unknown = { text: "x".repeat(1001) };
  const action = testAction();
  const f = await actionFixture(action, (registrar, declaration) => {
    registrar.registerAction!({ definition: action, declaration });
    registrar.registerTaskProvider!({ permissions: { read: ["execute"], cancel: ["execute"] },
      async get() { return { taskRef, status: "running", presentation } as never; },
      async cancel() { return { taskRef, status: "running", presentation } as never; } });
  }); fixtures.push(f); await f.start();
  const invalid = await f.runtime.taskArtifactGateway.get(taskRef, testContext);
  expect(invalid).toMatchObject({ status: "completed", data: { status: "running" } });
  expect(invalid.status === "completed" && "presentation" in invalid.data).toBe(false);
  presentation = { text: "p".repeat(1000) };
  const result = await f.runtime.taskArtifactGateway.get(taskRef, testContext);
  expect(result).toMatchObject({ status: "completed", data: { presentation: { text: "p".repeat(1000) } } });
});
it("prunes a recovered terminal receipt based on completion 31 days before reconciliation", async () => {
  const finishedAt = "2026-08-01T00:00:00.000Z";
  let now = Date.parse("2026-07-31T00:00:00.000Z");
  const taskRef = { capabilityId: "public-package", taskId: "original" };
  const snapshot = { taskRef, status: "succeeded" as const, finishedAt };
  const action = testAction({ mode: "immediate", requiresConfirmation: false, handler: () => { throw new Error("lost response"); } });
  const f = await actionFixture(action, (registrar, declaration) => {
    registrar.registerAction!({ definition: action, declaration });
    registrar.registerTaskProvider!({ permissions: { read: ["execute"], cancel: ["execute"] }, async get() { return snapshot; }, async cancel() { return snapshot; }, async findByInvocation() { return snapshot; } });
  }); fixtures.push(f); await f.start();
  const gateway = new ActionGateway(f.registry, () => f.runtime.actionCatalog, f.runtime.actionConfirmations, f.invocations, () => now);
  const context = gateway.issue(f.call, testContext); await gateway.invoke(f.call, context);
  now = Date.parse("2026-09-01T00:00:00.000Z");
  expect(await gateway.query(f.call, context)).toMatchObject({ status: "accepted", taskRef, taskStatus: "succeeded" });
  expect(f.invocations.get(context.invocationId)?.terminalAt).toBe(Date.parse(finishedAt));
  expect(f.invocations.prune(now)).toBe(1);
});
