import { expect, it } from "vitest";
import { CapabilityRegistry } from "./registry.js";
import { TaskArtifactGateway } from "./task-artifact-gateway.js";
import { DatabaseSync } from "node:sqlite";
import { createCapabilityInvocationRepository, migrate } from "@deepfield/persistence";
const context = { permissions: ["read", "cancel"] };
it.each(["get", "cancel", "findByInvocation"] as const)("uses completion time for a task first observed 31 days later through %s", async operation => {
  const db = new DatabaseSync(":memory:"); migrate(db); const repo = createCapabilityInvocationRepository(db);
  const registry = new CapabilityRegistry(); const activation = registry.begin("generic");
  const finishedAt = "2026-08-01T00:00:00.000Z"; const now = Date.parse("2026-09-01T00:00:00.000Z");
  const ref = { capabilityId: "generic", taskId: "task" }; const snapshot = { taskRef: ref, status: "succeeded" as const, finishedAt };
  activation.registerTaskProvider!({ permissions: { read: [], cancel: [] }, async get() { return snapshot; }, async cancel() { return snapshot; }, async findByInvocation() { return snapshot; } });
  try {
    await activation.ready();
    repo.issue({ id: "id", bindingDigest: "digest", capabilityId: "generic", actionId: "run", issuedAt: 100, expiresAt: 200 }); repo.claim("id", 150); repo.complete("id", {}, "task", 150);
    const gateway = new TaskArtifactGateway(registry, repo, () => now);
    const result = operation === "findByInvocation" ? await gateway.findByInvocation("generic", "id", context) : await gateway[operation](ref, context);
    expect(result).toMatchObject({ status: "completed", data: { finishedAt } });
    expect(repo.get("id")?.terminalAt).toBe(Date.parse(finishedAt));
    expect(repo.prune(now)).toBe(1);
  } finally { await activation.dispose(); db.close(); }
});
it.each([undefined, "invalid", "2026-08-32T00:00:00.000Z", "2027-01-01T00:00:00.000Z"])("normalizes missing, invalid or future completion %s to observed time", async finishedAt => {
  const registry = new CapabilityRegistry(); const activation = registry.begin("generic");
  const ref = { capabilityId: "generic", taskId: "task" };
  const snapshot = { taskRef: ref, status: "failed" as const, ...(finishedAt === undefined ? {} : { finishedAt }) };
  activation.registerTaskProvider!({ permissions: { read: [], cancel: [] }, async get() { return snapshot; }, async cancel() { return snapshot; } });
  try {
    await activation.ready(); const gateway = new TaskArtifactGateway(registry, undefined, () => Date.parse("2026-09-01T00:00:00.000Z"));
    expect(await gateway.get(ref, context)).toMatchObject({ status: "completed", data: { finishedAt: "2026-09-01T00:00:00.000Z" } });
  } finally { await activation.dispose(); }
});
it("reads generic JSON, rejects stale revisions and oversized envelopes, and enforces readiness/permissions", async () => {
  const registry = new CapabilityRegistry(); const activation = registry.begin("generic");
  let payload = { number: 42 } as unknown;
  activation.registerArtifactProvider!({ permissions: { read: ["read"] }, async read() { return { format: "json", data: payload, revision: "2", truncated: false }; } });
  const gateway = new TaskArtifactGateway(registry);
  const ref = { capabilityId: "generic", artifactId: "json", revision: "2" };
  expect(await gateway.read(ref, {}, context)).toMatchObject({ status: "error", error: { code: "capability_unavailable" } });
  await activation.ready();
  expect(await gateway.read(ref, {}, context)).toMatchObject({ status: "completed", data: { data: { number: 42 } } });
  expect(await gateway.read({ ...ref, revision: "1" }, {}, context)).toMatchObject({ status: "error", error: { code: "revision_changed" } });
  expect(await gateway.read(ref, {}, { permissions: [] })).toMatchObject({ status: "error", error: { code: "permission_denied" } });
  payload = "界".repeat(23000);
  expect(await gateway.read(ref, {}, context)).toMatchObject({ status: "error", error: { code: "response_too_large" } });
  await activation.dispose();
  expect(await gateway.read(ref, {}, context)).toMatchObject({ status: "error", error: { code: "capability_unavailable" } });
});
it("cancels only the requested task, rejects foreign refs and unregisters scoped providers", async () => {
  const registry = new CapabilityRegistry(); const activation = registry.begin("generic"); const cancelled: string[] = [];
  const provider = { permissions: { read: ["read"], cancel: ["cancel"] }, async get(ref: { capabilityId: string; taskId: string }) { return { taskRef: ref, status: "running" as const }; }, async cancel(ref: { capabilityId: string; taskId: string }) { cancelled.push(ref.taskId); return { taskRef: ref, status: "cancelled" as const }; } };
  const cleanup = activation.registerTaskProvider!(provider);
  expect(() => activation.registerTaskProvider!(provider)).toThrow();
  await activation.ready(); const gateway = new TaskArtifactGateway(registry); const ref = { capabilityId: "generic", taskId: "one" };
  expect(await gateway.cancel(ref, { permissions: ["read"] })).toMatchObject({ status: "error", error: { code: "permission_denied" } });
  expect(await gateway.cancel(ref, context)).toMatchObject({ status: "completed", data: { status: "cancelled", taskRef: ref } });
  expect(cancelled).toEqual(["one"]);
  await cleanup(); expect(await gateway.get(ref, context)).toMatchObject({ status: "error", error: { code: "capability_unavailable" } });
  await activation.dispose();
});
it("rejects provider identity substitution and preserves only safe structured errors", async () => {
  const registry = new CapabilityRegistry(); const activation = registry.begin("generic");
  let foreign = true;
  activation.registerTaskProvider!({ permissions: { read: [], cancel: [] }, async get(ref) { return { taskRef: { ...ref, capabilityId: foreign ? "other" : ref.capabilityId }, status: "failed", error: { code: "not_found", message: "SECRET", retryable: true } }; }, async cancel(ref) { return { taskRef: { ...ref, taskId: "different" }, status: "cancelled" }; } });
  activation.registerArtifactProvider!({ permissions: { read: [] }, async read() { throw Object.assign(new Error("SECRET"), { code: "expired" }); } });
  await activation.ready(); const gateway = new TaskArtifactGateway(registry); const ref = { capabilityId: "generic", taskId: "one" };
  expect(await gateway.get(ref, context)).toMatchObject({ status: "error", error: { code: "INTERNAL.UNKNOWN" } });
  expect(await gateway.cancel(ref, context)).toMatchObject({ status: "error", error: { code: "INTERNAL.UNKNOWN" } });
  foreign = false;
  const result = await gateway.get(ref, context);
  expect(result).toMatchObject({ status: "completed", data: { error: { code: "not_found", message: "not_found", retryable: false } } });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(await gateway.read({ capabilityId: "generic", artifactId: "data", revision: "1" }, { cursor: "opaque-package-cursor" }, context)).toMatchObject({ status: "error", error: { code: "expired" } });
  await activation.dispose();
});
