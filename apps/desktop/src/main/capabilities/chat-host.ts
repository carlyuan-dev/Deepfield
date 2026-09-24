import { createHash, randomUUID } from "node:crypto";
import type { AgentWorkerEvent, ConversationId } from "@deepfield/contracts";
import { Value } from "typebox/value";
import {
  ActionCallSchema, ArtifactRefSchema, DraftRefSchema, TaskRefSchema, ViewRefSchema,
  canonicalActionJson, type ActionCall, type OperationPresentation, type TaskSnapshot, type ViewRef, type DraftRef,
} from "@deepfield/capability-sdk";
import type { Repositories } from "@deepfield/persistence";
import { capabilityDescriptionKey, requestedCompletionAnalysis, taskEventId, type CapabilityDirectoryEntry } from "@deepfield/application";
import { safeGatewayError } from "./gateway-policy.js";
import type { CapabilityRegistry } from "./registry.js";
import type { CapabilityRuntime } from "./runtime.js";
import type { TrustedActionContext } from "./action-confirmations.js";
import type { ChatInteractionHost } from "../chat/interaction-host.js";

type ToolOperation = "describe" | "invoke" | "task.get" | "task.cancel" | "read" | "open";
type PendingConfirmation = { call: ActionCall; context: TrustedActionContext; conversationId: string; sourceRequestId: string; prompt: string; inputSummary: unknown; presentation?: OperationPresentation };
const permissions = ["read", "execute", "write", "cancel"] as const;
const wantsCancellation = (text: string): boolean =>
  !/(?:不要|别|不必).{0,8}(?:取消|停止)|(?:do not|don't).{0,12}cancel/iu.test(text)
  && /(?:取消|停止).{0,12}(?:任务|操作|执行|作业)|(?:任务|操作|执行|作业).{0,12}(?:取消|停止)|(?:cancel|stop).{0,12}(?:task|job|operation)|(?:task|job|operation).{0,12}(?:cancel|stop)/iu.test(text);
const wantsOpen = (text: string): boolean =>
  !/(?:不要|别|不必).{0,8}(?:打开|查看|展示|显示)|(?:do not|don't).{0,12}(?:open|show|view)/iu.test(text)
  && /(?:打开|查看|展示|显示|给我看|填写|open|show|view|display|fill)/iu.test(text);

/** Main owns every identity and gateway. Worker/model arguments carry no authority. */
export class CapabilityChatHost {
  private readonly active = new Map<string, { conversationId: string; prompt: string; restoredKeys: Set<string>; describedThisTurn: Set<string>; navigation: AbortController }>();
  private conversationNavigation = new AbortController();
  private readonly invocations = new Map<string, { call: ActionCall; context: TrustedActionContext }>();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(conversationId: string) => void>();
  private readonly streamListeners = new Set<(conversationId: string, event: AgentWorkerEvent) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private invokeQueue: Promise<void> = Promise.resolve();
  private activeConversationId: string | undefined;
  private readonly autoOpened = new Set<string>();
  private readonly operationGeneration = new Map<string, number>();
  private readonly autoNavigation = new Map<string, Promise<void>>();

  constructor(private readonly runtime: () => CapabilityRuntime | undefined,
    private readonly registry: CapabilityRegistry, private readonly repositories: Repositories,
    private readonly interactions?: ChatInteractionHost) {
    this.repositories.chatCapabilities.interruptRunningAnalysis();
    this.repositories.chatCapabilities.interruptPendingOperations();
  }

  directory(): CapabilityDirectoryEntry[] {
    const runtime = this.runtime();
    if (!runtime) return [];
    const names = new Map(runtime.list().filter(item => item.status === "ready").map(item => [item.id, item.name]));
    return runtime.actionCatalog.list().filter(entry => names.has(entry.capabilityId)).map(entry => ({
      capabilityId: entry.capabilityId, capabilityName: names.get(entry.capabilityId)!, packageVersion: entry.packageVersion,
      actionId: entry.actionId, title: entry.declaration.title, description: entry.declaration.description,
      mode: entry.declaration.mode, effects: entry.declaration.effects, contractDigest: entry.declaration.contractDigest,
    }));
  }

  helpDirectory() { return this.runtime()?.helpEntries() ?? []; }

  begin(chatRequestId: string, conversationId: string, prompt: string, restoredKeys: readonly string[] = []): void {
    this.active.get(chatRequestId)?.navigation.abort();
    this.active.set(chatRequestId, { conversationId, prompt, restoredKeys: new Set(restoredKeys), describedThisTurn: new Set(), navigation: new AbortController() });
  }
  end(chatRequestId: string): void {
    this.active.get(chatRequestId)?.navigation.abort();
    this.active.delete(chatRequestId);
    for (const key of this.invocations.keys()) if (key.startsWith(`${chatRequestId}\0`)) this.invocations.delete(key);
  }
  setActiveConversation(conversationId: string): void {
    if (this.activeConversationId === conversationId) return;
    this.conversationNavigation.abort();
    this.conversationNavigation = new AbortController();
    this.activeConversationId = conversationId;
    this.notify(conversationId);
  }
  isActiveConversation(conversationId: string): boolean { return this.activeConversationId === conversationId; }
  onTasks(listener: (conversationId: string) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  announce(conversationId: string): void { this.notify(conversationId); }
  onAutoEvents(listener: (conversationId: string, event: AgentWorkerEvent) => void): () => void {
    this.streamListeners.add(listener); return () => this.streamListeners.delete(listener);
  }
  emitAuto(conversationId: string, event: AgentWorkerEvent): void {
    for (const listener of this.streamListeners) { try { listener(conversationId, event); } catch { /* UI isolation */ } }
  }
  tasks(conversationId: string) {
    const bindings = this.repositories.chatCapabilities.invocations(conversationId);
    const receipts = this.repositories.chatInteractions.list(conversationId).flatMap(interaction => {
      if (!interaction.receiptId || !interaction.taskId) return [];
      const binding = bindings.find(binding => binding.sourceRequestId === interaction.requestId && binding.toolCallId === `interaction:${interaction.receiptId}`);
      const receipt = binding && this.repositories.capabilityInvocations.get(binding.invocationId);
      return receipt?.state === "completed" && receipt.taskId === interaction.taskId ? [{ interaction, receipt }] : [];
    });
    return this.repositories.chatCapabilities.tasks(conversationId).map(card => {
      const owner = receipts.find(({ interaction, receipt }) => interaction.requestId === card.sourceRequestId
        && receipt.capabilityId === card.snapshot.taskRef.capabilityId && receipt.taskId === card.snapshot.taskRef.taskId);
      return { ...card, ...(owner ? { interactionId: owner.interaction.id } : {}) };
    });
  }
  operations(conversationId: string) {
    const bindings = this.repositories.chatCapabilities.invocations(conversationId);
    const interactions = this.repositories.chatInteractions.list(conversationId);
    return this.repositories.chatCapabilities.operations(conversationId).filter(item => item.status !== "awaiting_confirmation").map(item => {
      const binding = bindings.find(binding => binding.invocationId === item.invocationId);
      const interaction = interactions.find(interaction => interaction.receiptId && binding?.toolCallId === `interaction:${interaction.receiptId}`);
      return { ...item, ...(interaction ? { interactionId: interaction.id } : {}) };
    });
  }
  views(conversationId: string) { return this.repositories.chatCapabilities.views(conversationId); }
  pendingConfirmations(conversationId: string) {
    for (const [ref, item] of this.confirmations) if (!this.runtime()?.actionConfirmations.inspect(ref, item.context)) {
      this.clearConfirmation(ref);
      this.repositories.chatCapabilities.saveOperation({ conversationId: item.conversationId, sourceRequestId: item.sourceRequestId,
        invocationId: item.context.invocationId, status: "interrupted", title: this.confirmationTitle(item.inputSummary),
        presentation: { text: "确认已失效，操作未执行。" } });
      this.operationGeneration.delete(item.context.invocationId);
      this.notify(item.conversationId);
    }
    return [...this.confirmations].filter(([, item]) => item.conversationId === conversationId)
      .map(([confirmationRef, item]) => ({ confirmationRef, capabilityId: item.call.capabilityId,
        actionId: item.call.actionId, sourceRequestId: item.sourceRequestId, invocationId: item.context.invocationId,
        inputSummary: item.inputSummary, ...(item.presentation ? { presentation: item.presentation } : {}),
        analyzeAfter: requestedCompletionAnalysis(item.prompt) }));
  }
  chooseAnalysis(conversationId: string, capabilityId: string, taskId: string, enabled: boolean): boolean {
    const link = this.repositories.chatCapabilities.tasks(conversationId).find(item =>
      item.snapshot.taskRef.capabilityId === capabilityId && item.snapshot.taskRef.taskId === taskId);
    if (!link) return false;
    this.repositories.chatCapabilities.setAnalyzeAfter(conversationId, capabilityId, taskId, enabled);
    this.notify(conversationId);
    return true;
  }
  async approve(confirmationRef: string, conversationId: string, analyzeAfter: boolean): Promise<unknown> {
    const pending = this.confirmations.get(confirmationRef);
    if (!pending || pending.conversationId !== conversationId || this.activeConversationId !== conversationId) return { status: "error", error: safeGatewayError({ code: "confirmation_invalid" }) };
    this.clearConfirmation(confirmationRef);
    const runtime = this.runtime();
    if (!runtime) {
      const result = { status: "error", error: safeGatewayError({ code: "capability_unavailable" }) };
      this.recordApprovalOutcome(pending, result); return result;
    }
    const inspected = runtime.actionConfirmations.inspect(confirmationRef, pending.context);
    if (!inspected) {
      const result = { status: "error", error: safeGatewayError({ code: "confirmation_invalid" }) };
      this.recordApprovalOutcome(pending, result); return result;
    }
    const token = runtime.actionConfirmations.approve(confirmationRef, pending.context);
    if (!token) {
      const result = { status: "error", error: safeGatewayError({ code: "confirmation_invalid" }) };
      this.recordApprovalOutcome(pending, result); return result;
    }
    const result = await runtime.actionGateway.invoke(pending.call, { ...pending.context, confirmationToken: token });
    if (result.status === "accepted") {
      this.repositories.chatCapabilities.removeOperation(pending.context.invocationId);
      this.linkAccepted(conversationId, pending.sourceRequestId, result.taskRef, result.taskStatus, pending.prompt, analyzeAfter,
        result.presentation ?? { text: "任务已提交，正在处理。" });
      this.tryAutoOpen(conversationId, pending.context.invocationId, "result", result.presentation);
    }
    if (result.status === "completed") {
      this.saveCompletedViews(conversationId, pending.sourceRequestId, result);
      this.tryAutoOpen(conversationId, pending.context.invocationId, "result", result.presentation);
    }
    if (result.status === "completed" || result.status === "error") this.recordApprovalOutcome(pending, result);
    this.operationGeneration.delete(pending.context.invocationId);
    this.notify(conversationId);
    return result;
  }
  private recordApprovalOutcome(pending: PendingConfirmation, result: { status: string; data?: unknown; error?: { code?: string; message?: string }; presentation?: OperationPresentation }): void {
    const presentation = pending.inputSummary && typeof pending.inputSummary === "object"
      ? pending.inputSummary as { title?: unknown } : undefined;
    const title = typeof presentation?.title === "string" && presentation.title.length <= 120 ? presentation.title : "操作";
    const data = result.data && typeof result.data === "object" ? result.data as { summary?: unknown } : undefined;
    const summary = typeof data?.summary === "string" && data.summary.trim() && data.summary.length <= 4000 ? data.summary.trim() : undefined;
    const receipt = this.repositories.capabilityInvocations.get(pending.context.invocationId);
    const uncertain = receipt?.state === "pending" || result.error?.code === "reconciliation_required" || result.error?.code === "EXTERNAL.TIMEOUT";
    const fallbackText = result.status === "completed" ? summary && summary.length <= 1000 ? summary : "操作已完成。"
      : uncertain ? "操作结果待核实。请查询原操作状态，避免重复执行。" : "操作失败。";
    this.repositories.chatCapabilities.saveOperation({ conversationId: pending.conversationId, sourceRequestId: pending.sourceRequestId,
      invocationId: pending.context.invocationId, title, status: result.status === "completed" ? "completed" : uncertain ? "uncertain" : "failed",
      presentation: result.presentation ?? { text: fallbackText } });
    this.operationGeneration.delete(pending.context.invocationId);
    this.notify(pending.conversationId);
  }
  dismiss(confirmationRef: string, conversationId: string): boolean {
    const pending = this.confirmations.get(confirmationRef);
    if (!pending || pending.conversationId !== conversationId || this.activeConversationId !== conversationId) return false;
    this.runtime()?.actionConfirmations.dismiss(confirmationRef, pending.context);
    this.clearConfirmation(confirmationRef);
    this.repositories.chatCapabilities.saveOperation({ conversationId, sourceRequestId: pending.sourceRequestId, invocationId: pending.context.invocationId,
      title: this.confirmationTitle(pending.inputSummary), status: "cancelled", presentation: { text: "已取消，未执行操作。" } });
    this.operationGeneration.delete(pending.context.invocationId);
    this.notify(conversationId); return true;
  }
  openForConversation(conversationId: string, target: ViewRef | DraftRef, requestSignal?: AbortSignal) {
    if (this.activeConversationId !== conversationId) return Promise.resolve({ status: "blocked", message: "conversation_not_active" });
    const key = canonicalActionJson(target);
    const saved = this.repositories.chatCapabilities.views(conversationId).some(item => canonicalActionJson(item.target) === key)
      || this.repositories.chatCapabilities.tasks(conversationId).some(item => item.snapshot.viewRefs?.some(ref => canonicalActionJson(ref) === key));
    if (!saved) return Promise.resolve({ status: "not_found" });
    this.runtime()?.navigation.noteManualNavigation();
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.conversationNavigation.signal]) : this.conversationNavigation.signal;
    return this.runtime()?.navigation.open(target, signal) ?? Promise.resolve({ status: "unsupported" });
  }
  autoOpenEditor(conversationId: string, target: ViewRef, generation: number): Promise<unknown> {
    const navigation = this.runtime()?.navigation;
    if (!navigation || this.activeConversationId !== conversationId || navigation.manualGeneration() !== generation) return Promise.resolve({ status: "blocked" });
    return navigation.open(target, this.conversationNavigation.signal);
  }

  async call(chatRequestId: string, toolCallId: string, operation: ToolOperation, args: unknown): Promise<unknown> {
    if (operation !== "invoke") return this.callDirect(chatRequestId, toolCallId, operation, args);
    const prior = this.invokeQueue;
    let release!: () => void;
    this.invokeQueue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await this.callDirect(chatRequestId, toolCallId, operation, args); }
    finally { release(); }
  }

  private async callDirect(chatRequestId: string, toolCallId: string, operation: ToolOperation, args: unknown): Promise<unknown> {
    const session = this.active.get(chatRequestId);
    const runtime = this.runtime();
    if (!session || !runtime) return { status: "error", error: safeGatewayError({ code: "capability_unavailable" }) };
    const context: TrustedActionContext = { callerId: "chat-window", source: "chat", sessionId: session.conversationId,
      invocationId: randomUUID(), permissions };
    try {
      if (operation === "describe") {
        if (!args || typeof args !== "object") throw { code: "INPUT.INVALID" };
        const input = args as { capabilityId?: string; actionId?: string };
        const entry = runtime.actionCatalog.find(input.capabilityId ?? "", input.actionId ?? "");
        if (!entry) throw { code: "capability_unavailable" };
        const call = { capabilityId: entry.capabilityId, actionId: entry.actionId, contractDigest: entry.declaration.contractDigest, input: null };
        const result = await runtime.actionGateway.describe(call, context);
        if (result.status === "described") {
          const key = capabilityDescriptionKey({ capabilityId: entry.capabilityId, packageVersion: entry.packageVersion,
            actionId: entry.actionId, contractDigest: entry.declaration.contractDigest });
          const cached = this.repositories.chatCapabilities.description(session.conversationId, entry.capabilityId,
            entry.packageVersion, entry.actionId, entry.declaration.contractDigest);
          if (cached && (session.restoredKeys.has(key) || session.describedThisTurn.has(key))) return { status: "already_described", capabilityId: entry.capabilityId,
            actionId: entry.actionId, packageVersion: entry.packageVersion, contractDigest: entry.declaration.contractDigest };
          this.repositories.chatCapabilities.saveDescription({ conversationId: session.conversationId, capabilityId: entry.capabilityId,
            actionId: entry.actionId, packageVersion: entry.packageVersion, contractDigest: entry.declaration.contractDigest,
            declaration: entry.declaration as unknown as Record<string, unknown>, documentation: entry.documentation });
          session.describedThisTurn.add(key);
        }
        return result;
      }
      if (operation === "invoke") {
        if (!args || typeof args !== "object" || Array.isArray(args)) throw { code: "INPUT.INVALID" };
        const { invocationId, ...candidate } = args as Record<string, unknown>;
        if (!Value.Check(ActionCallSchema, candidate) || (invocationId !== undefined && (typeof invocationId !== "string" || invocationId.length > 200 || !invocationId))) throw { code: "INPUT.INVALID" };
        const call = candidate as ActionCall;
        this.interactions?.assertInvocationAllowed(chatRequestId, call);
        const entry = runtime.actionCatalog.find(call.capabilityId, call.actionId);
        if (!entry || !this.repositories.chatCapabilities.description(session.conversationId, call.capabilityId,
          entry.packageVersion, call.actionId, call.contractDigest)) throw { code: "contract_changed" };
        const key = `${chatRequestId}\0${toolCallId}`;
        const callDigest = createHash("sha256").update(canonicalActionJson(call)).digest("hex");
        let issued = this.invocations.get(key);
        if (issued && canonicalActionJson(issued.call) !== canonicalActionJson(call)) throw { code: "invocation_invalid" };
        const bindings = this.repositories.chatCapabilities.invocations(session.conversationId);
        const explicit = invocationId === undefined ? undefined : bindings.find(item => item.invocationId === invocationId);
        if (invocationId !== undefined && (!explicit || explicit.callDigest !== callDigest)) throw { code: "invocation_invalid" };
        const original = bindings.find(item => item.sourceRequestId === chatRequestId && item.toolCallId === toolCallId);
        if (original && original.callDigest !== callDigest) throw { code: "invocation_invalid" };
        const uncertain = entry.declaration.effects.data !== "read" || entry.declaration.effects.consumesResources
          ? bindings.find(item => item.callDigest === callDigest && runtime.actionGateway.requiresReconciliation(item.invocationId)) : undefined;
        const saved = explicit ?? original ?? uncertain;
        if (saved) issued = { call, context: { ...context, invocationId: saved.invocationId } };
        if (issued) {
          const reconciled = await runtime.actionGateway.query(call, issued.context);
          if (reconciled.status === "accepted") this.linkAccepted(session.conversationId, chatRequestId,
            reconciled.taskRef, reconciled.taskStatus, session.prompt, undefined, reconciled.presentation);
          if (reconciled.status === "completed") this.saveCompletedViews(session.conversationId, chatRequestId, reconciled);
          return reconciled;
        }
        issued = { call, context: runtime.actionGateway.issue(call, context) };
        this.operationGeneration.set(issued.context.invocationId, runtime.navigation.manualGeneration());
        this.repositories.chatCapabilities.bindInvocation({ conversationId: session.conversationId,
          sourceRequestId: chatRequestId, toolCallId, callDigest, invocationId: issued.context.invocationId });
        this.invocations.set(key, issued);
        const result = await runtime.actionGateway.invoke(call, issued.context, this.interactions ? () => {
          try { this.interactions!.assertInvocationAllowed(chatRequestId, call); return true; } catch { return false; }
        } : undefined);
        if (result.status === "requires_confirmation") {
          if (this.interactions) {
            runtime.actionConfirmations.dismiss(result.confirmationRef, issued.context);
            const interaction = await this.interactions.requestApproval({ conversationId: session.conversationId, requestId: chatRequestId, toolCallId }, call);
            if (interaction.status === "succeeded" || interaction.status === "submitted" || interaction.status === "failed") {
              const receipt = this.interactions.resultFor(interaction);
              if (receipt) return receipt;
            }
            return { status: "awaiting_user", interactionId: interaction.id, revision: interaction.revision };
          }
          this.confirmations.set(result.confirmationRef, { call, context: issued.context,
            conversationId: session.conversationId, sourceRequestId: chatRequestId, prompt: session.prompt, inputSummary: result.inputSummary,
            ...(result.presentation ? { presentation: result.presentation } : {}) });
          this.repositories.chatCapabilities.saveOperation({ conversationId: session.conversationId, sourceRequestId: chatRequestId,
            invocationId: issued.context.invocationId, status: "awaiting_confirmation", title: this.confirmationTitle(result.inputSummary),
            ...(result.presentation ? { presentation: result.presentation } : {}) });
          if (result.presentation?.target) this.repositories.chatCapabilities.saveViews(session.conversationId, chatRequestId, [result.presentation.target]);
          this.tryAutoOpen(session.conversationId, issued.context.invocationId, "preview", result.presentation);
          const timer = setTimeout(() => {
            this.clearConfirmation(result.confirmationRef);
            this.repositories.chatCapabilities.saveOperation({ conversationId: session.conversationId, sourceRequestId: chatRequestId,
              invocationId: issued.context.invocationId, status: "interrupted", title: this.confirmationTitle(result.inputSummary), presentation: { text: "确认已过期，操作未执行。" } });
            this.operationGeneration.delete(issued.context.invocationId);
            this.notify(session.conversationId);
          }, 5 * 60_000);
          timer.unref(); this.confirmationTimers.set(result.confirmationRef, timer);
          this.notify(session.conversationId);
        } else if (result.status === "accepted") {
          this.linkAccepted(session.conversationId, chatRequestId, result.taskRef, result.taskStatus, session.prompt, undefined, result.presentation);
          this.tryAutoOpen(session.conversationId, issued.context.invocationId, "start", result.presentation);
        } else if (result.status === "completed") {
          this.saveCompletedViews(session.conversationId, chatRequestId, result);
          if (result.presentation) this.repositories.chatCapabilities.saveOperation({ conversationId: session.conversationId,
            sourceRequestId: chatRequestId, invocationId: issued.context.invocationId, status: "completed", title: "", presentation: result.presentation });
          this.tryAutoOpen(session.conversationId, issued.context.invocationId, "result", result.presentation);
        } else if (result.status === "error" && result.presentation) this.repositories.chatCapabilities.saveOperation({ conversationId: session.conversationId,
          sourceRequestId: chatRequestId, invocationId: issued.context.invocationId, status: "failed", title: "", presentation: result.presentation });
        if (result.status !== "requires_confirmation") this.operationGeneration.delete(issued.context.invocationId);
        return result;
      }
      if (operation === "task.get" || operation === "task.cancel") {
        const ref = (args as { taskRef?: unknown } | null)?.taskRef;
        if (!Value.Check(TaskRefSchema, ref)) throw { code: "INPUT.INVALID" };
        if (operation === "task.cancel" && !wantsCancellation(session.prompt)) throw { code: "permission_denied" };
        if (!this.repositories.chatCapabilities.tasks(session.conversationId).some(link => link.snapshot.taskRef.capabilityId === ref.capabilityId && link.snapshot.taskRef.taskId === ref.taskId)) throw { code: "permission_denied" };
        const result = operation === "task.get" ? await runtime.taskArtifactGateway.get(ref, context) : await runtime.taskArtifactGateway.cancel(ref, context);
        if (result.status === "completed") this.observeTask(result.data);
        return result;
      }
      if (operation === "read") {
        const input = args as { artifactRef?: unknown; cursor?: unknown; section?: unknown } | null;
        if (!Value.Check(ArtifactRefSchema, input?.artifactRef) || (input?.cursor !== undefined && typeof input.cursor !== "string") || (input?.section !== undefined && typeof input.section !== "string")) throw { code: "INPUT.INVALID" };
        return runtime.taskArtifactGateway.read(input!.artifactRef!, {
          ...(input!.cursor === undefined ? {} : { cursor: input!.cursor as string }),
          ...(input!.section === undefined ? {} : { section: input!.section as string }),
        }, context);
      }
      if (operation === "open") {
        const target = (args as { target?: unknown } | null)?.target;
        if (!Value.Check(ViewRefSchema, target) && !Value.Check(DraftRefSchema, target)) throw { code: "INPUT.INVALID" };
        if (!wantsOpen(session.prompt)) return { status: "blocked", message: "user_open_intent_required" };
        return this.openForConversation(session.conversationId, target, session.navigation.signal);
      }
      throw { code: "INPUT.INVALID" };
    } catch (error) { return { status: "error", error: safeGatewayError(error) }; }
  }

  interactionOutcome(owner: import("@deepfield/contracts").InteractionOwner, invocationId: string, outcome: unknown, generation?: number): void {
    const result = outcome as Awaited<ReturnType<CapabilityRuntime["actionGateway"]["invoke"]>>;
    if (result.status === "accepted") this.linkAccepted(owner.conversationId, owner.requestId, result.taskRef, result.taskStatus, "", false, result.presentation);
    if (result.status === "completed") this.saveCompletedViews(owner.conversationId, owner.requestId, result);
    if (result.status === "completed" || result.status === "error") this.repositories.chatCapabilities.saveOperation({
      conversationId: owner.conversationId, sourceRequestId: owner.requestId, invocationId, title: "操作",
      status: result.status === "completed" ? "completed" : "failed", presentation: result.presentation ?? { text: result.status === "completed" ? "操作已完成。" : "操作失败。" },
    });
    if (generation !== undefined && (result.status === "completed" || result.status === "accepted")) {
      this.operationGeneration.set(invocationId, generation);
      this.tryAutoOpen(owner.conversationId, invocationId, result.status === "accepted" ? "start" : "result", result.presentation);
      this.operationGeneration.delete(invocationId);
    }
    this.notify(owner.conversationId);
  }
  private linkAccepted(conversationId: string, sourceRequestId: string, ref: TaskSnapshot["taskRef"], status: TaskSnapshot["status"], prompt = "", analyzeAfter = requestedCompletionAnalysis(prompt), presentation?: OperationPresentation): void {
    if (this.repositories.chatCapabilities.tasks(conversationId).some(item => item.snapshot.taskRef.capabilityId === ref.capabilityId && item.snapshot.taskRef.taskId === ref.taskId)) return;
    this.repositories.chatCapabilities.linkTask({ conversationId, sourceRequestId,
      snapshot: { taskRef: ref, status, ...(presentation ? { presentation } : {}) }, analyzeAfter, analysisState: "none" });
    if (presentation?.target) this.repositories.chatCapabilities.saveViews(conversationId, sourceRequestId, [presentation.target]);
    this.notify(conversationId);
    const runtime = this.runtime();
    if (runtime) void runtime.taskArtifactGateway.get(ref, { permissions }).then(result => {
      if (result.status === "completed") this.observeTask(result.data);
    }).catch(() => {});
  }
  private saveCompletedViews(conversationId: string, sourceRequestId: string, result: { data: unknown; viewRefs?: readonly ViewRef[]; presentation?: OperationPresentation }): void {
    const data = result.data;
    const candidate = typeof data === "object" && data !== null && "draftRef" in data
      ? (data as { draftRef: unknown }).draftRef : data;
    const targets: Array<ViewRef | DraftRef> = [...(result.viewRefs ?? [])];
    if (Value.Check(DraftRefSchema, candidate)) targets.push(candidate);
    if (result.presentation?.target) targets.push(result.presentation.target);
    if (!targets.length) return;
    this.repositories.chatCapabilities.saveViews(conversationId, sourceRequestId, targets);
    this.notify(conversationId);
  }
  observeTask(snapshot: TaskSnapshot): void {
    const eventId = taskEventId(snapshot);
    for (const link of this.repositories.chatCapabilities.tasksByRef(snapshot.taskRef.capabilityId, snapshot.taskRef.taskId)) {
      const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.status);
      const fallbackText = snapshot.status === "succeeded" ? "任务已完成。" : snapshot.status === "failed" ? "任务失败。"
        : snapshot.status === "cancelled" ? "任务已取消。" : "任务已中断。";
      const retained = !snapshot.presentation && link.snapshot.presentation ? { ...link.snapshot.presentation,
        ...(terminal ? { text: fallbackText, autoOpen: false } : {}) } : undefined;
      const current = retained ? { ...snapshot, presentation: retained } : snapshot;
      if (this.repositories.chatCapabilities.updateTask(link.conversationId, current, eventId)) {
        if (current.presentation?.target) this.repositories.chatCapabilities.saveViews(link.conversationId, link.sourceRequestId, [current.presentation.target]);
        this.notify(link.conversationId);
      }
    }
  }
  async connectTaskProviders(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const id of this.registry.readyIds()) {
      const provider = this.registry.taskProvider(id);
      if (provider?.subscribe) this.unsubscribers.push(provider.subscribe(snapshot => {
        const runtime = this.runtime();
        if (!runtime) return;
        void runtime.taskArtifactGateway.get(snapshot.taskRef, { permissions }).then(result => {
          if (result.status === "completed") this.observeTask(result.data);
        }).catch(() => {});
      }));
    }
    // One finite recovery pass catches completions that happened before an observer attached.
    const runtime = this.runtime();
    if (!runtime) return;
    for (const link of this.repositories.chatCapabilities.allTasks()) {
      const result = await runtime.taskArtifactGateway.get(link.snapshot.taskRef, { permissions });
      if (result.status === "completed") this.observeTask(result.data);
    }
  }
  private confirmationTitle(value: unknown): string {
    const title = value && typeof value === "object" && "title" in value ? value.title : undefined;
    return typeof title === "string" && title.trim() && title.length <= 120 ? title.trim() : "操作";
  }
  private tryAutoOpen(conversationId: string, invocationId: string, phase: "preview" | "start" | "result", presentation?: OperationPresentation): void {
    if (!presentation?.autoOpen || !presentation.target || this.activeConversationId !== conversationId) return;
    const navigation = this.runtime()?.navigation;
    if (!navigation) return;
    const generation = this.operationGeneration.get(invocationId);
    if (generation === undefined || navigation.manualGeneration() !== generation) return;
    const key = `${invocationId}:${phase}`;
    if (this.autoOpened.has(key)) return;
    this.autoOpened.add(key);
    const signal = this.conversationNavigation.signal;
    const target = presentation.target;
    const prior = this.autoNavigation.get(invocationId) ?? Promise.resolve();
    const next = prior.then(async () => {
      if (signal.aborted || this.activeConversationId !== conversationId || navigation.manualGeneration() !== generation) return;
      await navigation.open(target, signal).catch(() => {});
    });
    this.autoNavigation.set(invocationId, next);
    void next.finally(() => { if (this.autoNavigation.get(invocationId) === next) this.autoNavigation.delete(invocationId); });
  }
  dispose(): void { for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe(); this.conversationNavigation.abort(); for (const session of this.active.values()) session.navigation.abort(); this.active.clear(); for (const ref of this.confirmations.keys()) this.clearConfirmation(ref); this.listeners.clear(); this.streamListeners.clear(); }
  private clearConfirmation(ref: string): void { const timer = this.confirmationTimers.get(ref); if (timer) clearTimeout(timer); this.confirmationTimers.delete(ref); this.confirmations.delete(ref); }
  private notify(conversationId: string): void { for (const listener of this.listeners) { try { listener(conversationId); } catch { /* UI isolation */ } } }
}
