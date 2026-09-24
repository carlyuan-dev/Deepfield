import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { actionFixture, testAction } from "./action-test-helpers.js";
import { CapabilityChatHost } from "./chat-host.js";
import { ViewNavigation } from "./view-navigation.js";
import { ActionGateway } from "./action-gateway.js";
import { Type } from "typebox";


describe("trusted capability Chat host", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it("associates identical package-local task IDs with their own interaction receipts", async () => {
    const fixture = await actionFixture(testAction()); await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const conversationId = repos.conversations.create().id;
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    const expected = new Map<string, string>();
    for (const capabilityId of ["package-a", "package-b"]) {
      const item = repos.chatInteractions.create({ conversationId, requestId: "same-request", toolCallId: capabilityId }, { kind: "approval", summary: capabilityId, operation: { provider: "capability", operationId: "opaque", contractVersion: "1" } });
      const receiptId = `receipt-${capabilityId}`; const invocationId = `invocation-${capabilityId}`;
      repos.chatInteractions.claimApproval(item.id, item.revision, receiptId, "chat_button");
      repos.chatInteractions.finishExecution(item.id, receiptId, { status: "submitted", summary: "Submitted", taskId: "local-task" });
      repos.capabilityInvocations.issue({ id: invocationId, bindingDigest: "digest", capabilityId, actionId: "run", issuedAt: 1, expiresAt: 100 });
      repos.capabilityInvocations.claim(invocationId, 2);
      repos.capabilityInvocations.complete(invocationId, { status: "accepted", taskRef: { capabilityId, taskId: "local-task" } }, "local-task", 3);
      repos.chatCapabilities.bindInvocation({ conversationId, sourceRequestId: "same-request", toolCallId: `interaction:${receiptId}`, invocationId, callDigest: "digest" });
      repos.chatCapabilities.linkTask({ conversationId, sourceRequestId: "same-request", snapshot: { taskRef: { capabilityId, taskId: "local-task" }, status: "running" }, analyzeAfter: false, analysisState: "none" });
      expected.set(capabilityId, item.id);
    }
    expect(host.tasks(conversationId).map(card => [card.snapshot.taskRef.capabilityId, card.interactionId])).toEqual([...expected]);
  });

  it("keeps an approved immediate result readable in the original conversation", async () => {
    const action = testAction({ mode: "immediate", outputSchema: Type.Object({ summary: Type.String(), candidateIds: Type.Array(Type.String()) }),
      presentInput: () => ({ title: "识别公司", fields: [{ label: "输入", value: "两家公司" }] }),
      handler: () => ({ status: "completed", data: { summary: "识别出甲公司、乙公司，请确认候选。", candidateIds: ["internal-1"] } }) });
    const fixture = await actionFixture(action); await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const conversation = repos.conversations.create();
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.setActiveConversation(conversation.id); host.begin("request", conversation.id, "识别公司");
    await host.call("request", "describe", "describe", fixture.call);
    const pending = await host.call("request", "invoke", "invoke", fixture.call) as { confirmationRef: string };
    host.end("request");
    expect(await host.approve(pending.confirmationRef, conversation.id, false)).toMatchObject({ status: "completed" });
    expect(host.operations(conversation.id)).toMatchObject([{ sourceRequestId: "request", status: "completed",
      title: "识别公司", presentation: { text: "识别出甲公司、乙公司，请确认候选。" } }]);
    expect(JSON.stringify(host.operations(conversation.id))).not.toContain("internal-1");
    expect(repos.messages.listByConversation(conversation.id)).toHaveLength(0);
  });

  it("reports an executed action with an oversized response as uncertain", async () => {
    let executions = 0;
    const fixture = await actionFixture(testAction({ mode: "immediate", handler: () => {
      executions++; return { status: "completed", data: "x".repeat(70_000) };
    } }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const conversation = repos.conversations.create();
    const actionGateway = new ActionGateway(fixture.registry, () => fixture.runtime.actionCatalog,
      fixture.runtime.actionConfirmations, repos.capabilityInvocations);
    const host = new CapabilityChatHost(() => ({ ...fixture.runtime, actionGateway }), fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.setActiveConversation(conversation.id); host.begin("request", conversation.id, "执行操作");
    await host.call("request", "describe", "describe", fixture.call);
    const pending = await host.call("request", "invoke", "invoke", fixture.call) as { confirmationRef: string; invocationId: string };
    host.end("request");
    expect(await host.approve(pending.confirmationRef, conversation.id, false)).toMatchObject({ status: "error", error: { code: "response_too_large" } });
    expect(executions).toBe(1);
    expect(repos.capabilityInvocations.get(pending.invocationId)?.state).toBe("pending");
    expect(host.operations(conversation.id)).toMatchObject([{ sourceRequestId: "request", status: "uncertain",
      presentation: { text: "操作结果待核实。请查询原操作状态，避免重复执行。" } }]);
  });

  it("opens a new preview then the confirmed result once, but not after manual navigation", async () => {
    const preview = { capabilityId: "public-package", viewId: "preview", input: {} };
    const detail = { capabilityId: "public-package", viewId: "detail", input: {} };
    const fixture = await actionFixture(testAction({ mode: "immediate",
      presentOperation: () => ({ text: "预览主题", target: preview, autoOpen: true }),
      handler: () => ({ status: "completed", data: "done", presentation: { text: "已创建主题", target: detail, autoOpen: true } }) }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const conversation = repos.conversations.create();
    const navigation = new ViewNavigation(async target => ({ status: "resolved", view: target as typeof preview }));
    const opened: string[] = [];
    navigation.attach(1, event => { if (event.kind === "open") { opened.push("viewId" in event.target ? event.target.viewId : "draft"); navigation.ack(1, event.requestId, "public-package", { status: "opened" }); } });
    const host = new CapabilityChatHost(() => ({ ...fixture.runtime, navigation }), fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); navigation.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.setActiveConversation(conversation.id);
    host.begin("request-1", conversation.id, "新建主题");
    await host.call("request-1", "describe", "describe", fixture.call);
    const pending = await host.call("request-1", "invoke", "invoke", fixture.call) as { confirmationRef: string };
    await vi.waitFor(() => expect(opened).toEqual(["preview"]));
    expect(host.pendingConfirmations(conversation.id)).toMatchObject([{ sourceRequestId: "request-1", presentation: { text: "预览主题" } }]);
    host.end("request-1");
    expect(await host.approve(pending.confirmationRef, conversation.id, false)).toMatchObject({ status: "completed" });
    await vi.waitFor(() => expect(opened).toEqual(["preview", "detail"]));
    expect(host.operations(conversation.id)).toMatchObject([{ sourceRequestId: "request-1", status: "completed", presentation: { text: "已创建主题" } }]);
    host.begin("request-2", conversation.id, "再建主题");
    const second = await host.call("request-2", "invoke", "invoke", fixture.call) as { confirmationRef: string };
    await vi.waitFor(() => expect(opened).toEqual(["preview", "detail", "preview"]));
    navigation.noteManualNavigation();
    host.end("request-2");
    await host.approve(second.confirmationRef, conversation.id, false);
    await Promise.resolve();
    expect(opened).toEqual(["preview", "detail", "preview"]);
  });

  it("keeps a neutral submitted status for confirmed legacy tasks without optional presentation", async () => {
    const taskRef = { capabilityId: "public-package", taskId: "legacy-task" };
    const fixture = await actionFixture(testAction({ mode: "task", handler: () => ({ status: "accepted", taskRef, taskStatus: "queued" }) }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const conversation = repos.conversations.create();
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.setActiveConversation(conversation.id); host.begin("legacy-request", conversation.id, "执行任务");
    await host.call("legacy-request", "describe", "describe", fixture.call);
    const pending = await host.call("legacy-request", "invoke", "invoke", fixture.call) as { confirmationRef: string };
    host.end("legacy-request");
    expect(await host.approve(pending.confirmationRef, conversation.id, false)).toMatchObject({ status: "accepted" });
    expect(host.pendingConfirmations(conversation.id)).toEqual([]);
    expect(host.tasks(conversation.id)).toMatchObject([{ sourceRequestId: "legacy-request",
      snapshot: { status: "queued", presentation: { text: "任务已提交，正在处理。" } } }]);
    expect(host.operations(conversation.id)).toEqual([]);
  });


  it.each([false, true])("allows fresh identical calls after pruning safe receipts (confirmation: %s)", async requiresConfirmation => {
    let executions = 0;
    const fixture = await actionFixture(testAction({ mode: "immediate", requiresConfirmation,
      handler: () => { executions++; return { status: "completed", data: "done" }; } }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const a = repos.conversations.create();
    const actionGateway = new ActionGateway(fixture.registry, () => fixture.runtime.actionCatalog, fixture.runtime.actionConfirmations, repos.capabilityInvocations);
    const host = new CapabilityChatHost(() => ({ ...fixture.runtime, actionGateway }), fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.begin("first", a.id, "Run"); await host.call("first", "describe", "describe", fixture.call);
    const first = await host.call("first", "invoke", "invoke", fixture.call) as { invocationId: string; status: string };
    expect(first.status).toBe(requiresConfirmation ? "requires_confirmation" : "completed");
    host.end("first"); repos.capabilityInvocations.prune(Date.now() + 31 * 86400000);
    host.begin("next", a.id, "Run again intentionally");
    const fresh = await host.call("next", "new", "invoke", fixture.call) as { invocationId: string; status: string };
    expect(fresh.status).toBe(requiresConfirmation ? "requires_confirmation" : "completed");
    expect(fresh.invocationId).not.toBe(first.invocationId);
    expect(await host.call("next", "stale", "invoke", { ...fixture.call, invocationId: first.invocationId })).toMatchObject({ status: "error" });
    expect(executions).toBe(requiresConfirmation ? 0 : 2);
  });

  it("cancels model navigation on request end and UI navigation on conversation switch", async () => {
    const fixture = await actionFixture(); await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const a = repos.conversations.create(); const b = repos.conversations.create();
    const target = { capabilityId: "public-package", viewId: "detail", input: {} };
    let resolve!: (value: any) => void;
    const navigation = new ViewNavigation(() => new Promise(done => { resolve = done; }));
    const events: any[] = []; navigation.attach(1, event => events.push(event));
    const host = new CapabilityChatHost(() => ({ ...fixture.runtime, navigation }), fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); navigation.dispose(); db.close(); await fixture.runtime.dispose(); });
    repos.chatCapabilities.saveViews(a.id, "old", [target]); host.setActiveConversation(a.id);
    host.begin("request", a.id, "Show detail");
    const pending = host.call("request", "open", "open", { target });
    host.end("request"); resolve({ status: "resolved", view: target });
    expect(await pending).toMatchObject({ status: "blocked" });
    expect(events.some(event => event.kind === "open")).toBe(false);
    const ui = host.openForConversation(a.id, target);
    host.setActiveConversation(b.id); resolve({ status: "resolved", view: target });
    expect(await ui).toMatchObject({ status: "blocked" });
    expect(events.some(event => event.kind === "open")).toBe(false);
  });

  it("reconciles uncertain writes across tool IDs and host recreation without dispatching again", async () => {
    let executions = 0;
    const fixture = await actionFixture(testAction({ mode: "immediate", requiresConfirmation: false,
      handler: () => { executions++; throw new Error("response lost"); } }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const a = repos.conversations.create(); const b = repos.conversations.create();
    const actionGateway = new ActionGateway(fixture.registry, () => fixture.runtime.actionCatalog, fixture.runtime.actionConfirmations, repos.capabilityInvocations);
    const runtime = () => ({ ...fixture.runtime, actionGateway });
    let host = new CapabilityChatHost(runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.begin("first", a.id, "Run");
    await host.call("first", "describe", "describe", fixture.call);
    const first = await host.call("first", "one", "invoke", fixture.call) as { invocationId: string };
    const retry = await host.call("first", "two", "invoke", fixture.call) as { invocationId: string };
    expect(executions).toBe(1); expect(retry.invocationId).toBe(first.invocationId);
    host.dispose(); host = new CapabilityChatHost(runtime, fixture.registry, repos);
    host.begin("second", a.id, "Retry");
    const resumed = await host.call("second", "three", "invoke", fixture.call) as { invocationId: string };
    expect(executions).toBe(1); expect(resumed.invocationId).toBe(first.invocationId);
    expect(await host.call("second", "explicit", "invoke", { ...fixture.call, invocationId: first.invocationId }))
      .toMatchObject({ invocationId: first.invocationId, status: "error", error: { code: "reconciliation_required" } });
    host.begin("other", b.id, "Retry"); await host.call("other", "describe", "describe", fixture.call);
    expect(await host.call("other", "foreign", "invoke", { ...fixture.call, invocationId: first.invocationId }))
      .toMatchObject({ status: "error", error: { code: "invocation_invalid" } });
    expect(executions).toBe(1);
    repos.capabilityInvocations.prune(Date.now() + 31 * 86400000);
    expect(await host.call("second", "after-prune", "invoke", fixture.call))
      .toMatchObject({ status: "error", invocationId: first.invocationId, error: { code: "not_found" } });
    expect(executions).toBe(1);
  });

  it("recovers an approved invocation's lost acceptance and links the original task", async () => {
    let executions = 0; let submittedId = "";
    const snapshot = { taskRef: { capabilityId: "public-package", taskId: "approved-task" }, status: "running" as const };
    const action = testAction({ handler: (_input, context) => { executions++; submittedId = context.invocationId; throw new Error("receipt response lost"); } });
    const fixture = await actionFixture(action, (registrar, declaration) => {
      registrar.registerAction!({ definition: action, declaration });
      registrar.registerTaskProvider!({ permissions: { read: [], cancel: [] }, get: async () => snapshot, cancel: async () => snapshot,
        findByInvocation: async id => id === submittedId ? snapshot : undefined });
    });
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); migrate(db); const repos = createRepositories(db);
    const a = repos.conversations.create();
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.setActiveConversation(a.id); host.begin("first", a.id, "Run");
    await host.call("first", "describe", "describe", fixture.call);
    const confirmation = await host.call("first", "invoke", "invoke", fixture.call) as { confirmationRef: string; invocationId: string };
    host.end("first");
    expect(await host.approve(confirmation.confirmationRef, a.id, false)).toMatchObject({ status: "error", invocationId: confirmation.invocationId });
    host.begin("next", a.id, "Check the task");
    expect(await host.call("next", "recover", "invoke", { ...fixture.call, invocationId: confirmation.invocationId }))
      .toMatchObject({ status: "accepted", invocationId: confirmation.invocationId, taskRef: snapshot.taskRef });
    expect(host.tasks(a.id)[0]?.snapshot.taskRef).toEqual(snapshot.taskRef);
    expect(executions).toBe(1);
  });

  it("requires a current per-session description and a real UI-bound confirmation", async () => {
    const fixture = await actionFixture();
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db);
    const repos = createRepositories(db);
    const a = repos.conversations.create(); const b = repos.conversations.create();
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.begin("chat-a", a.id, "Run the public action");
    host.begin("chat-b", b.id, "Run the public action");
    expect(host.directory()).toHaveLength(1);
    expect((await host.call("chat-b", "invoke-b", "invoke", fixture.call) as { error?: { code?: string } }).error?.code).toBe("contract_changed");
    const described = await host.call("chat-a", "describe-a", "describe", { capabilityId: fixture.call.capabilityId, actionId: fixture.call.actionId }) as { status: string };
    expect(described.status).toBe("described");
    expect((await host.call("chat-a", "describe-again", "describe", { capabilityId: fixture.call.capabilityId, actionId: fixture.call.actionId }) as { status: string }).status).toBe("already_described");
    host.end("chat-a");
    host.begin("chat-a", a.id, "Run the public action");
    expect((await host.call("chat-a", "describe-after-compaction", "describe", { capabilityId: fixture.call.capabilityId, actionId: fixture.call.actionId }) as { status: string }).status).toBe("described");
    const requested = await host.call("chat-a", "invoke-a", "invoke", fixture.call) as { status: string; confirmationRef: string };
    expect(requested.status).toBe("requires_confirmation");
    expect(host.pendingConfirmations(b.id)).toEqual([]);
    host.setActiveConversation(b.id);
    expect((await host.approve(requested.confirmationRef, a.id, false) as { status: string }).status).toBe("error");
    host.setActiveConversation(a.id);
    expect((await host.approve(requested.confirmationRef, a.id, false) as { status: string }).status).toBe("completed");
    expect((await host.call("chat-a", "invoke-a", "invoke", fixture.call) as { status: string }).status).toBe("completed");
    const second = await host.call("chat-a", "invoke-a-2", "invoke", fixture.call) as { confirmationRef: string };
    expect(host.dismiss(second.confirmationRef, a.id)).toBe(true);
    expect(host.pendingConfirmations(a.id)).toEqual([]);
    host.end("chat-a");
    expect((await host.call("chat-a", "missing", "invoke", fixture.call) as { status: string }).status).toBe("error");
  });

  it("persists only package-supplied view refs and checks the active conversation before opening", async () => {
    const target = { capabilityId: "public-package", viewId: "detail", input: { recordId: "r1" } };
    const fixture = await actionFixture(testAction({ mode: "immediate", effects: { data: "read", consumesResources: false },
      requiresConfirmation: false, handler: () => ({ status: "completed", data: "ok", viewRefs: [target] }) }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db);
    const repos = createRepositories(db); const a = repos.conversations.create(); const b = repos.conversations.create();
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    cleanups.push(async () => { host.dispose(); db.close(); await fixture.runtime.dispose(); });
    host.begin("chat-a", a.id, "Show detail");
    await host.call("chat-a", "describe", "describe", { capabilityId: fixture.call.capabilityId, actionId: fixture.call.actionId });
    expect((await host.call("chat-a", "invoke", "invoke", fixture.call) as { status: string }).status).toBe("completed");
    expect(host.views(a.id)).toEqual([{ conversationId: a.id, sourceRequestId: "chat-a", target }]);
    expect(host.views(b.id)).toEqual([]);
    host.begin("chat-b", b.id, "Show detail");
    host.setActiveConversation(b.id);
    expect((await host.openForConversation(a.id, target)).status).toBe("blocked");
    expect((await host.call("chat-b", "open", "open", { target }) as { status: string }).status).toBe("not_found");
    host.setActiveConversation(a.id);
    expect((await host.openForConversation(a.id, target)).status).toBe("unsupported");
    expect((await host.call("chat-a", "open", "open", { target }) as { status: string }).status).toBe("unsupported");
    expect((await host.call("chat-a", "open-other", "open", { target: { ...target, input: { recordId: "r2" } } }) as { status: string }).status).toBe("not_found");
  });
});
