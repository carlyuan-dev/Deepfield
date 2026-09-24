import type { DatabaseSync } from "node:sqlite";

export interface InvocationIssuance { id: string; bindingDigest: string; capabilityId: string; actionId: string; issuedAt: number; expiresAt: number }
export interface InvocationRecord extends InvocationIssuance { state: "issued" | "pending" | "completed"; result?: unknown; taskId?: string; terminalAt?: number }
/** Transport receipts only. No input, configuration, secret, or business state. */
export interface InvocationRepository {
  issue(record: InvocationIssuance): void;
  get(id: string): InvocationRecord | undefined;
  claim(id: string, now: number): boolean;
  complete(id: string, result: unknown, taskId: string | undefined, now: number): void;
  /** Validated completion time; subsequent evidence may tighten but never extend retention. */
  markTaskTerminal(capabilityId: string, taskId: string, completedAt: number): void;
  prune(now: number, limit?: number): number;
}
const RETENTION = 30 * 86400000;
export function createCapabilityInvocationRepository(db: DatabaseSync): InvocationRepository {
  return {
    issue(record) { db.prepare("INSERT INTO capability_invocations(id, capability_id, action_id, binding_digest, issued_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, 'issued')").run(record.id, record.capabilityId, record.actionId, record.bindingDigest, record.issuedAt, record.expiresAt); },
    get(id) {
      const row = db.prepare("SELECT * FROM capability_invocations WHERE id = ?").get(id);
      if (!row) return undefined;
      return { id: String(row.id), capabilityId: String(row.capability_id), actionId: String(row.action_id), bindingDigest: String(row.binding_digest), issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at), state: row.state as InvocationRecord["state"],
        ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) as unknown }), ...(row.task_id === null ? {} : { taskId: String(row.task_id) }), ...(row.terminal_at === null ? {} : { terminalAt: Number(row.terminal_at) }) };
    },
    claim(id, now) { return db.prepare("UPDATE capability_invocations SET state = 'pending' WHERE id = ? AND state = 'issued' AND expires_at > ?").run(id, now).changes === 1; },
    complete(id, result, taskId, now) { db.prepare("UPDATE capability_invocations SET state = 'completed', result_json = ?, task_id = ?, terminal_at = ? WHERE id = ? AND state = 'pending'").run(JSON.stringify(result), taskId ?? null, taskId ? null : now, id); },
    markTaskTerminal(capabilityId, taskId, completedAt) { db.prepare("UPDATE capability_invocations SET terminal_at = MIN(COALESCE(terminal_at, ?), ?) WHERE capability_id = ? AND task_id = ?").run(completedAt, completedAt, capabilityId, taskId); },
    prune(now, limit = 500) {
      db.exec("SAVEPOINT capability_invocation_prune");
      try {
        const expired = db.prepare("SELECT id, state FROM capability_invocations WHERE terminal_at <= ? OR (task_id IS NULL AND terminal_at IS NULL AND expires_at <= ?) ORDER BY issued_at LIMIT ?")
          .all(now - RETENTION, now - RETENTION, Math.max(1, Math.min(500, Math.floor(limit))));
        const hasChatBindings = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_capability_invocations'").get();
        const removeBinding = hasChatBindings ? db.prepare("DELETE FROM chat_capability_invocations WHERE invocation_id = ?") : undefined;
        const removeReceipt = db.prepare("DELETE FROM capability_invocations WHERE id = ?");
        let removed = 0;
        for (const row of expired) {
          // Issued calls never dispatched; completed calls have authoritative receipts.
          // Only uncertain pending calls retain a Chat binding as a no-replay tombstone.
          if (row.state === "issued" || row.state === "completed") removeBinding?.run(String(row.id));
          removed += Number(removeReceipt.run(String(row.id)).changes);
        }
        db.exec("RELEASE capability_invocation_prune");
        return removed;
      } catch (error) {
        db.exec("ROLLBACK TO capability_invocation_prune");
        db.exec("RELEASE capability_invocation_prune");
        throw error;
      }
    },
  };
}
