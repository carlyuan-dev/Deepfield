import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ChatInteractionCoordinator, classifyExplicitDecision, classifyTaskDecision, snapshotExactTaskCalls, exactTaskCallDigest, TaskGrantStore, freezeTaskScope, TaskScopeStore, type FrozenTaskScope, type ScopeClaim, type ExactTaskCall, type TaskGrantClaim, type OperationAdapter } from "@deepfield/application";
import type { InteractionEditorState, InteractionOwner, InteractionRecord, OperationRef, OperationResult, RespondCommand } from "@deepfield/contracts";
import { ActionCallSchema, canonicalActionJson, TaskScopeProposalSchema, ViewRefSchema, type TaskScopeProposal, type ActionCall, type CapabilityFormSnapshot, type DraftRef, type ViewRef } from "@deepfield/capability-sdk";
import type { Repositories } from "@deepfield/persistence";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { CapabilityRuntime } from "../capabilities/runtime.js";

type TaskProposal = { id: string; calls: ExactTaskCall[]; remainingSummary: string };
type Binding = { owner: InteractionOwner; capabilityId: string; actionId: string; contractDigest: string; packageVersion: string; formId?: string; input?: unknown; taskProposal?: TaskProposal; taskScope?: { scope: FrozenTaskScope; summary: string }; scopeAuthority?: { grantId: string; authorityId: string } };
const permissions = ["read", "execute", "write", "cancel"] as const;
const hash = (value: unknown) => createHash("sha256").update(canonicalActionJson(value)).digest("hex");
const questionSchema = Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), options: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { maxItems: 6 })) }, { additionalProperties: false });
const proposalSchema = Type.Union([Type.Object({ calls: Type.Array(ActionCallSchema, { minItems: 1, maxItems: 10 }) }, { additionalProperties: false }), TaskScopeProposalSchema]);

/** All authority and binding lives in main. OperationRef persists only a package ref or immutable input. */
export class ChatInteractionHost {
  readonly coordinator: ChatInteractionCoordinator;
  private readonly active = new Map<string, string>();
  private readonly listeners = new Set<(conversationId: string) => void>();
  private readonly updating = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly autoOpened = new Set<string>();
  private readonly adapters = new Map<string, OperationAdapter>();
  private readonly pendingOutcomes = new Map<string, { owner: InteractionOwner; invocationId: string; result: unknown }>();
  private readonly taskGrants = new TaskGrantStore();
  private readonly taskDraining = new Set<string>();
  private readonly taskClaims = new Map<string, TaskGrantClaim>();
  private readonly taskEpochs = new Map<string, number>();
  private readonly requestEpochs = new Map<string, number>();
  private readonly interactionEpochs = new Map<string, number>();
  private readonly scopes = new TaskScopeStore();
  private readonly scopeClaims = new Map<string, ScopeClaim>();
  constructor(private readonly repositories: Repositories, private readonly registry: CapabilityRegistry,
    private readonly runtime: () => CapabilityRuntime | undefined,
    private readonly resume: (conversationId: string) => void,
    private readonly outcome: (owner: InteractionOwner, invocationId: string, result: unknown, generation?: number) => void = () => {},
    private readonly openEditor: (conversationId: string, target: ViewRef, generation: number) => Promise<unknown> = async () => ({ status: "blocked" }),
    private readonly navigateEditor: (conversationId: string, target: ViewRef) => Promise<unknown> = async () => ({ status: "blocked" })) {
    this.adapters.set("capability", {
      read: ref => this.readOperation(ref), execute: (ref, _revision, receiptId, version) => this.execute(ref, receiptId, version),
      reconcile: async receiptId => {
        const item = this.repositories.chatInteractions.listRecoverable().find(item => item.receiptId === receiptId);
        const invocation = item && this.repositories.chatCapabilities.invocations(item.conversationId).find(binding => binding.toolCallId === `interaction:${receiptId}`);
        const receipt = invocation && this.repositories.capabilityInvocations.get(invocation.invocationId);
        const result = receipt?.result as { status?: string; presentation?: { text?: string }; taskRef?: { taskId: string }; error?: { message?: string } } | undefined;
        if (result?.status === "accepted" && result.taskRef) return { status: "submitted", summary: result.presentation?.text ?? "任务已提交，尚未完成。", taskId: result.taskRef.taskId };
        if (result?.status === "completed") return { status: "succeeded", summary: result.presentation?.text ?? "操作已完成。" };
        if (result?.status === "error") return { status: "failed", summary: result.error?.message ?? "操作失败。" };
        return "unknown";
      },
      release: async ref => { const binding = this.binding(ref); if (ref.draftRef) await this.provider(binding).release(JSON.parse(ref.draftRef)); },
    });
    this.coordinator = new ChatInteractionCoordinator(repositories.chatInteractions, this.adapters, item => {
      const pending = item.receiptId ? this.pendingOutcomes.get(item.receiptId) : undefined;
      if (pending && ["submitted", "succeeded", "failed", "uncertain"].includes(item.status)) {
        this.pendingOutcomes.delete(item.receiptId!);
        const continuing = this.repositories.chatInteractions.continuations().some(next => next.receiptId === item.receiptId);
        this.outcome(pending.owner, pending.invocationId, pending.result, continuing ? undefined : this.generations.get(item.requestId));
      }
      for (const listener of this.listeners) { try { listener(item.conversationId); } catch { /* isolated UI */ } }
      if (["cancelled", "invalidated", "failed", "uncertain"].includes(item.status)) this.revokeTask(item.conversationId);
      if (!this.taskDraining.has(item.conversationId) && ["answered", "cancelled", "submitted", "succeeded", "failed", "uncertain"].includes(item.status)) {
        void this.restoreContinuations().then(() => this.resume(item.conversationId)).catch(() => {
          // Descriptor remains durable for recovery; the original result remains visible.
        });
      }
    });
  }
  registerAdapter(provider: string, adapter: OperationAdapter): void { if (this.adapters.has(provider)) throw new Error("Provider already registered"); this.adapters.set(provider, adapter); }
  async recover(): Promise<void> { await this.coordinator.recover(); await this.restoreContinuations(); }
  private async restoreContinuations(): Promise<void> {
    for (const next of this.repositories.chatInteractions.continuations()) {
      const original = this.list(next.owner.conversationId).find(item => item.receiptId === next.receiptId);
      if (!original || original.status !== "succeeded") continue;
      const existing = this.list(next.owner.conversationId).find(item => item.payload.kind === "approval" && item.payload.operation.operationId === next.operation.operationId && item.payload.operation.draftRef === next.operation.draftRef);
      if (!existing && this.coordinator.active(next.owner.conversationId)) continue;
      const item = existing ?? await this.coordinator.create(next.owner, { kind: "approval", summary: "", operation: next.operation });
      this.repositories.chatInteractions.consumeContinuation(next.receiptId);
      if (!this.taskDraining.has(next.owner.conversationId)) await this.executeScoped(item);
    }
  }
  begin(requestId: string, conversationId: string): void { this.active.set(requestId, conversationId); this.requestEpochs.set(requestId, this.interactionEpochs.get(conversationId) ?? 0); this.generations.set(requestId, this.runtime()?.navigation.manualGeneration() ?? -1); }
  end(requestId: string): void { this.active.delete(requestId); this.requestEpochs.delete(requestId); }
  private assertFreshRequest(requestId: string): void {
    const conversationId = this.active.get(requestId);
    if (!conversationId || this.requestEpochs.get(requestId) !== (this.interactionEpochs.get(conversationId) ?? 0)) throw new Error("Stale request: 交互已推进，请等待最新结果");
  }
  onChanged(listener: (conversationId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list(conversationId: string) { return this.coordinator.list(conversationId); }
  revokeTask(conversationId: string, invalidateRequests = true): void {
    if (invalidateRequests) this.interactionEpochs.set(conversationId, (this.interactionEpochs.get(conversationId) ?? 0) + 1);
    this.taskGrants.revoke(conversationId);
    this.scopes.revoke(conversationId);
    this.taskEpochs.set(conversationId, (this.taskEpochs.get(conversationId) ?? 0) + 1);
  }
  dispose(): void { this.taskGrants.clear(); this.scopes.clear(); for (const id of this.taskDraining) this.revokeTask(id); }
  taskScope(conversationId: string): FrozenTaskScope | undefined { return this.scopes.active(conversationId); }
  resultFor(item: InteractionRecord): unknown {
    const invocations = this.repositories.chatCapabilities.invocations(item.conversationId);
    const receipt = (record: InteractionRecord) => {
      const invocation = invocations.find(binding => binding.toolCallId === `interaction:${record.receiptId}`);
      return invocation ? this.repositories.capabilityInvocations.get(invocation.invocationId)?.result : undefined;
    };
    const result = receipt(item);
    const records = this.list(item.conversationId);
    const invocationIndex = invocations.findIndex(binding => binding.toolCallId === `interaction:${item.receiptId}`);
    const laterReceipts = new Set(invocations.slice(0, Math.max(0, invocationIndex)).map(binding => binding.toolCallId));
    const following = records.filter(next => laterReceipts.has(`interaction:${next.receiptId}`) && next.requestId === item.requestId
      && next.toolCallId === item.toolCallId && ["succeeded", "submitted", "failed"].includes(next.status)).map(receipt).filter(Boolean);
    // A package continuation may already have executed. Return its real receipts in the
    // same tool result so the current model turn does not repeat the obsolete next step.
    return following.length && result && typeof result === "object" ? { ...result, continuationReceipts: following } : result;
  }
  private async executeScoped(item: InteractionRecord): Promise<InteractionRecord> {
    if (item.status !== "waiting" || item.payload.kind !== "approval" || item.payload.operation.provider !== "capability") return item;
    const frozen = await this.frozen(item.payload.operation);
    const claim = this.scopes.claim(item.conversationId, frozen.call, frozen.binding.packageVersion);
    if (!claim) return item;
    const wasDraining = this.taskDraining.has(item.conversationId); this.taskDraining.add(item.conversationId);
    this.scopeClaims.set(item.payload.operation.operationId, claim);
    try {
      return await this.respond(item.conversationId, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
    } finally {
      this.scopeClaims.delete(item.payload.operation.operationId);
      if (!wasDraining) this.taskDraining.delete(item.conversationId);
    }
  }
  private async approveScope(first: InteractionRecord, authorityId: string): Promise<InteractionRecord> {
    if (first.payload.kind !== "approval") throw new Error("Scope approval unavailable");
    const epoch = this.taskEpochs.get(first.conversationId) ?? 0;
    const binding = this.binding(first.payload.operation); const proposed = binding.taskScope!;
    const { versions: _versions, ...proposal } = proposed.scope;
    const scope = freezeTaskScope(proposal, (cap, action) => this.runtime()?.actionCatalog.find(cap, action));
    if (canonicalActionJson(scope.versions) !== canonicalActionJson(proposed.scope.versions)) throw new Error("任务能力版本已更改");
    const frozen = await this.frozen(first.payload.operation);
    if (canonicalActionJson(frozen.call) !== canonicalActionJson(scope.firstCall) || epoch !== (this.taskEpochs.get(first.conversationId) ?? 0)
      || this.coordinator.get(first.id)?.revision !== first.revision) throw new Error("任务范围已更改，请重新准备并确认");
    this.interactionEpochs.set(first.conversationId, (this.interactionEpochs.get(first.conversationId) ?? 0) + 1);
    this.scopes.activate(first.conversationId, authorityId, scope);
    try {
      const result = await this.executeScoped(first);
      if (result.status !== "succeeded") this.revokeTask(first.conversationId);
      await this.restoreContinuations(); this.resume(first.conversationId); return result;
    } catch (error) { this.revokeTask(first.conversationId); throw error; }
  }
  /** Called only by real-user message ingress. The tool surface cannot call this method. */
  async respondToTask(conversationId: string, command: RespondCommand, userMessageId: string): Promise<InteractionRecord> {
    const message = this.repositories.messages.listByConversation(conversationId as never).find(item => item.id === userMessageId);
    const item = this.coordinator.get(command.interactionId);
    if (item?.conversationId === conversationId && item.payload.kind === "approval" && this.scopes.active(conversationId)
      && !this.taskDraining.has(conversationId) && !this.scopeClaims.has(item.payload.operation.operationId)) this.revokeTask(conversationId);
    if (!message || message.role !== "user" || classifyTaskDecision(message.content) !== "approve_task"
      || !item || message.createdAt < item.createdAt) throw new Error("任务授权必须来自真实用户消息");
    return this.approveTask(conversationId, command, userMessageId, "user_message");
  }
  private async approveTask(conversationId: string, command: RespondCommand, authorityId: string, source: "chat_button" | "form_button" | "user_message"): Promise<InteractionRecord> {
    const first = this.coordinator.get(command.interactionId);
    if (!first || first.conversationId !== conversationId || first.status !== "waiting" || first.revision !== command.expectedRevision
      || first.payload.kind !== "approval" || command.response.kind !== "decision" || command.response.decision !== "approve"
      || this.taskDraining.has(conversationId)) throw new Error("本次授权没有绑定当前待确认提案");
    const epoch = this.taskEpochs.get(conversationId) ?? 0;
    if (first.payload.operation.provider !== "capability") return this.respond(conversationId, command, source);
    const binding = this.binding(first.payload.operation);
    if (binding.taskScope) return this.approveScope(first, authorityId);
    const frozen = await this.frozen(first.payload.operation);
    const declaration = this.runtime()!.actionCatalog.find(binding.capabilityId, binding.actionId)!.declaration;
    // Older packages still receive exactly one ordinary approval, never an implicit future grant.
    if (declaration.taskAuthorization?.mode !== "exact_input" && !binding.taskProposal) return this.respond(conversationId, command, source);
    const proposal = binding.taskProposal ?? { id: first.id, calls: this.taskCalls([frozen.call]), remainingSummary: "" };
    const current = this.coordinator.get(first.id);
    if ((this.taskEpochs.get(conversationId) ?? 0) !== epoch || current?.revision !== first.revision || current.status !== "waiting"
      || exactTaskCallDigest(frozen.call, binding.packageVersion) !== proposal.calls[0]?.digest) throw new Error("提案已更改，请重新确认具体内容");
    // Revalidate current catalog admission/contracts for every exact call before granting.
    const calls = this.taskCalls(proposal.calls.map(item => item.call));
    if (calls.some((item, index) => item.digest !== proposal.calls[index]?.digest)) throw new Error("提案的动作版本已更改");
    this.taskGrants.activate(conversationId, proposal.id, authorityId, calls);
    this.taskDraining.add(conversationId);
    let item: InteractionRecord = first;
    const completedIds: string[] = [];
    let lastResultId: string | undefined;
    try {
      for (let index = 0; index < calls.length; index++) {
        const entry = calls[index]!;
        if ((this.taskEpochs.get(conversationId) ?? 0) !== epoch) break;
        if (index > 0) {
          await this.restoreContinuations();
          if ((this.taskEpochs.get(conversationId) ?? 0) !== epoch) break;
          item = this.coordinator.active(conversationId) ?? await this.prepareApproval({ ...binding.owner, toolCallId: `${binding.owner.toolCallId}:proposal:${index}` }, entry.call);
        }
        if (item.status !== "waiting" || item.payload.kind !== "approval") break;
        const actual = await this.frozen(item.payload.operation);
        if (exactTaskCallDigest(actual.call, actual.binding.packageVersion) !== entry.digest) break;
        const claim = this.taskGrants.claim(conversationId, proposal.id, entry.digest);
        if (!claim) break;
        this.taskClaims.set(item.payload.operation.operationId, claim);
        try { item = await this.respond(conversationId, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, source); }
        finally { this.taskClaims.delete(item.payload.kind === "approval" ? item.payload.operation.operationId : ""); }
        if (["succeeded", "failed", "uncertain", "cancelled", "submitted"].includes(item.status)) lastResultId = item.id;
        if (item.status !== "succeeded") break;
        completedIds.push(item.id);
      }
      return item;
    } finally {
      this.revokeTask(conversationId);
      this.taskDraining.delete(conversationId);
      // Keep each durable receipt; one final event resumes the model with all results in context.
      const earlier = new Set(completedIds.filter(id => id !== lastResultId));
      for (const event of this.repositories.chatInteractions.pendingEvents(conversationId)) if (earlier.has(event.interactionId) && this.repositories.chatInteractions.claimEvent(event.id)) this.repositories.chatInteractions.consumeEvent(event.id);
      await this.restoreContinuations();
      this.resume(conversationId);
    }
  }
  private taskCalls(calls: readonly ActionCall[]): ExactTaskCall[] {
    return snapshotExactTaskCalls(calls.map(call => {
      const entry = this.runtime()?.actionCatalog.find(call.capabilityId, call.actionId);
      if (!entry || entry.declaration.contractDigest !== call.contractDigest) throw new Error("Action contract changed");
      return { call, packageVersion: entry.packageVersion, ...entry.declaration };
    }));
  }
  private async taskSummary(call: ActionCall): Promise<string> {
    const presentation = await this.runtime()!.actionGateway.preview(call, { callerId: "chat-window", source: "chat", permissions });
    return `${presentation.title}\n${presentation.fields.map(field => `${field.label}：${field.value}`).join("\n")}`;
  }
  private async propose(owner: InteractionOwner, calls: ActionCall[]): Promise<InteractionRecord> {
    if (this.coordinator.active(owner.conversationId)) throw new Error("请先处理当前待确认内容");
    const epoch = this.taskEpochs.get(owner.conversationId) ?? 0;
    const entries = this.taskCalls(calls);
    const summaries = await Promise.all(entries.map(item => this.taskSummary(item.call)));
    if (summaries.join("\n").length > 20000) throw new Error("提案内容过长，请缩小本次操作范围");
    if ((this.taskEpochs.get(owner.conversationId) ?? 0) !== epoch || this.active.get(owner.requestId) !== owner.conversationId) throw new Error("提案请求已结束");
    return this.prepareApproval(owner, entries[0]!.call, { id: randomUUID(), calls: entries, remainingSummary: summaries.slice(1).map((summary, index) => `${index + 2}. ${summary}`).join("\n\n") }, undefined, true);
  }
  async openEditorManually(conversationId: string, interactionId: string): Promise<unknown> {
    const item = this.owned(conversationId, interactionId);
    if (!["waiting", "editing"].includes(item.status)) throw new Error("Editor is no longer pending");
    const binding = this.binding(item.payload.operation);
    const editor = await this.readEditor(conversationId, interactionId);
    const current = this.owned(conversationId, interactionId);
    if (current.revision !== item.revision || !["waiting", "editing"].includes(current.status)) throw new Error("Editor changed while opening");
    if (!Value.Check(ViewRefSchema, editor.form.view) || editor.form.view.capabilityId !== binding.capabilityId
      || editor.form.draft.capabilityId !== binding.capabilityId) throw new Error("Editor capability mismatch");
    // The live provider view may change with the draft revision. Authorize that exact owned view,
    // then use the ordinary conversation navigation path and its current-page dirty guards.
    this.repositories.chatCapabilities.saveViews(conversationId, item.requestId, [editor.form.view]);
    return this.navigateEditor(conversationId, editor.form.view);
  }
  async autoOpenEditor(conversationId: string, interactionId: string): Promise<unknown> {
    const item = this.owned(conversationId, interactionId);
    const generation = this.generations.get(item.requestId);
    if (generation === undefined || this.autoOpened.has(interactionId) || !["waiting", "editing"].includes(item.status)) return { status: "blocked" };
    this.autoOpened.add(interactionId);
    if (!item.payload.operation.draftRef) {
      const binding = this.binding(item.payload.operation);
      const presentation = await this.registry.publicAction(binding.capabilityId, binding.actionId)?.presentOperation?.(binding.input);
      if (!presentation?.autoOpen || !Value.Check(ViewRefSchema, presentation.target) || presentation.target.capabilityId !== binding.capabilityId) return { status: "unsupported" };
      this.repositories.chatCapabilities.saveViews(conversationId, item.requestId, [presentation.target]);
      return this.openEditor(conversationId, presentation.target, generation);
    }
    const editor = await this.readEditor(conversationId, interactionId);
    return this.openEditor(conversationId, editor.form.view, generation);
  }
  async respond(conversationId: string, command: RespondCommand, source: "chat_button" | "form_button" | "user_message", userMessageId?: string): Promise<InteractionRecord> {
    if (command.response.kind === "decision" && command.response.decision === "cancel") this.revokeTask(conversationId);
    const item = this.coordinator.get(command.interactionId);
    if (item?.conversationId === conversationId && item.payload.kind === "approval" && this.scopes.active(conversationId)
      && !this.taskDraining.has(conversationId) && !this.scopeClaims.has(item.payload.operation.operationId)) this.revokeTask(conversationId);
    if (item?.conversationId === conversationId && item.payload.kind === "approval" && item.payload.operation.provider === "capability" && command.response.kind === "decision"
      && command.response.decision === "approve" && !this.taskDraining.has(conversationId) && (this.binding(item.payload.operation).taskProposal || this.binding(item.payload.operation).taskScope)) {
      if (source === "user_message") {
        const message = this.repositories.messages.listByConversation(conversationId as never).find(entry => entry.id === userMessageId);
        if (!message || message.role !== "user" || message.createdAt < item.createdAt
          || (classifyExplicitDecision(message.content) !== "approve" && !classifyTaskDecision(message.content))) throw new Error("提案确认必须来自当前真实用户消息");
      }
      return this.approveTask(conversationId, command, userMessageId ?? `${source}:${item.id}:${item.revision}`, source);
    }
    if (item?.conversationId === conversationId && item.revision !== command.expectedRevision) throw new Error("Stale interaction revision");
    if (item?.conversationId === conversationId && item.status === "waiting" && item.payload.kind === "approval" && item.payload.operation.draftRef
      && command.response.kind === "decision" && command.response.decision === "approve") {
      const ref = item.payload.operation; const provider = this.provider(this.binding(ref)); const draft = JSON.parse(ref.draftRef!);
      if (!(await provider.read(draft)).readyToSubmit || !(await provider.validate(draft)).valid) throw new Error("请先完成表单并修正校验问题");
    }
    if (!(item?.payload.kind === "approval" && this.scopeClaims.has(item.payload.operation.operationId))) this.interactionEpochs.set(conversationId, (this.interactionEpochs.get(conversationId) ?? 0) + 1);
    return this.coordinator.respond(command, { conversationId, source });
  }
  assertInvocationAllowed(requestId: string, call: ActionCall): void {
    const declaration = this.runtime()?.actionCatalog.find(call.capabilityId, call.actionId)?.declaration;
    if (declaration?.effects.data !== "read" || declaration.effects.consumesResources) this.assertFreshRequest(requestId);
    if (!requestId.startsWith("interaction-resume:")) return;
    const conversationId = this.active.get(requestId);
    if (conversationId && this.list(conversationId).some(item => item.status === "cancelled" && item.payload.kind === "approval" && item.payload.operation.provider === "capability"
      && (() => { const binding = JSON.parse(item.payload.operation.operationId) as Binding; return binding.capabilityId === call.capabilityId && binding.actionId === call.actionId; })())) throw new Error("Cancelled operation cannot be automatically retried");
  }
  async releaseConversation(conversationId: string): Promise<void> {
    this.revokeTask(conversationId);
    const items = this.list(conversationId);
    if (items.some(item => item.status === "executing")) throw new Error("An operation is executing");
    for (const item of items) {
      if (["waiting", "editing"].includes(item.status)) this.repositories.chatInteractions.invalidate(item.id, item.revision, "Conversation removed");
      if (item.payload.kind === "approval") {
        try { await this.adapters.get(item.payload.operation.provider)?.release?.(item.payload.operation); } catch { /* Deletion still removes the owner. */ }
      }
    }
    for (const [requestId, owner] of this.active) if (owner === conversationId) this.active.delete(requestId);
  }
  async call(requestId: string, toolCallId: string, operation: "question" | "draft.read" | "draft.update" | "draft.transition" | "proposal.create", args: unknown): Promise<unknown> {
    const conversationId = this.active.get(requestId);
    if (!conversationId) throw new Error("Inactive request");
    if (operation !== "draft.read") this.assertFreshRequest(requestId);
    if (operation === "proposal.create") {
      if (!Value.Check(proposalSchema, args)) throw new Error("Invalid concrete proposal");
      if ("calls" in args) return this.propose({ conversationId, requestId, toolCallId }, args.calls);
      return this.proposeScope({ conversationId, requestId, toolCallId }, args);
    }
    if (operation === "question") {
      if (!Value.Check(questionSchema, args)) throw new Error("Invalid question");
      return this.coordinator.create({ conversationId, requestId, toolCallId }, { kind: "question", ...args, allowFreeText: true });
    }
    const item = this.coordinator.active(conversationId);
    if (!item || item.payload.kind !== "approval") throw new Error("No bound approval draft");
    if (operation === "draft.read") return this.readEditor(conversationId, item.id);
    const input = args as { expectedRevision?: number; patch?: unknown; transitionId?: string };
    if (item.status !== "waiting" || !Number.isInteger(input?.expectedRevision)) throw new Error("Draft is being edited");
    if (operation === "draft.transition" && !input.transitionId) throw new Error("Transition required");
    return this.updateEditor(conversationId, item.id, input.expectedRevision!, input.patch, operation === "draft.transition" ? input.transitionId : undefined, true);
  }
  async requestApproval(owner: InteractionOwner, call: ActionCall): Promise<InteractionRecord> {
    this.assertFreshRequest(owner.requestId);
    const item = await this.prepareApproval(owner, call, undefined, undefined, true);
    this.assertFreshRequest(owner.requestId);
    const result = await this.executeScoped(item);
    await this.restoreContinuations();
    return result;
  }
  private async proposeScope(owner: InteractionOwner, proposal: TaskScopeProposal): Promise<InteractionRecord> {
    if (this.coordinator.active(owner.conversationId) || this.scopes.active(owner.conversationId)) throw new Error("请先完成当前任务，不能扩大已有授权");
    const scope = freezeTaskScope(proposal, (cap, action) => this.runtime()?.actionCatalog.find(cap, action));
    const lines: string[] = [];
    for (const rule of scope.rules) {
      const entry = this.runtime()!.actionCatalog.find(rule.call.capabilityId, rule.call.actionId)!;
      const dynamic = rule.dynamicFields ?? []; const bindings = Object.entries(rule.bindings ?? {});
      const policy = entry.declaration.taskAuthorization;
      if (policy?.mode !== "scope") throw new Error("Scope unavailable");
      const presented = await this.registry.publicAction(rule.call.capabilityId, rule.call.actionId)?.presentTaskScope?.(rule.call.input as Record<string, unknown>);
      const detail = presented ? `${presented.title}\n${presented.fields.map(field => `${field.label}：${field.value}`).join("\n")}`
        : !dynamic.length && !bindings.length ? await this.taskSummary(rule.call)
        : `${entry.declaration.title}\n${Object.entries(rule.call.input as Record<string, unknown>).map(([field, value]) => `${policy.fieldLabels?.[field] ?? field}：${JSON.stringify(value)}`).join("\n")}`;
      const selection = dynamic.length ? `\n执行中确定：${dynamic.map(field => policy.fieldLabels?.[field] ?? field).join("、")}` : "";
      const resources = bindings.length ? `\n${bindings.map(([field, ref]) => `${policy.fieldLabels?.[field] ?? "目标资源"}：仅限第 ${scope.rules.findIndex(item => item.id === ref.ruleId) + 1} 项成功创建的资源`).join("；")}` : "";
      lines.push(`${lines.length + 1}. ${detail}${selection}${resources}\n最多 ${rule.maxExecutions} 次；${entry.declaration.effects.data === "destructive" ? "破坏性操作，仅限以上精确对象；" : ""}${entry.declaration.effects.consumesResources ? policy.resourceDescription ?? "可能调用模型/搜索并消耗资源。" : "不消耗模型/搜索资源。"}`);
    }
    this.assertFreshRequest(owner.requestId);
    const summary = `本次任务范围：\n${lines.join("\n\n")}\n\n结束条件：${scope.endCondition}\n确认后本任务内符合上述范围的后续参数可由执行结果确定并自动执行。完成、取消、失败、新任务或重启即结束授权；修改表单需重新确认。请确认一次。`;
    if (summary.length > 20000) throw new Error("任务范围过长");
    return this.prepareApproval(owner, scope.firstCall, undefined, { scope, summary }, true);
  }
  private async prepareApproval(owner: InteractionOwner, call: ActionCall, taskProposal?: TaskProposal, taskScope?: Binding["taskScope"], requestBound = false): Promise<InteractionRecord> {
    const active = this.coordinator.active(owner.conversationId);
    if (active) return active;
    const entry = this.runtime()?.actionCatalog.find(call.capabilityId, call.actionId);
    if (!entry) throw new Error("Capability unavailable");
    const form = this.registry.forms(call.capabilityId).find(item => item.actionIds.includes(call.actionId));
    const binding: Binding = { owner, capabilityId: call.capabilityId, actionId: call.actionId, contractDigest: call.contractDigest, packageVersion: entry.packageVersion,
      ...(this.scopes.authority(owner.conversationId) ? { scopeAuthority: this.scopes.authority(owner.conversationId)! } : {}),
      ...(form ? { formId: form.id } : { input: structuredClone(call.input) }), ...(taskProposal ? { taskProposal } : {}), ...(taskScope ? { taskScope } : {}) };
    const snapshot = form ? await this.provider(binding).prepare(form.id, call.actionId, call.input) : undefined;
    const ref = this.ref(binding, snapshot);
    if (snapshot) this.repositories.chatCapabilities.saveViews(owner.conversationId, owner.requestId, [snapshot.view]);
    return this.coordinator.create(owner, { kind: "approval", summary: "", operation: ref }, requestBound ? () => this.assertFreshRequest(owner.requestId) : undefined);
  }
  private ref(binding: Binding, snapshot?: CapabilityFormSnapshot): OperationRef {
    return { provider: "capability", operationId: JSON.stringify(binding), contractVersion: binding.contractDigest, ...(snapshot ? { draftRef: JSON.stringify(snapshot.draft) } : {}) };
  }
  private binding(ref: OperationRef): Binding {
    if (ref.provider !== "capability") throw new Error("No capability editor");
    const binding = JSON.parse(ref.operationId) as Binding;
    const entry = this.runtime()?.actionCatalog.find(binding.capabilityId, binding.actionId);
    if (!entry || entry.packageVersion !== binding.packageVersion || entry.declaration.contractDigest !== binding.contractDigest || ref.contractVersion !== binding.contractDigest) throw new Error("Contract changed");
    return binding;
  }
  private provider(binding: Binding) {
    const provider = this.registry.formProvider(binding.capabilityId);
    if (!provider || !binding.formId || !this.registry.forms(binding.capabilityId).some(form => form.id === binding.formId)) throw new Error("Package has no editable form bridge");
    return provider;
  }
  private async frozen(ref: OperationRef) {
    const binding = this.binding(ref);
    let input = binding.input; let actionId = binding.actionId; let draftVersion: string | undefined;
    if (ref.draftRef) {
      const submission = await this.provider(binding).submission(JSON.parse(ref.draftRef));
      if (submission.actionId !== binding.actionId) throw new Error("Submission action differs from approved action");
      input = submission.input; actionId = submission.actionId; draftVersion = submission.revision;
    }
    const entry = this.runtime()!.actionCatalog.find(binding.capabilityId, actionId);
    if (!entry || entry.packageVersion !== binding.packageVersion) throw new Error("Action unavailable");
    const call: ActionCall = { capabilityId: binding.capabilityId, actionId, contractDigest: entry.declaration.contractDigest, input: structuredClone(input) };
    return { binding, call, version: hash({ call, draftVersion: draftVersion ?? null }) };
  }
  private async readOperation(ref: OperationRef) {
    const binding = this.binding(ref);
    if (binding.taskScope) return { version: (await this.frozen(ref)).version, summary: binding.taskScope.summary };
    const declared = this.runtime()!.actionCatalog.find(binding.capabilityId, binding.actionId)!.declaration.taskAuthorization;
    if (declared || binding.taskProposal) {
      const snapshot = ref.draftRef ? await this.provider(binding).read(JSON.parse(ref.draftRef)) : undefined;
      if (snapshot && !snapshot.readyToSubmit) return { version: hash({ draft: snapshot.draft, contract: ref.contractVersion }), summary: "请先补全表单内容；修改后的提案需要重新确认。" };
      const frozen = await this.frozen(ref);
      const summary = await this.taskSummary(frozen.call);
      const version = snapshot ? hash({ draft: snapshot.draft, contract: ref.contractVersion }) : frozen.version;
      return { version, summary: binding.taskProposal ? `本次具体操作（共 ${binding.taskProposal.calls.length} 项）：\n1. ${summary}${binding.taskProposal.remainingSummary ? `\n\n${binding.taskProposal.remainingSummary}` : ""}\n\n确认将执行以上全部具体操作；可回复“本次一路确认”或“确认无误”。完成、取消或新任务后授权结束。` : summary };
    }
    if (ref.draftRef) {
      const snapshot = await this.provider(binding).read(JSON.parse(ref.draftRef));
      const title = this.runtime()!.actionCatalog.find(binding.capabilityId, binding.actionId)!.declaration.title;
      return { version: hash({ draft: snapshot.draft, contract: ref.contractVersion }), summary: snapshot.summary ?? `${title}${snapshot.readyToSubmit ? "：请核对表单内容后确认。" : "：请先补全表单内容。"}` };
    }
    const frozen = await this.frozen(ref);
    const action = this.registry.publicAction(frozen.call.capabilityId, frozen.call.actionId);
    const presented = action?.presentInput ? await action.presentInput(frozen.call.input) : undefined;
    const summary = presented ? `${presented.title}\n${presented.fields.map(field => `${field.label}：${field.value}`).join("\n")}` : this.runtime()!.actionCatalog.find(binding.capabilityId, binding.actionId)!.declaration.title;
    return { version: frozen.version, summary };
  }
  private async execute(ref: OperationRef, receiptId: string, expectedVersion: string): Promise<OperationResult> {
    if ((await this.readOperation(ref)).version !== expectedVersion) return { status: "failed", summary: "内容已更改，请重新确认。" };
    const binding = this.binding(ref);
    if (ref.draftRef) {
      const provider = this.provider(binding); const draft = JSON.parse(ref.draftRef);
      if (!(await provider.read(draft)).readyToSubmit || !(await provider.validate(draft)).valid) return { status: "failed", summary: "表单校验失败，请修正后重试。" };
    }
    const frozen = await this.frozen(ref);
    if ((await this.readOperation(ref)).version !== expectedVersion) return { status: "failed", summary: "内容已更改，请重新确认。" };
    const runtime = this.runtime()!;
    // Fresh invocation and short-lived single-use ticket bind exactly the frozen final input.
    const context = runtime.actionGateway.issue(frozen.call, { callerId: "chat-window", source: "chat", sessionId: frozen.binding.owner.conversationId, permissions, requireConfirmation: true });
    this.repositories.chatCapabilities.bindInvocation({ conversationId: frozen.binding.owner.conversationId, sourceRequestId: frozen.binding.owner.requestId,
      toolCallId: `interaction:${receiptId}`, callDigest: hash(frozen.call), invocationId: context.invocationId });
    const pending = await runtime.actionGateway.invoke(frozen.call, context);
    if (pending.status !== "requires_confirmation") throw new Error("Fresh confirmation unavailable");
    const taskClaim = this.taskClaims.get(ref.operationId);
    const scopeClaim = this.scopeClaims.get(ref.operationId);
    const valid = () => (!taskClaim || this.taskGrants.valid(taskClaim)) && (!scopeClaim || this.scopes.valid(scopeClaim));
    if (scopeClaim && (!valid() || scopeClaim.digest !== exactTaskCallDigest(frozen.call, frozen.binding.packageVersion))) {
      runtime.actionConfirmations.dismiss(pending.confirmationRef, context);
      return { status: "failed", summary: "任务范围已撤销，未执行操作。" };
    }
    if (taskClaim && (!this.taskGrants.valid(taskClaim) || taskClaim.digest !== exactTaskCallDigest(frozen.call, frozen.binding.packageVersion))) {
      runtime.actionConfirmations.dismiss(pending.confirmationRef, context);
      return { status: "failed", summary: "本次任务授权已撤销，未执行操作。" };
    }
    const token = runtime.actionConfirmations.approve(pending.confirmationRef, context);
    if (!token) throw new Error("Confirmation unavailable");
    const result = await runtime.actionGateway.invoke(frozen.call, { ...context, confirmationToken: token }, taskClaim || scopeClaim ? valid : undefined);
    if (scopeClaim) this.scopes.record(scopeClaim, result);
    this.pendingOutcomes.set(receiptId, { owner: frozen.binding.owner, invocationId: context.invocationId, result });
    if (result.status === "completed" && ref.draftRef) {
      try {
      const next = await this.provider(frozen.binding).afterAction?.(JSON.parse(ref.draftRef), frozen.call.actionId, result);
      if (next) {
        const entry = runtime.actionCatalog.find(frozen.call.capabilityId, next.nextActionId);
        if (!entry || !this.registry.forms(frozen.binding.capabilityId).some(form => form.id === frozen.binding.formId && form.actionIds.includes(next.nextActionId))) throw new Error("Next action unavailable");
        const { taskProposal: _proposal, taskScope: _scope, ...nextBinding } = frozen.binding;
        const authority = this.scopes.authority(frozen.binding.owner.conversationId);
        this.repositories.chatInteractions.stageContinuation(receiptId, frozen.binding.owner, this.ref({ ...nextBinding, ...(authority ? { scopeAuthority: authority } : {}), actionId: next.nextActionId, contractDigest: entry.declaration.contractDigest }, next.snapshot));
      }
      } catch {
        return { status: "succeeded", summary: `${result.presentation?.text ?? "操作已完成。"} 后续表单准备失败，请重新打开表单；不要重复执行已完成的操作。` };
      }
    }
    if (result.status === "accepted") return { status: "submitted", summary: result.presentation?.text ?? "任务已提交，尚未完成。", taskId: result.taskRef.taskId };
    if (result.status === "completed") return { status: "succeeded", summary: result.presentation?.text ?? "操作已完成。" };
    if (result.status === "error") {
      if (runtime.actionGateway.requiresReconciliation(context.invocationId)) throw new Error("Execution uncertain");
      return { status: "failed", summary: result.error.message };
    }
    throw new Error("Execution uncertain");
  }
  private owned(conversationId: string, id: string) {
    const item = this.coordinator.get(id);
    if (!item || item.conversationId !== conversationId || item.payload.kind !== "approval") throw new Error("Editor binding mismatch");
    return item as InteractionRecord & { payload: Extract<InteractionRecord["payload"], { kind: "approval" }> };
  }
  async readEditor(conversationId: string, id: string): Promise<InteractionEditorState> {
    const item = this.owned(conversationId, id); const binding = this.binding(item.payload.operation);
    if (!item.payload.operation.draftRef) throw new Error("Package has no editable form bridge");
    const form = await this.provider(binding).read(JSON.parse(item.payload.operation.draftRef));
    return { interaction: item, formId: binding.formId!, actionId: binding.actionId, form };
  }
  beginEdit(conversationId: string, id: string, revision: number, modelOwned = false) {
    this.revokeTask(conversationId, !modelOwned);
    const item = this.owned(conversationId, id);
    if (item.revision !== revision || item.status !== "waiting") throw new Error("Stale editor revision");
    if (!item.payload.operation.draftRef) throw new Error("Package has no editable form bridge");
    return this.coordinator.beginEdit(id, revision);
  }
  async updateEditor(conversationId: string, id: string, revision: number, patch: unknown, transition?: string, modelOwned = false): Promise<InteractionEditorState> {
    if (this.updating.has(id)) throw new Error("Draft update in progress");
    this.updating.add(id);
    try {
    let item = this.owned(conversationId, id);
    if (item.revision !== revision || !["waiting", "editing"].includes(item.status)) throw new Error("Stale editor revision");
    const acquiredModelLock = modelOwned && item.status === "waiting";
    if (item.status === "waiting") item = this.beginEdit(conversationId, id, revision, modelOwned) as typeof item;
    if (item.status !== "editing" || !item.payload.operation.draftRef) throw new Error("Editor unavailable");
    let binding = this.binding(item.payload.operation); const provider = this.provider(binding);
    if (binding.taskScope) { const { taskScope: _scope, ...singleOperation } = binding; binding = singleOperation; }
    const draft = JSON.parse(item.payload.operation.draftRef) as DraftRef;
    const before = acquiredModelLock ? canonicalActionJson(await provider.read(draft)) : undefined;
    let form: CapabilityFormSnapshot;
    try { form = transition ? await provider.transition(draft, transition) : await provider.update(draft, patch); }
    catch (error) {
      if (acquiredModelLock && before !== undefined) {
        try {
          const after = await provider.read(draft);
          const current = this.coordinator.get(id);
          if (canonicalActionJson(after) === before && current?.status === "editing" && current.revision === item.revision) {
            await this.coordinator.completeEdit(id, item.revision);
          }
        } catch { /* Unreadable or changed provider state retains its lock; never infer rollback. */ }
      }
      throw error;
    }
    if (binding.taskProposal && form.readyToSubmit) {
      const changed = await this.frozen(this.ref(binding, form));
      const calls = this.taskCalls([changed.call, ...binding.taskProposal.calls.slice(1).map(entry => entry.call)]);
      binding = { ...binding, taskProposal: { ...binding.taskProposal, id: randomUUID(), calls } };
    }
    await this.coordinator.completeEdit(id, item.revision, this.ref(binding, form));
    return this.readEditor(conversationId, id);
    } finally { this.updating.delete(id); }
  }
}
