import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { AppError } from "@deepfield/contracts";
import { ActionResultSchema, type ActionCall } from "@deepfield/capability-sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { actionFixture, testAction, testContext } from "./action-test-helpers.js";
const fixtures: Awaited<ReturnType<typeof actionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); } });
async function fixture(...args: Parameters<typeof actionFixture>) { const f = await actionFixture(...args); fixtures.push(f); await f.start(); return { ...f, context: f.runtime.actionGateway.issue(f.call, testContext) }; }
describe("trusted action gateway", () => {
  it("uses optional preview after access checks without making its failure block confirmation", async () => {
    const preview = { text: "预览新主题", target: { capabilityId: "public-package", viewId: "preview", input: {} }, autoOpen: true };
    const valid = await fixture(testAction({ presentOperation: () => preview }));
    expect(await valid.runtime.actionGateway.invoke(valid.call, valid.context)).toMatchObject({ status: "requires_confirmation", presentation: preview });
    const broken = await fixture(testAction({ presentOperation: () => { throw new Error("cosmetic"); } }));
    expect(await broken.runtime.actionGateway.invoke(broken.call, broken.context)).toMatchObject({ status: "requires_confirmation" });
    const wrongTarget = await fixture(testAction({ presentOperation: () => ({ ...preview, target: { ...preview.target, capabilityId: "other" } }) }));
    expect(await wrongTarget.runtime.actionGateway.invoke(wrongTarget.call, wrongTarget.context)).not.toHaveProperty("presentation");
  });
  it("drops invalid outcome presentation without converting a completed write into failure", async () => {
    const f = await fixture(testAction({ requiresConfirmation: false, effects: { data: "read", consumesResources: false }, handler: () => ({ status: "completed", data: "done", presentation: { text: "x".repeat(1001) } }) as never }));
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "completed", data: "done" });
  });
  it("drops presentation when it alone would exceed the response boundary", async () => {
    const f = await fixture(testAction({ requiresConfirmation: false, effects: { data: "read", consumesResources: false },
      handler: () => ({ status: "completed", data: "x".repeat(65_000), presentation: { text: "p".repeat(1000) } }) }));
    const result = await f.runtime.actionGateway.invoke(f.call, f.context);
    expect(result).toMatchObject({ status: "completed", data: "x".repeat(65_000) });
    expect(result).not.toHaveProperty("presentation");
  });
  it("shows a bounded business projection while approval remains bound to real input", async () => {
    const f = await fixture(testAction({ presentInput: () => ({ title: "新建主题", fields: [{ label: "主题名称", value: "大模型" }] }) }));
    const pending = await f.runtime.actionGateway.invoke(f.call, f.context);
    expect(pending).toMatchObject({ status: "requires_confirmation", inputSummary: { title: "新建主题", fields: [{ label: "主题名称", value: "大模型" }] } });
    if (pending.status !== "requires_confirmation") throw new Error("expected confirmation");
    const token = f.runtime.actionConfirmations.approve(pending.confirmationRef, f.context)!;
    expect(await f.runtime.actionGateway.invoke({ ...f.call, input: { value: "changed" } }, { ...f.context, confirmationToken: token }))
      .toMatchObject({ status: "error", error: { code: "invocation_invalid" } });
  });
  it("fails closed when a presenter throws or hides a parameter", async () => {
    const thrown = await fixture(testAction({ presentInput: () => { throw new Error("secret"); } }));
    expect(await thrown.runtime.actionGateway.invoke(thrown.call, thrown.context)).toMatchObject({ status: "error", error: { code: "presentation_invalid" } });
    const oversized = await fixture(testAction({ presentInput: () => ({ title: "操作", fields: [{ label: "输入", value: "x".repeat(4001) }] }) }));
    expect(await oversized.runtime.actionGateway.invoke(oversized.call, oversized.context)).toMatchObject({ status: "error", error: { code: "presentation_invalid" } });
    const legacyWrite = testAction(); delete legacyWrite.presentInput;
    const missing = await fixture(legacyWrite);
    expect(await missing.runtime.actionGateway.invoke(missing.call, missing.context)).toMatchObject({ status: "error", error: { code: "presentation_invalid" } });
  });
  it("does not trust confirmed fields, permissions or sources in call arguments", async () => {
    let calls = 0; const f = await fixture(testAction({ handler: () => { calls++; return { status: "completed", data: "done" }; } }));
    expect(await f.runtime.actionGateway.invoke({ ...f.call, confirmed: true } as typeof f.call, f.context)).toMatchObject({ status: "error", error: { code: "INPUT.INVALID" } });
    expect(await f.runtime.actionGateway.invoke(f.call, { ...f.context, permissions: [] })).toMatchObject({ status: "error", error: { code: "permission_denied" } });
    expect(await f.runtime.actionGateway.invoke({ ...f.call, input: { value: "hello", source: "ui", permissions: ["execute"] } }, f.context)).toMatchObject({ status: "error", error: { code: "INPUT.INVALID" } });
    expect(calls).toBe(0);
  });
  it("binds confirmation to parameters and caller; consumes approved authorization only once", async () => {
    let calls = 0; const f = await fixture(testAction({ handler: () => { calls++; return { status: "completed", data: "done" }; } }));
    const pending = await f.runtime.actionGateway.invoke(f.call, f.context);
    if (pending.status !== "requires_confirmation") throw new Error("expected confirmation");
    expect(calls).toBe(0);
    expect(f.runtime.actionConfirmations.approve(pending.confirmationRef, { ...f.context, callerId: "other" })).toBeUndefined();
    const token = f.runtime.actionConfirmations.approve(pending.confirmationRef, f.context)!;
    const approved = { ...f.context, confirmationToken: token };
    const results = await Promise.all([f.runtime.actionGateway.invoke(f.call, approved), f.runtime.actionGateway.invoke(f.call, approved)]);
    expect(results.map(r => r.status).sort()).toEqual(["completed", "error"]); expect(calls).toBe(1);
    expect(results.find(r => r.status === "completed")).toMatchObject({ capabilityId: "public-package", actionId: "run", packageVersion: "1.0.0", invocationId: f.context.invocationId, contractDigest: f.call.contractDigest });
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "completed", data: "done" });
    const nextContext = f.runtime.actionGateway.issue(f.call, testContext);
    const next = await f.runtime.actionGateway.invoke(f.call, nextContext);
    if (next.status !== "requires_confirmation") throw new Error("expected confirmation");
    const changedToken = f.runtime.actionConfirmations.approve(next.confirmationRef, nextContext)!;
    expect(await f.runtime.actionGateway.invoke({ ...f.call, input: { value: "different" } }, { ...nextContext, confirmationToken: changedToken })).toMatchObject({ status: "error", error: { code: "invocation_invalid" } });
    expect(calls).toBe(1);
  });
  it("checks contract and readiness at invocation, preserves safe business codes and hides raw exceptions", async () => {
    const f = await fixture(testAction({ mode: "immediate", effects: { data: "read", consumesResources: false }, requiresConfirmation: false, handler: () => { throw new AppError("BUSINESS.CONFLICT", undefined, { cause: new Error("SECRET") }); } }));
    expect(await f.runtime.actionGateway.invoke({ ...f.call, contractDigest: `sha256:${"0".repeat(64)}` }, f.context)).toMatchObject({ status: "error", error: { code: "contract_changed" } });
    const result = await f.runtime.actionGateway.invoke(f.call, f.context);
    expect(result).toMatchObject({ status: "error", error: { code: "BUSINESS.CONFLICT" } }); expect(JSON.stringify(result)).not.toContain("SECRET");
    await f.runtime.dispose();
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "error", error: { code: "capability_unavailable" } });
  });
  it("validates handler output and rejects forged host result metadata", async () => {
    const f = await fixture(testAction({ requiresConfirmation: false, mode: "immediate", handler: () => ({ status: "completed", data: 12, invocationId: "forged" }) as never }));
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "error", invocationId: f.context.invocationId, error: { code: "INTERNAL.UNKNOWN" } });
  });
  it("invalidates approval when changed parameters fail schema validation", async () => {
    const f = await fixture(); const pending = await f.runtime.actionGateway.invoke(f.call, f.context);
    if (pending.status !== "requires_confirmation") throw new Error("expected confirmation");
    const token = f.runtime.actionConfirmations.approve(pending.confirmationRef, f.context)!;
    const context = { ...f.context, confirmationToken: token };
    expect(await f.runtime.actionGateway.invoke({ ...f.call, input: { value: 2 } }, context)).toMatchObject({ status: "error", error: { code: "INPUT.INVALID" } });
    expect(await f.runtime.actionGateway.invoke(f.call, context)).toMatchObject({ status: "error", error: { code: "confirmation_invalid" } });
  });
  it("allows read queries without confirmation despite resource consumption and applies stricter host policy", async () => {
    const f = await fixture(testAction({ requiresConfirmation: false, mode: "immediate", effects: { data: "read", consumesResources: true }, handler: (_input, context) => ({ status: "completed", data: `${context.source}:${context.invocationId}` }) }));
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "completed", data: `chat:${f.context.invocationId}` });
    const stricter = f.runtime.actionGateway.issue(f.call, { ...testContext, requireConfirmation: true });
    expect(await f.runtime.actionGateway.invoke(f.call, stricter)).toMatchObject({ status: "requires_confirmation" });
  });
  it.each(["destructive", "task"])("requires one trusted confirmation by default for %s effects", async kind => {
    const f = await fixture(testAction({ requiresConfirmation: false, mode: kind === "task" ? "task" : "immediate", effects: { data: kind === "destructive" ? "destructive" : "read", consumesResources: true } }));
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "requires_confirmation" });
  });
  it("returns useful field paths and constraints without leaking rejected input values", async () => {
    const f = await fixture();
    const result = await f.runtime.actionGateway.invoke({ ...f.call, input: { value: { secret: "SECRET" } } }, f.context);
    expect(result).toMatchObject({ status: "error", error: { code: "INPUT.INVALID", fieldErrors: [{ path: "/value", message: "type" }] } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it.each([null, {}, { capabilityId: 42, actionId: "", contractDigest: false, input: null }])("returns a schema-valid error envelope for malformed calls: %j", async call => {
    const f = await fixture(); const result = await f.runtime.actionGateway.invoke(call as ActionCall, f.context);
    expect(result).toMatchObject({ status: "error", error: { code: "INPUT.INVALID" } });
    expect(Value.Check(ActionResultSchema(Type.Unknown()), result)).toBe(true);
  });
  it("wraps accepted task outcomes without validating their envelope as business output", async () => {
    const f = await fixture(testAction({ mode: "immediate", requiresConfirmation: false, handler: () => ({ status: "accepted", taskRef: { capabilityId: "public-package", taskId: "task" }, taskStatus: "queued" }) }));
    expect(await f.runtime.actionGateway.invoke(f.call, f.context)).toMatchObject({ status: "accepted", taskStatus: "queued", invocationId: f.context.invocationId, packageVersion: "1.0.0" });
  });
  it("projects unexpected exceptions to a safe error", async () => {
    const f = await fixture(testAction({ mode: "immediate", requiresConfirmation: false, handler: () => { throw new Error("SECRET trace"); } }));
    const result = await f.runtime.actionGateway.invoke(f.call, f.context);
    expect(result).toMatchObject({ status: "error", error: { code: "INTERNAL.UNKNOWN" } }); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
