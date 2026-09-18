import type { DatabaseSync } from "node:sqlite";
import type { CompanyResearchBatchState } from "@deepfield/contracts";
export function createCompanyResearchBatchRepository(db: DatabaseSync) {
  const decode = (row: unknown): CompanyResearchBatchState | undefined => row ? JSON.parse((row as { snapshot: string }).snapshot) as CompanyResearchBatchState : undefined;
  return {
    deleteTerminal: (id: string) => { db.prepare("DELETE FROM company_research_batches WHERE id = ? AND status IN ('completed','cancelled')").run(id); },
    deleteAllTerminal: () => { db.prepare("DELETE FROM company_research_batches WHERE status IN ('completed','cancelled')").run(); },
    getActive: () => decode(db.prepare("SELECT snapshot FROM company_research_batches WHERE status NOT IN ('completed','cancelled') LIMIT 1").get()),
    getById: (id: string) => decode(db.prepare("SELECT snapshot FROM company_research_batches WHERE id = ?").get(id)),
    getLatest: (itemId: string) => decode(db.prepare("SELECT snapshot FROM company_research_batches WHERE item_id = ? ORDER BY rowid DESC LIMIT 1").get(itemId)),
    save(state: CompanyResearchBatchState) {
      db.prepare("INSERT INTO company_research_batches(id,item_id,status,snapshot) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,snapshot=excluded.snapshot").run(state.batchId, state.itemId, state.status, JSON.stringify(state));
    },
  };
}
