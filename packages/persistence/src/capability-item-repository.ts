import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CapabilityItemId } from "./legacy-company-contracts/index.js";
import type { CapabilityItem, CreateIndustryResearchItemInput, UpdateIndustryResearchItemInput } from "./legacy-company-contracts/index.js";
import { toCapabilityItem } from "./mappers.js";
import type { CapabilityItemRepository, CapabilityItemRow } from "./types.js";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function createCapabilityItemRepository(db: DatabaseSync): CapabilityItemRepository {
  return {
    create(input: CreateIndustryResearchItemInput): CapabilityItem {
      const now = new Date().toISOString();
      const researchScope = trimOptional(input.researchScope);
      const notes = trimOptional(input.notes);
      const item: CapabilityItem = {
        id: randomUUID() as CapabilityItemId,
        type: "industry-research",
        industry: input.industry,
        ...(researchScope !== undefined ? { researchScope } : {}),
        ...(notes !== undefined ? { notes } : {}),
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO capability_items(
          id, type, industry, research_scope, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.type,
        item.industry,
        researchScope ?? null,
        notes ?? null,
        item.createdAt,
        item.updatedAt,
      );
      return item;
    },

    update(
      itemId: CapabilityItemId,
      input: UpdateIndustryResearchItemInput,
    ): CapabilityItem | undefined {
      const researchScope = trimOptional(input.researchScope);
      const notes = trimOptional(input.notes);
      const updatedAt = new Date().toISOString();
      const result = db.prepare(
        `UPDATE capability_items
         SET industry = ?, research_scope = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.industry, researchScope ?? null, notes ?? null, updatedAt, itemId);
      return result.changes === 0 ? undefined : this.getById(itemId);
    },

    delete(itemId: CapabilityItemId): boolean {
      return db.prepare("DELETE FROM capability_items WHERE id = ?").run(itemId).changes > 0;
    },

    list(): CapabilityItem[] {
      const rows = db
        .prepare("SELECT * FROM capability_items ORDER BY created_at DESC, id DESC")
        .all() as unknown as CapabilityItemRow[];
      return rows.map(toCapabilityItem);
    },

    getById(itemId: CapabilityItemId): CapabilityItem | undefined {
      const row = db
        .prepare("SELECT * FROM capability_items WHERE id = ?")
        .get(itemId) as unknown as CapabilityItemRow | undefined;
      return row === undefined ? undefined : toCapabilityItem(row);
    },
  };
}
