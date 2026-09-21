import type { DatabaseSync } from "node:sqlite";
import type { CapabilityItemId, CompanyId } from "./legacy-company-contracts/index.js";
import type { ItemCompany } from "./legacy-company-contracts/index.js";
import { toItemCompany } from "./mappers.js";
import type { ItemCompanyRepository, ItemCompanyRow } from "./types.js";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function createItemCompanyRepository(db: DatabaseSync): ItemCompanyRepository {
  return {
    add(itemId: CapabilityItemId, companyId: CompanyId, note?: string): ItemCompany {
      const now = new Date().toISOString();
      const normalizedNote = trimOptional(note);
      db.prepare(
        `INSERT OR IGNORE INTO capability_item_companies(
          item_id, company_id, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(itemId, companyId, normalizedNote ?? null, now, now);
      const row = db
        .prepare(
          "SELECT * FROM capability_item_companies WHERE item_id = ? AND company_id = ?",
        )
        .get(itemId, companyId) as unknown as ItemCompanyRow | undefined;
      if (row === undefined) {
        throw new Error("item-company membership was not created");
      }
      return toItemCompany(row);
    },

    listByItem(itemId: CapabilityItemId): ItemCompany[] {
      const rows = db
        .prepare(
          "SELECT * FROM capability_item_companies WHERE item_id = ? ORDER BY created_at ASC, company_id ASC",
        )
        .all(itemId) as unknown as ItemCompanyRow[];
      return rows.map(toItemCompany);
    },

    remove(itemId: CapabilityItemId, companyId: CompanyId): void {
      db.prepare(
        "DELETE FROM capability_item_companies WHERE item_id = ? AND company_id = ?",
      ).run(itemId, companyId);
    },
  };
}
