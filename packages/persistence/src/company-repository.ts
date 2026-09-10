import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Company,
  CompanyId,
  CompanyDraft,
  CompanyProfileFields,
  CompanyProfileInput,
  CompanyProfileStatus,
} from "@deepfield/contracts";
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
  const repository: CompanyRepository = {
    upsert(draft: CompanyDraft): Company {
      const name = draft.name.trim();
      const normalizedName = normalizeCompanyName(name);
      if (normalizedName.length === 0) {
        throw new Error("company name must not be blank");
      }
      const existing = db
        .prepare("SELECT * FROM companies WHERE normalized_name = ?")
        .get(normalizedName) as unknown as CompanyRow | undefined;
      if (existing !== undefined) {
        return toCompany(existing);
      }

      const now = new Date().toISOString();
      const company: Company = {
        id: randomUUID() as CompanyId,
        name,
        normalizedName,
        profileStatus: "pending",
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO companies(
          id, name, normalized_name, country_or_region, profile_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        company.id,
        company.name,
        company.normalizedName,
        null,
        company.profileStatus,
        company.createdAt,
        company.updatedAt,
      );
      return company;
    },

    update(companyId: CompanyId, input: CompanyProfileInput): Company | undefined {
      const existing = db
        .prepare("SELECT * FROM companies WHERE id = ?")
        .get(companyId) as unknown as CompanyRow | undefined;
      if (existing === undefined) {
        return undefined;
      }
      const name = input.name.trim();
      const normalizedName = normalizeCompanyName(name);
      if (normalizedName.length === 0) {
        throw new Error("company name must not be blank");
      }
      const conflict = db
        .prepare("SELECT id FROM companies WHERE normalized_name = ? AND id <> ?")
        .get(normalizedName, companyId) as { id: string } | undefined;
      if (conflict !== undefined) {
        throw new Error("company with this normalized name already exists");
      }

      const updatedAt = new Date().toISOString();
      const legalName = trimOptional(input.legalName);
      const headquarters = trimOptional(input.headquarters);
      const foundedAt = trimOptional(input.foundedAt);
      const aliases = input.aliases?.map((alias) => alias.trim());
      const stockListings = input.stockListings?.map(({ exchange, ticker }) => ({
        exchange: exchange.trim(),
        ticker: ticker.trim(),
      }));
      const businessTags = input.businessTags?.map((tag) => tag.trim());
      const officialWebsite =
        typeof input.officialWebsite === "string"
          ? input.officialWebsite.trim()
          : input.officialWebsite;
      db.prepare(
        `UPDATE companies SET
          name = ?, normalized_name = ?, country_or_region = NULL, legal_name = ?, aliases_json = ?,
          headquarters = ?, founded_at = ?, official_website_json = ?,
          stock_listings_json = ?, business_tags_json = ?, profile_status = 'ready', updated_at = ?
         WHERE id = ?`,
      ).run(
        name,
        normalizedName,
        legalName ?? null,
        aliases === undefined ? null : JSON.stringify(aliases),
        headquarters ?? null,
        foundedAt ?? null,
        officialWebsite === undefined ? null : JSON.stringify(officialWebsite),
        stockListings === undefined ? null : JSON.stringify(stockListings),
        businessTags === undefined ? null : JSON.stringify(businessTags),
        updatedAt,
        companyId,
      );
      const updated = db
        .prepare("SELECT * FROM companies WHERE id = ?")
        .get(companyId) as unknown as CompanyRow;
      return toCompany(updated);
    },

    completeProfile(companyId: CompanyId, fields: CompanyProfileFields): Company | undefined {
      const existing = repository.getById(companyId);
      return existing === undefined
        ? undefined
        : repository.update(companyId, { name: existing.name, ...fields });
    },

    setProfileStatus(companyId: CompanyId, status: CompanyProfileStatus): Company | undefined {
      const updatedAt = new Date().toISOString();
      const result = db
        .prepare("UPDATE companies SET profile_status = ?, updated_at = ? WHERE id = ?")
        .run(status, updatedAt, companyId);
      return result.changes === 0 ? undefined : repository.getById(companyId);
    },

    getNextPendingProfile(): Company | undefined {
      const row = db
        .prepare(
          `SELECT * FROM companies
           WHERE profile_status = 'pending'
           ORDER BY rowid ASC
           LIMIT 1`,
        )
        .get() as unknown as CompanyRow | undefined;
      return row === undefined ? undefined : toCompany(row);
    },

    resetEnrichingProfiles(): number {
      return Number(db
        .prepare("UPDATE companies SET profile_status = 'pending' WHERE profile_status = 'enriching'")
        .run().changes);
    },

    getByNormalizedName(normalizedName: string): Company | undefined {
      const row = db
        .prepare("SELECT * FROM companies WHERE normalized_name = ?")
        .get(normalizedName) as unknown as CompanyRow | undefined;
      return row === undefined ? undefined : toCompany(row);
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
  return repository;
}
