import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Company, CompanyId, CompanyDraft } from "@deepfield/contracts";
import { toCompany } from "./mappers.js";
import type { CompanyRepository, CompanyRow } from "./types.js";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeCompanyName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function createCompanyRepository(db: DatabaseSync): CompanyRepository {
  return {
    upsert(draft: CompanyDraft): Company {
      const name = draft.name.trim();
      const countryOrRegion = trimOptional(draft.countryOrRegion);
      const normalizedName = normalizeCompanyName(name);
      if (normalizedName.length === 0) {
        throw new Error("company name must not be blank");
      }
      const existing = db
        .prepare("SELECT * FROM companies WHERE normalized_name = ?")
        .get(normalizedName) as unknown as CompanyRow | undefined;
      if (existing !== undefined) {
        if (countryOrRegion !== undefined) {
          const updatedAt = new Date().toISOString();
          db.prepare(
            "UPDATE companies SET country_or_region = ?, updated_at = ? WHERE id = ?",
          ).run(countryOrRegion, updatedAt, existing.id);
          return toCompany({
            ...existing,
            country_or_region: countryOrRegion,
            updated_at: updatedAt,
          });
        }
        return toCompany(existing);
      }

      const now = new Date().toISOString();
      const company: Company = {
        id: randomUUID() as CompanyId,
        name,
        normalizedName,
        ...(countryOrRegion !== undefined
          ? { countryOrRegion }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO companies(
          id, name, normalized_name, country_or_region, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        company.id,
        company.name,
        company.normalizedName,
        countryOrRegion ?? null,
        company.createdAt,
        company.updatedAt,
      );
      return company;
    },

    list(): Company[] {
      const rows = db
        .prepare("SELECT * FROM companies ORDER BY name COLLATE NOCASE ASC, id ASC")
        .all() as unknown as CompanyRow[];
      return rows.map(toCompany);
    },

    getById(companyId: CompanyId): Company | undefined {
      const row = db
        .prepare("SELECT * FROM companies WHERE id = ?")
        .get(companyId) as unknown as CompanyRow | undefined;
      return row === undefined ? undefined : toCompany(row);
    },

    deleteIfUnreferenced(companyId: CompanyId): boolean {
      return db.prepare(
        `DELETE FROM companies
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM capability_item_companies WHERE company_id = ?
           )`,
      ).run(companyId, companyId).changes > 0;
    },
  };
}
