import type { DatabaseSync } from "node:sqlite";
import type { OperationPresentation, TaskSnapshot } from "@deepfield/capability-sdk";
import type { ViewRef, DraftRef } from "@deepfield/capability-sdk";
import { createHash } from "node:crypto";

export interface ChatCapabilityDescription {
  conversationId: string; capabilityId: string; packageVersion: string;
  actionId: string; contractDigest: string; documentation: string;
  declaration: Record<string, unknown>;
}
export interface ChatCapabilityTask {
  conversationId: string; sourceRequestId: string; snapshot: TaskSnapshot;
  analyzeAfter: boolean;
  analysisState: "none" | "pending" | "running" | "completed" | "interrupted";
  consumedEventId?: string;
}
export interface ChatCapabilityView { conversationId: string; sourceRequestId: string; target: ViewRef | DraftRef }
export interface ChatCapabilityInvocation {
  invocationId: string; conversationId: string; sourceRequestId: string; toolCallId: string; callDigest: string;
}
export interface ChatCapabilityOperation {
  conversationId: string; sourceRequestId: string; invocationId: string;
  status: "awaiting_confirmation" | "completed" | "failed" | "cancelled" | "interrupted" | "uncertain";
  title: string; presentation?: OperationPresentation;
}

export function createChatCapabilityRepository(db: DatabaseSync) {
  const task = (row: Record<string, unknown>): ChatCapabilityTask => ({
    conversationId: String(row.conversation_id), sourceRequestId: String(row.source_request_id),
    snapshot: JSON.parse(String(row.snapshot_json)) as TaskSnapshot,
    analyzeAfter: row.analyze_after === 1,
    analysisState: row.analysis_state as ChatCapabilityTask["analysisState"],
    ...(row.consumed_event_id ? { consumedEventId: String(row.consumed_event_id) } : {}),
  });
  return {
    saveOperation(value: ChatCapabilityOperation): void {
      db.prepare(`INSERT INTO chat_capability_operation_cards(invocation_id,conversation_id,source_request_id,status,title,presentation_json)
        VALUES(?,?,?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET status=excluded.status,title=excluded.title,presentation_json=excluded.presentation_json`)
        .run(value.invocationId, value.conversationId, value.sourceRequestId, value.status, value.title, value.presentation ? JSON.stringify(value.presentation) : null);
    },
    operations(conversationId: string): ChatCapabilityOperation[] {
      const rows = db.prepare(`SELECT * FROM (SELECT rowid AS sequence, * FROM chat_capability_operation_cards WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100) ORDER BY sequence`).all(conversationId);
      return rows.map(row => ({ conversationId, sourceRequestId: String(row.source_request_id), invocationId: String(row.invocation_id),
        status: row.status as ChatCapabilityOperation["status"], title: String(row.title),
        ...(row.presentation_json === null ? {} : { presentation: JSON.parse(String(row.presentation_json)) as OperationPresentation }) }));
    },
    removeOperation(invocationId: string): void { db.prepare("DELETE FROM chat_capability_operation_cards WHERE invocation_id=?").run(invocationId); },
    interruptPendingOperations(): void { db.prepare("UPDATE chat_capability_operation_cards SET status='interrupted' WHERE status='awaiting_confirmation'").run(); },
    bindInvocation(value: ChatCapabilityInvocation): void {
      db.prepare(`INSERT INTO chat_capability_invocations(invocation_id,conversation_id,source_request_id,tool_call_id,call_digest) VALUES(?,?,?,?,?)`)
        .run(value.invocationId, value.conversationId, value.sourceRequestId, value.toolCallId, value.callDigest);
    },
    invocations(conversationId: string, callDigest?: string): ChatCapabilityInvocation[] {
      const rows = callDigest === undefined
        ? db.prepare(`SELECT * FROM chat_capability_invocations WHERE conversation_id=? ORDER BY rowid DESC`).all(conversationId)
        : db.prepare(`SELECT * FROM chat_capability_invocations WHERE conversation_id=? AND call_digest=? ORDER BY rowid DESC`).all(conversationId, callDigest);
      return rows.map(row => ({ invocationId: String(row.invocation_id), conversationId,
        sourceRequestId: String(row.source_request_id), toolCallId: String(row.tool_call_id), callDigest: String(row.call_digest) }));
    },
    saveViews(conversationId: string, sourceRequestId: string, targets: readonly (ViewRef | DraftRef)[]): void {
      const insert = db.prepare(`INSERT OR REPLACE INTO chat_capability_views(conversation_id,target_key,source_request_id,target_json) VALUES(?,?,?,?)`);
      for (const target of targets) {
        const data = JSON.stringify(target);
        const key = createHash("sha256").update(data).digest("hex");
        insert.run(conversationId, key, sourceRequestId, data);
      }
    },
    views(conversationId: string): ChatCapabilityView[] {
      return (db.prepare(`SELECT source_request_id,target_json FROM chat_capability_views WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100`).all(conversationId) as { source_request_id: string; target_json: string }[])
        .map(row => ({ conversationId, sourceRequestId: row.source_request_id, target: JSON.parse(row.target_json) as ViewRef | DraftRef }));
    },
    saveDescription(value: ChatCapabilityDescription): void {
      db.prepare(`INSERT OR REPLACE INTO chat_capability_descriptions
        (conversation_id,capability_id,package_version,action_id,contract_digest,documentation,declaration_json)
        VALUES (?,?,?,?,?,?,?)`).run(value.conversationId, value.capabilityId, value.packageVersion,
        value.actionId, value.contractDigest, value.documentation, JSON.stringify(value.declaration));
    },
    description(conversationId: string, capabilityId: string, packageVersion: string, actionId: string, contractDigest: string): ChatCapabilityDescription | undefined {
      const row = db.prepare(`SELECT * FROM chat_capability_descriptions WHERE conversation_id=? AND capability_id=? AND package_version=? AND action_id=? AND contract_digest=?`)
        .get(conversationId, capabilityId, packageVersion, actionId, contractDigest) as Record<string, unknown> | undefined;
      return row ? { conversationId, capabilityId, packageVersion, actionId, contractDigest,
        documentation: String(row.documentation), declaration: JSON.parse(String(row.declaration_json)) as Record<string, unknown> } : undefined;
    },
    descriptions(conversationId: string): ChatCapabilityDescription[] {
      return (db.prepare(`SELECT * FROM chat_capability_descriptions WHERE conversation_id=? ORDER BY rowid DESC`).all(conversationId) as Record<string, unknown>[]).map(row => ({
        conversationId, capabilityId: String(row.capability_id), packageVersion: String(row.package_version),
        actionId: String(row.action_id), contractDigest: String(row.contract_digest),
        documentation: String(row.documentation), declaration: JSON.parse(String(row.declaration_json)) as Record<string, unknown>,
      }));
    },
    linkTask(value: ChatCapabilityTask): void {
      const ref = value.snapshot.taskRef;
      db.prepare(`INSERT INTO chat_capability_tasks (conversation_id,capability_id,task_id,source_request_id,snapshot_json,analyze_after,analysis_state,consumed_event_id)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,capability_id,task_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`)
        .run(value.conversationId, ref.capabilityId, ref.taskId, value.sourceRequestId, JSON.stringify(value.snapshot),
          value.analyzeAfter ? 1 : 0, value.analysisState, value.consumedEventId ?? null);
    },
    tasks(conversationId: string): ChatCapabilityTask[] {
      return (db.prepare(`SELECT * FROM chat_capability_tasks WHERE conversation_id=? ORDER BY rowid`).all(conversationId) as Record<string, unknown>[]).map(task);
    },
    tasksByRef(capabilityId: string, taskId: string): ChatCapabilityTask[] {
      return (db.prepare(`SELECT * FROM chat_capability_tasks WHERE capability_id=? AND task_id=?`).all(capabilityId, taskId) as Record<string, unknown>[]).map(task);
    },
    allTasks(): ChatCapabilityTask[] {
      return (db.prepare(`SELECT * FROM chat_capability_tasks ORDER BY rowid`).all() as Record<string, unknown>[]).map(task);
    },
    updateTask(conversationId: string, snapshot: TaskSnapshot, eventId?: string): boolean {
      const ref = snapshot.taskRef;
      const result = db.prepare(`UPDATE chat_capability_tasks SET snapshot_json=?, consumed_event_id=COALESCE(?,consumed_event_id),
        analysis_state=CASE WHEN analyze_after=1 AND analysis_state='none' AND ?=1 THEN 'pending' ELSE analysis_state END
        WHERE conversation_id=? AND capability_id=? AND task_id=? AND (consumed_event_id IS NULL OR consumed_event_id<>?)`)
        .run(JSON.stringify(snapshot), eventId ?? null, ["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.status) ? 1 : 0,
          conversationId, ref.capabilityId, ref.taskId, eventId ?? null);
      return result.changes > 0;
    },
    setAnalysisState(conversationId: string, capabilityId: string, taskId: string, state: ChatCapabilityTask["analysisState"]): void {
      db.prepare(`UPDATE chat_capability_tasks SET analysis_state=? WHERE conversation_id=? AND capability_id=? AND task_id=?`)
        .run(state, conversationId, capabilityId, taskId);
    },
    setAnalyzeAfter(conversationId: string, capabilityId: string, taskId: string, enabled: boolean): void {
      db.prepare(`UPDATE chat_capability_tasks SET analyze_after=?, analysis_state=CASE WHEN ?=0 THEN 'none' WHEN analysis_state='none' AND json_extract(snapshot_json,'$.status') IN ('succeeded','failed','cancelled','interrupted') THEN 'pending' ELSE analysis_state END WHERE conversation_id=? AND capability_id=? AND task_id=?`)
        .run(enabled ? 1 : 0, enabled ? 1 : 0, conversationId, capabilityId, taskId);
    },
    interruptRunningAnalysis(): void {
      db.prepare(`UPDATE chat_capability_tasks SET analysis_state='interrupted' WHERE analysis_state='running'`).run();
    },
  };
}
