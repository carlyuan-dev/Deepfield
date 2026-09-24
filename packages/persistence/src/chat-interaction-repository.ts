import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InteractionOwner, InteractionPayload, InteractionRecord, InteractionResumeEvent, OperationRef, OperationResult, OperationSnapshot, InteractionResponseSource } from "@deepfield/contracts";
import { runInTransaction } from "./transactions.js";

export interface InteractionRepository {
  create(owner: InteractionOwner, payload: InteractionPayload, contentVersion?: string): InteractionRecord;
  get(id: string): InteractionRecord | undefined;
  list(conversationId: string): InteractionRecord[];
  active(conversationId: string): InteractionRecord | undefined;
  listRecoverable(): InteractionRecord[];
  beginEdit(id: string, expectedRevision: number): InteractionRecord | undefined;
  finishEdit(id: string, expectedRevision: number, snapshot: OperationSnapshot, operation?: OperationRef): InteractionRecord | undefined;
  invalidate(id: string, expectedRevision: number, reason: string): InteractionRecord | undefined;
  answer(id: string, expectedRevision: number, text: string, source: InteractionResponseSource): InteractionRecord | undefined;
  cancel(id: string, expectedRevision: number, source: InteractionResponseSource): InteractionRecord | undefined;
  claimApproval(id: string, expectedRevision: number, receiptId: string, source: InteractionResponseSource): InteractionRecord | undefined;
  finishExecution(id: string, receiptId: string, result: OperationResult | "unknown"): InteractionRecord | undefined;
  pendingEvents(conversationId?: string): InteractionResumeEvent[];
  claimedEvents(): InteractionResumeEvent[];
  stageContinuation(receiptId: string, owner: InteractionOwner, operation: OperationRef): void;
  continuations(): { receiptId: string; owner: InteractionOwner; operation: OperationRef }[];
  consumeContinuation(receiptId: string): void;
  claimEvent(id: string): InteractionResumeEvent | undefined;
  consumeEvent(id: string): void;
}

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const record = (row: Row): InteractionRecord => ({
  id: String(row.id), conversationId: String(row.conversation_id), requestId: String(row.source_request_id),
  toolCallId: String(row.tool_call_id), payload: JSON.parse(String(row.payload_json)) as InteractionPayload,
  revision: Number(row.revision), status: row.status as InteractionRecord["status"],
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  ...(row.content_version === null ? {} : { contentVersion: String(row.content_version) }),
  ...(row.receipt_id === null ? {} : { receiptId: String(row.receipt_id) }),
  ...(row.answer === null ? {} : { answer: String(row.answer) }),
  ...(row.result_summary === null ? {} : { resultSummary: String(row.result_summary) }),
  ...(row.task_id === null ? {} : { taskId: String(row.task_id) }),
  ...(row.failure_reason === null ? {} : { failureReason: String(row.failure_reason) }),
});
const event = (row: Row): InteractionResumeEvent => ({
  id: String(row.id), interactionId: String(row.interaction_id), conversationId: String(row.conversation_id),
  sourceRequestId: String(row.source_request_id), kind: row.kind as InteractionResumeEvent["kind"],
  detail: String(row.detail), state: row.state as InteractionResumeEvent["state"],
});

export function createChatInteractionRepository(db: DatabaseSync): InteractionRepository {
  const get = (id: string): InteractionRecord | undefined => {
    const row = db.prepare("SELECT * FROM chat_interactions WHERE id=?").get(id) as Row | undefined;
    return row ? record(row) : undefined;
  };
  const addEvent = (item: InteractionRecord, kind: InteractionResumeEvent["kind"], detail: string): void => {
    db.prepare(`INSERT OR IGNORE INTO chat_interaction_resume_events
      (id,interaction_id,conversation_id,source_request_id,kind,detail,state,created_at)
      VALUES (?,?,?,?,?,?,'pending',?)`).run(randomUUID(), item.id, item.conversationId, item.requestId, kind, detail, now());
  };
  const addResponse = (id: string, revision: number, kind: string, source: InteractionResponseSource, detail: string): void => {
    db.prepare(`INSERT INTO chat_interaction_responses(id,interaction_id,revision,kind,source,detail,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), id, revision, kind, source, detail, now());
  };
  return {
    create(owner: InteractionOwner, payload: InteractionPayload, contentVersion?: string): InteractionRecord {
      const id = randomUUID(); const time = now();
      db.prepare(`INSERT INTO chat_interactions
        (id,conversation_id,source_request_id,tool_call_id,kind,payload_json,revision,status,content_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,'waiting',?,?,?)`).run(id, owner.conversationId, owner.requestId, owner.toolCallId,
          payload.kind, JSON.stringify(payload), contentVersion ?? null, time, time);
      return get(id)!;
    },
    get,
    list(conversationId: string): InteractionRecord[] {
      return (db.prepare(`SELECT * FROM chat_interactions WHERE conversation_id=? ORDER BY created_at,id`).all(conversationId) as Row[]).map(record);
    },
    active(conversationId: string): InteractionRecord | undefined {
      const row = db.prepare(`SELECT * FROM chat_interactions WHERE conversation_id=? AND status IN ('waiting','editing','executing') LIMIT 1`).get(conversationId) as Row | undefined;
      return row ? record(row) : undefined;
    },
    listRecoverable(): InteractionRecord[] {
      return (db.prepare(`SELECT * FROM chat_interactions WHERE status IN ('waiting','editing','executing') ORDER BY created_at,id`).all() as Row[]).map(record);
    },
    beginEdit(id: string, expectedRevision: number): InteractionRecord | undefined {
      const result = db.prepare(`UPDATE chat_interactions SET status='editing',revision=revision+1,updated_at=?
        WHERE id=? AND revision=? AND kind='approval' AND status='waiting'`).run(now(), id, expectedRevision);
      return result.changes ? get(id) : undefined;
    },
    finishEdit(id: string, expectedRevision: number, snapshot: OperationSnapshot, operation?: OperationRef): InteractionRecord | undefined {
      const current = get(id);
      if (!current || current.payload.kind !== "approval") return undefined;
      const payload: InteractionPayload = { ...current.payload, summary: snapshot.summary, operation: operation ?? current.payload.operation };
      const result = db.prepare(`UPDATE chat_interactions SET status='waiting',revision=revision+1,
        content_version=?,payload_json=?,updated_at=? WHERE id=? AND revision=? AND status='editing'`)
        .run(snapshot.version, JSON.stringify(payload), now(), id, expectedRevision);
      return result.changes ? get(id) : undefined;
    },
    invalidate(id: string, expectedRevision: number, reason: string): InteractionRecord | undefined {
      const result = db.prepare(`UPDATE chat_interactions SET status='invalidated',failure_reason=?,updated_at=?
        WHERE id=? AND revision=? AND status IN ('waiting','editing')`).run(reason, now(), id, expectedRevision);
      return result.changes ? get(id) : undefined;
    },
    answer(id: string, expectedRevision: number, text: string, source: InteractionResponseSource): InteractionRecord | undefined {
      return runInTransaction(db, () => {
        const result = db.prepare(`UPDATE chat_interactions SET status='answered',answer=?,updated_at=?
          WHERE id=? AND revision=? AND kind='question' AND status='waiting'`).run(text, now(), id, expectedRevision);
        if (!result.changes) return undefined;
        const item = get(id)!; addResponse(id, expectedRevision, "answer", source, text); addEvent(item, "answer", text);
        return item;
      });
    },
    cancel(id: string, expectedRevision: number, source: InteractionResponseSource): InteractionRecord | undefined {
      return runInTransaction(db, () => {
        const result = db.prepare(`UPDATE chat_interactions SET status='cancelled',updated_at=?
          WHERE id=? AND revision=? AND status IN ('waiting','editing')`).run(now(), id, expectedRevision);
        if (!result.changes) return undefined;
        const item = get(id)!; addResponse(id, expectedRevision, "cancel", source, "cancelled"); addEvent(item, "cancelled", "cancelled");
        return item;
      });
    },
    claimApproval(id: string, expectedRevision: number, receiptId: string, source: InteractionResponseSource): InteractionRecord | undefined {
      return runInTransaction(db, () => {
        const result = db.prepare(`UPDATE chat_interactions SET status='executing',receipt_id=?,updated_at=?
          WHERE id=? AND revision=? AND kind='approval' AND status='waiting'`).run(receiptId, now(), id, expectedRevision);
        if (!result.changes) return undefined;
        addResponse(id, expectedRevision, "approve", source, receiptId);
        return get(id)!;
      });
    },
    finishExecution(id: string, receiptId: string, result: OperationResult | "unknown"): InteractionRecord | undefined {
      return runInTransaction(db, () => {
        const state = result === "unknown" ? "uncertain" : result.status;
        const summary = result === "unknown" ? null : result.summary;
        const taskId = result !== "unknown" && result.status === "submitted" ? result.taskId : null;
        const update = db.prepare(`UPDATE chat_interactions SET status=?,result_summary=?,task_id=?,updated_at=?
          WHERE id=? AND receipt_id=? AND status='executing'`).run(state, summary, taskId, now(), id, receiptId);
        if (!update.changes) return undefined;
        const item = get(id)!;
        addEvent(item, "operation_result", result === "unknown" ? "Result requires verification" : result.summary);
        return item;
      });
    },
    pendingEvents(conversationId?: string): InteractionResumeEvent[] {
      const rows = conversationId === undefined
        ? db.prepare(`SELECT * FROM chat_interaction_resume_events WHERE state='pending' ORDER BY created_at,id`).all()
        : db.prepare(`SELECT * FROM chat_interaction_resume_events WHERE state='pending' AND conversation_id=? ORDER BY created_at,id`).all(conversationId);
      return (rows as Row[]).map(event);
    },
    claimedEvents(): InteractionResumeEvent[] {
      return (db.prepare("SELECT * FROM chat_interaction_resume_events WHERE state='claimed' ORDER BY created_at,id").all() as Row[]).map(event);
    },
    stageContinuation(receiptId: string, owner: InteractionOwner, operation: OperationRef): void {
      db.prepare("INSERT OR IGNORE INTO chat_interaction_continuations(receipt_id,conversation_id,owner_json,operation_json) VALUES (?,?,?,?)").run(receiptId, owner.conversationId, JSON.stringify(owner), JSON.stringify(operation));
    },
    continuations() {
      return (db.prepare("SELECT * FROM chat_interaction_continuations WHERE consumed=0 ORDER BY rowid").all() as Row[]).map(row => ({
        receiptId: String(row.receipt_id), owner: JSON.parse(String(row.owner_json)) as InteractionOwner, operation: JSON.parse(String(row.operation_json)) as OperationRef,
      }));
    },
    consumeContinuation(receiptId: string): void { db.prepare("UPDATE chat_interaction_continuations SET consumed=1 WHERE receipt_id=?").run(receiptId); },
    claimEvent(id: string): InteractionResumeEvent | undefined {
      const result = db.prepare(`UPDATE chat_interaction_resume_events SET state='claimed' WHERE id=? AND state='pending'`).run(id);
      const row = result.changes ? db.prepare("SELECT * FROM chat_interaction_resume_events WHERE id=?").get(id) as Row : undefined;
      return row ? event(row) : undefined;
    },
    consumeEvent(id: string): void {
      db.prepare(`UPDATE chat_interaction_resume_events SET state='consumed' WHERE id=? AND state='claimed'`).run(id);
    },
  };
}
