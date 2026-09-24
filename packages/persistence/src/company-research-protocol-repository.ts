import type { DatabaseSync } from "node:sqlite";

/** Opaque package-owned JSON; host storage does not interpret drafts or task state. */
export function createCompanyResearchProtocolRepository(db: DatabaseSync) {
  const decode = (row: unknown): string | undefined => row ? (row as { data: string }).data : undefined;
  return {
    getDraft: (id: string) => decode(db.prepare("SELECT data FROM company_research_drafts WHERE id=?").get(id)),
    deleteDraft(id: string) { db.prepare("DELETE FROM company_research_drafts WHERE id=?").run(id); },
    saveDraft(id: string, data: string) { db.prepare("INSERT INTO company_research_drafts(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, data); },
    getTask: (id: string) => decode(db.prepare("SELECT data FROM company_research_tasks WHERE id=?").get(id)),
    findTask: (invocation: string) => decode(db.prepare("SELECT data FROM company_research_tasks WHERE invocation_id=?").get(invocation)),
    saveTask(id: string, invocation: string, data: string, finishedAt?: string) {
      db.prepare("INSERT INTO company_research_tasks(id,invocation_id,data,finished_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,finished_at=excluded.finished_at").run(id, invocation, data, finishedAt ?? null);
    },
    prune(before: string) { db.prepare("DELETE FROM company_research_tasks WHERE finished_at IS NOT NULL AND finished_at < ?").run(before); },
  };
}
