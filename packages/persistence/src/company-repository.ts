import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Company,
  CompanyId,
  CompanyDraft,
  CompanyProfileFields,
  CompanyProfileInput,
  CompanyProfileIdentityHint,
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
          stock_listings_json = ?, business_tags_json = ?, profile_status = 'ready', updated_at = ?,
          profile_provenance_json = NULL, profile_issue_json = NULL, profile_identity_hint_json = NULL
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

    completeProfile(companyId, fields, provenance): Company | undefined {
      const existing = repository.getById(companyId);
      if (!existing || existing.profileStatus !== "enriching") return undefined;
      const added = Object.fromEntries(Object.entries(fields).filter(([key]) => existing[key as keyof Company] === undefined)) as CompanyProfileFields;
      const stored = provenance === undefined ? undefined : { ...provenance, fields: added,
        fieldEvidence: Object.fromEntries(Object.entries(provenance.fieldEvidence).filter(([field]) => field in added)) };
      // One guarded statement commits values and evidence together. A manual
      // update changes status to ready, invalidating an obsolete completion.
      const result = db.prepare(`UPDATE companies SET
        legal_name = COALESCE(legal_name, ?), aliases_json = COALESCE(aliases_json, ?),
        headquarters = COALESCE(headquarters, country_or_region, ?), founded_at = COALESCE(founded_at, ?),
        official_website_json = COALESCE(official_website_json, ?), stock_listings_json = COALESCE(stock_listings_json, ?),
        business_tags_json = COALESCE(business_tags_json, ?), profile_status = ?, profile_provenance_json = ?, profile_issue_json = NULL,
        profile_identity_hint_json = CASE WHEN ? = 'ready' THEN NULL ELSE profile_identity_hint_json END, updated_at = ?
        WHERE id = ? AND profile_status = 'enriching'`).run(
        added.legalName ?? null, added.aliases === undefined ? null : JSON.stringify(added.aliases),
        added.headquarters ?? null, added.foundedAt ?? null,
        added.officialWebsite === undefined ? null : JSON.stringify(added.officialWebsite),
        added.stockListings === undefined ? null : JSON.stringify(added.stockListings),
        added.businessTags === undefined ? null : JSON.stringify(added.businessTags),
        provenance && provenance.identity.disposition !== "matched" ? "failed" : "ready",
        stored === undefined ? null : JSON.stringify(stored),
        provenance && provenance.identity.disposition !== "matched" ? "failed" : "ready",
        new Date().toISOString(), companyId,
      );
      return result.changes === 0 ? undefined : repository.getById(companyId);
    },

    confirmProfileIdentity(companyId: CompanyId, hint: CompanyProfileIdentityHint): Company | undefined {
      const result = db.prepare(`UPDATE companies SET
        profile_identity_hint_json = ?, profile_status = 'pending',
        profile_issue_json = NULL, profile_provenance_json = NULL, updated_at = ?
        WHERE id = ? AND profile_status = 'failed'`).run(
        JSON.stringify(hint), new Date().toISOString(), companyId,
      );
      return result.changes === 0 ? undefined : repository.getById(companyId);
    },

    setProfileStatus(companyId, status, issue): Company | undefined {
      const updatedAt = new Date().toISOString();
      const result = db
        .prepare(`UPDATE companies SET profile_status = ?, profile_issue_json = ?, updated_at = ?,
          profile_provenance_json = CASE WHEN ? IN ('pending', 'enriching') THEN NULL ELSE profile_provenance_json END
          WHERE id = ?`)
        .run(status, issue === undefined ? null : JSON.stringify(issue), updatedAt, status, companyId);
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
