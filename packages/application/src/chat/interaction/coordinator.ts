import { randomUUID } from "node:crypto";
import type { InteractionOwner, InteractionPayload, InteractionRecord, OperationRef, RespondCommand } from "@deepfield/contracts";
import type { InteractionRepository, OperationAdapter, TrustedInteractionContext } from "./ports.js";

export class ChatInteractionCoordinator {
  constructor(
    private readonly repository: InteractionRepository,
    private readonly adapters: ReadonlyMap<string, OperationAdapter>,
    private readonly onChanged?: (record: InteractionRecord) => void,
  ) {}

  private changed(record: InteractionRecord): InteractionRecord {
    try { this.onChanged?.(record); }
    catch { /* UI observers cannot interrupt an already committed state transition. */ }
    return record;
  }

  private adapter(ref: OperationRef): OperationAdapter {
    const adapter = this.adapters.get(ref.provider);
    if (!adapter) throw new Error(`Interaction provider unavailable: ${ref.provider}`);
    return adapter;
  }

  async create(owner: InteractionOwner, payload: InteractionPayload, assertCurrent?: () => void): Promise<InteractionRecord> {
    const active = this.repository.active(owner.conversationId);
    if (active) return active;
    if (payload.kind === "question") {
      if (!payload.question.trim() || (payload.options?.length ?? 0) > 6) throw new Error("Invalid question");
    }
    let contentVersion: string | undefined;
    let storedPayload = payload;
    if (payload.kind === "approval") {
      const snapshot = await this.adapter(payload.operation).read(payload.operation);
      contentVersion = snapshot.version;
      storedPayload = { ...payload, summary: snapshot.summary };
    }
    assertCurrent?.();
    try { return this.changed(this.repository.create(owner, storedPayload, contentVersion)); }
    catch (error) {
      const concurrent = this.repository.active(owner.conversationId);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  get(id: string): InteractionRecord | undefined { return this.repository.get(id); }
  list(conversationId: string): InteractionRecord[] { return this.repository.list(conversationId); }
  active(conversationId: string): InteractionRecord | undefined { return this.repository.active(conversationId); }

  async respond(command: RespondCommand, trustedContext: TrustedInteractionContext): Promise<InteractionRecord> {
    const item = this.repository.get(command.interactionId);
    if (!item) throw new Error("Interaction not found");
    if (item.conversationId !== trustedContext.conversationId) throw new Error("Interaction belongs to another conversation");
    if (item.revision !== command.expectedRevision) return item;
    if (command.response.kind === "decision" && command.response.decision === "cancel" && item.status === "editing") {
      const cancelled = this.repository.cancel(item.id, command.expectedRevision, trustedContext.source);
      if (!cancelled) return this.repository.get(item.id)!;
      if (cancelled.payload.kind === "approval") {
        try { await this.adapter(cancelled.payload.operation).release?.(cancelled.payload.operation); }
        catch { /* Cancellation remains durable even if provider cleanup fails. */ }
      }
      return this.changed(cancelled);
    }
    if (item.status !== "waiting") return item;

    if (command.response.kind === "answer") {
      if (item.payload.kind !== "question") throw new Error("Only questions accept answers");
      if (!command.response.text.trim()) throw new Error("Answer is empty");
      const answered = this.repository.answer(item.id, command.expectedRevision, command.response.text, trustedContext.source);
      return answered ? this.changed(answered) : this.repository.get(item.id)!;
    }
    if (command.response.decision === "cancel") {
      const cancelled = this.repository.cancel(item.id, command.expectedRevision, trustedContext.source);
      if (!cancelled) return this.repository.get(item.id)!;
      if (cancelled.payload.kind === "approval") {
        try { await this.adapter(cancelled.payload.operation).release?.(cancelled.payload.operation); }
        catch { /* The durable cancellation still wins; provider cleanup can be retried separately. */ }
      }
      return this.changed(cancelled);
    }
    if (item.payload.kind !== "approval") throw new Error("Question answers never approve operations");

    const adapter = this.adapter(item.payload.operation);
    const current = await adapter.read(item.payload.operation);
    if (current.version !== item.contentVersion || current.summary !== item.payload.summary) {
      const editing = this.repository.beginEdit(item.id, command.expectedRevision);
      if (!editing) return this.repository.get(item.id)!;
      this.changed(editing);
      const refreshed = this.repository.finishEdit(item.id, editing.revision, current);
      return refreshed ? this.changed(refreshed) : this.repository.get(item.id)!;
    }
    const receiptId = randomUUID();
    const claimed = this.repository.claimApproval(item.id, command.expectedRevision, receiptId, trustedContext.source);
    if (!claimed) return this.repository.get(item.id)!;
    this.changed(claimed);
    let result;
    try {
      result = await adapter.execute(item.payload.operation, claimed.revision, receiptId, item.contentVersion!);
    } catch (error) {
      // An exception does not prove whether a non-idempotent write committed.
      try { result = await adapter.reconcile(receiptId); }
      catch { result = "unknown" as const; }
    }
    const finished = this.repository.finishExecution(item.id, receiptId, result);
    return finished ? this.changed(finished) : this.repository.get(item.id)!;
  }

  beginEdit(id: string, revision: number): InteractionRecord {
    const editing = this.repository.beginEdit(id, revision);
    return editing ? this.changed(editing) : this.require(id);
  }

  /** Complete a host-confirmed provider update. The operation binding may move to a new opaque draft ref. */
  async completeEdit(id: string, revision: number, operation?: OperationRef): Promise<InteractionRecord> {
    const item = this.require(id);
    if (item.payload.kind !== "approval" || item.status !== "editing" || item.revision !== revision) return item;
    const nextRef = operation ?? item.payload.operation;
    const snapshot = await this.adapter(nextRef).read(nextRef);
    const finished = this.repository.finishEdit(id, revision, snapshot, nextRef);
    return finished ? this.changed(finished) : this.require(id);
  }

  /** Revalidate waiting approvals, and reconcile committed or unknown executions. Never replay execution. */
  async recover(): Promise<InteractionRecord[]> {
    const recovered: InteractionRecord[] = [];
    for (const item of this.repository.listRecoverable()) {
      if (item.payload.kind === "question") { recovered.push(item); continue; }
      if (item.status === "editing") {
        const invalidated = this.repository.invalidate(item.id, item.revision, "Unsynced edit interrupted");
        recovered.push(invalidated ? this.changed(invalidated) : this.require(item.id));
        continue;
      }
      let adapter: OperationAdapter;
      try { adapter = this.adapter(item.payload.operation); }
      catch {
        const changed = item.status === "executing"
          ? this.repository.finishExecution(item.id, item.receiptId!, "unknown") ?? this.require(item.id)
          : this.repository.invalidate(item.id, item.revision, "Operation provider unavailable") ?? this.require(item.id);
        recovered.push(this.changed(changed));
        continue;
      }
      if (item.status === "executing") {
        let outcome;
        try { outcome = await adapter.reconcile(item.receiptId!); }
        catch { outcome = "unknown" as const; }
        const finished = this.repository.finishExecution(item.id, item.receiptId!, outcome);
        recovered.push(finished ? this.changed(finished) : this.require(item.id));
        continue;
      }
      try {
        const snapshot = await adapter.read(item.payload.operation);
        if (snapshot.version === item.contentVersion && snapshot.summary === item.payload.summary) {
          recovered.push(item); continue;
        }
        const editing = this.repository.beginEdit(item.id, item.revision);
        if (editing) this.changed(editing);
        const refreshed = editing ? this.repository.finishEdit(item.id, editing.revision, snapshot) : undefined;
        recovered.push(refreshed ? this.changed(refreshed) : this.require(item.id));
      } catch {
        const invalidated = this.repository.invalidate(item.id, item.revision, "Operation could not be revalidated");
        recovered.push(invalidated ? this.changed(invalidated) : this.require(item.id));
      }
    }
    return recovered;
  }

  private require(id: string): InteractionRecord {
    const item = this.repository.get(id);
    if (!item) throw new Error("Interaction not found");
    return item;
  }
}
