import { randomUUID } from "node:crypto";
import type { Database } from "@deepfield/base/database";
import type { CapabilityItemId } from "./contracts.js";
import type { CapabilityItem, CreateIndustryResearchItemInput, UpdateIndustryResearchItemInput } from "./contracts.js";
import { toCapabilityItem } from "./mappers.js";
import type { CapabilityItemRepository, CapabilityItemRow } from "./types.js";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function createCapabilityItemRepository(db: Database): CapabilityItemRepository {
  const items = db.table({ name: "capability_items", primaryKey: "id", columns: ["id", "type", "industry", "research_scope", "notes", "created_at", "updated_at"] });
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
      items.insert({ id: item.id, type: item.type, industry: item.industry, research_scope: researchScope ?? null, notes: notes ?? null, created_at: item.createdAt, updated_at: item.updatedAt });
      return item;
    },

    update(
      itemId: CapabilityItemId,
      input: UpdateIndustryResearchItemInput,
    ): CapabilityItem | undefined {
      const researchScope = trimOptional(input.researchScope);
      const notes = trimOptional(input.notes);
      const updatedAt = new Date().toISOString();
      const result = items.update({ id: itemId }, { industry: input.industry, research_scope: researchScope ?? null, notes: notes ?? null, updated_at: updatedAt });
      return result.changes === 0 ? undefined : this.getById(itemId);
    },

    delete(itemId: CapabilityItemId): boolean {
      return items.delete({ id: itemId }).changes > 0;
    },

    list(): CapabilityItem[] {
      const rows = db
        .prepare("SELECT * FROM capability_items ORDER BY created_at DESC, id DESC")
        .all() as unknown as CapabilityItemRow[];
      return rows.map(toCapabilityItem);
    },

    getById(itemId: CapabilityItemId): CapabilityItem | undefined {
      const row = items.findById(itemId) as unknown as CapabilityItemRow | undefined;
      return row === undefined ? undefined : toCapabilityItem(row);
    },
  };
}
