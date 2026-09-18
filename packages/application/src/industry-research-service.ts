import { Value } from "typebox/value";
import {
  AppError,
  CompanyDraftSchema,
  CompanyProfileIdentityHintSchema,
  CreateIndustryResearchItemInputSchema,
  RECOGNITION_CHUNK_MAX_CODE_POINTS,
  UpdateIndustryResearchItemInputSchema,
  countUnicodeCodePoints,
  type CapabilityItem,
  type CapabilityItemId,
  type Company,
  type CompanyDraft,
  type CompanyProfileInput,
  type CompanyProfileIdentityHint,
  type ItemCompany,
  type ItemCompanyView as ContractItemCompanyView,
  type UpdateIndustryResearchItemInput,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import { normalizeCompanyName } from "@deepfield/persistence";
import type { CompanyRecognizer } from "./ports.js";
import { normalizeCompanyProfile } from "./company-profile-validation.js";

export type ItemCompanyView = ContractItemCompanyView;

export class IndustryResearchServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndustryResearchServiceError";
  }
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function requireItem(repositories: Repositories, itemId: CapabilityItemId): CapabilityItem {
  const item = repositories.capabilityItems.getById(itemId);
  if (item === undefined) {
    throw new IndustryResearchServiceError("research item not found");
  }
  return item;
}

function validateDraft(draft: CompanyDraft): CompanyDraft {
  if (!Value.Check(CompanyDraftSchema, draft)) {
    throw new IndustryResearchServiceError("invalid company draft");
  }
  const name = draft.name.trim();
  if (name.length === 0) {
    throw new IndustryResearchServiceError("company name must not be blank");
  }
  const note = trimOptional(draft.note);
  return {
    name,
    ...(note !== undefined ? { note } : {}),
  };
}

function normalizeProfile(input: unknown): CompanyProfileInput {
  try {
    return normalizeCompanyProfile(input);
  } catch {
    throw new IndustryResearchServiceError("invalid company profile");
  }
}

function toView(
  company: Company,
  membership: ItemCompany,
): ItemCompanyView {
  return {
    ...company,
    itemId: membership.itemId,
    ...(membership.note !== undefined ? { note: membership.note } : {}),
  };
}

function findCompanyByNameOrAlias(
  repositories: Repositories,
  name: string,
): Company | undefined {
  const normalizedName = normalizeCompanyName(name);
  const exact = repositories.companies.getByNormalizedName(normalizedName);
  if (exact !== undefined) return exact;
  const aliasMatches = repositories.companies.list().filter((company) =>
    company.aliases?.some((alias) => normalizeCompanyName(alias) === normalizedName) === true,
  );
  return aliasMatches.length === 1 ? aliasMatches[0] : undefined;
}

export class IndustryResearchService {
  constructor(
    private readonly repositories: Repositories,
    private readonly companyRecognizer: CompanyRecognizer,
    private readonly companyEnrichment?: {
      enqueue(companyId: Company["id"]): void;
      retry?(companyId: Company["id"]): boolean;
      confirmIdentity?(companyId: Company["id"], hint: CompanyProfileIdentityHint): boolean;
      getIssue?(): Company["profileIssue"];
    },
  ) {}

  createItem(input: unknown): CapabilityItem {
    if (!Value.Check(CreateIndustryResearchItemInputSchema, input)) {
      throw new IndustryResearchServiceError("invalid research item input");
    }
    const value = input as {
      industry: string;
      researchScope?: string;
      notes?: string;
    };
    const industry = value.industry.trim();
    if (industry.length === 0) {
      throw new IndustryResearchServiceError("industry must not be blank");
    }
    return this.repositories.capabilityItems.create({
      industry,
      ...(value.researchScope !== undefined
        ? { researchScope: value.researchScope.trim() }
        : {}),
      ...(value.notes !== undefined ? { notes: value.notes.trim() } : {}),
    });
  }

  updateItem(itemId: CapabilityItemId, input: unknown): CapabilityItem {
    requireItem(this.repositories, itemId);
    if (!Value.Check(UpdateIndustryResearchItemInputSchema, input)) {
      throw new IndustryResearchServiceError("invalid research item input");
    }
    const value = input as UpdateIndustryResearchItemInput;
    const industry = value.industry.trim();
    if (industry.length === 0) {
      throw new IndustryResearchServiceError("industry must not be blank");
    }
    const researchScope = trimOptional(value.researchScope);
    const notes = trimOptional(value.notes);
    try {
      const updated = this.repositories.capabilityItems.update(itemId, {
        industry,
        ...(researchScope !== undefined ? { researchScope } : {}),
        ...(notes !== undefined ? { notes } : {}),
      });
      if (updated === undefined) {
        throw new IndustryResearchServiceError("research item not found");
      }
      return updated;
    } catch (error) {
      if (error instanceof IndustryResearchServiceError) throw error;
      throw new IndustryResearchServiceError("research item update failed");
    }
  }

  deleteItem(itemId: CapabilityItemId): void {
    this.deleteItems([itemId]);
  }

  deleteItems(itemIds: CapabilityItemId[]): void {
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length === 0) return;
    try {
      this.repositories.runInTransaction(() => {
        const batch = this.repositories.companyResearchBatches.getActive();
        if (batch && uniqueItemIds.includes(batch.itemId as CapabilityItemId)) {
          throw new AppError("BUSINESS.CONFLICT");
        }
        const companyIds = new Set(
          uniqueItemIds.flatMap((itemId) =>
            this.repositories.itemCompanies
              .listByItem(itemId)
              .map((membership) => membership.companyId),
          ),
        );
        for (const itemId of uniqueItemIds) {
          this.repositories.capabilityItems.delete(itemId);
        }
        for (const companyId of companyIds) {
          this.repositories.companies.deleteIfUnreferenced(companyId);
        }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new IndustryResearchServiceError("research item deletion failed");
    }
  }

  listItems(): CapabilityItem[] {
    return this.repositories.capabilityItems.list();
  }

  getItem(itemId: CapabilityItemId): CapabilityItem | undefined {
    return this.repositories.capabilityItems.getById(itemId);
  }

  listCompanies(itemId: CapabilityItemId): ItemCompanyView[] {
    requireItem(this.repositories, itemId);
    const issue = this.companyEnrichment?.getIssue?.();
    const summaries = new Map(this.repositories.companyResearchRuns.summarizeByItem(itemId).map(({ companyId, ...summary }) => [companyId, summary]));
    return this.repositories.itemCompanies.listByItem(itemId).flatMap((membership) => {
      const company = this.repositories.companies.getById(membership.companyId);
      const reportSummary = summaries.get(membership.companyId);
      return company === undefined ? [] : [{ ...toView(company.profileStatus === "pending" && issue ? { ...company, profileIssue: issue } : company, membership), ...(reportSummary ? { reportSummary } : {}) }];
    });
  }

  updateCompany(companyId: Company["id"], input: unknown): Company {
    const normalized = normalizeProfile(input);
    try {
      const updated = this.repositories.companies.update(companyId, normalized);
      if (updated === undefined) {
        throw new IndustryResearchServiceError("company not found");
      }
      return updated;
    } catch (error) {
      if (error instanceof IndustryResearchServiceError) throw error;
      if (error instanceof Error && /already exists/i.test(error.message)) {
        throw new IndustryResearchServiceError("company name already exists");
      }
      throw new IndustryResearchServiceError("company profile update failed");
    }
  }

  addCompany(itemId: CapabilityItemId, draft: CompanyDraft): ItemCompanyView {
    return this.addCompanies(itemId, [draft])[0]!;
  }

  addCompanies(itemId: CapabilityItemId, drafts: CompanyDraft[]): ItemCompanyView[] {
    requireItem(this.repositories, itemId);
    const seen = new Set<string>();
    const validated = drafts.map(validateDraft).filter((draft) => {
      const normalizedName = normalizeCompanyName(draft.name);
      if (seen.has(normalizedName)) {
        return false;
      }
      seen.add(normalizedName);
      return true;
    });
    const newlyCreated: Company["id"][] = [];
    const added = this.repositories.runInTransaction(() => {
      const addedCompanyIds = new Set<Company["id"]>();
      return validated.flatMap((draft) => {
        const existing = findCompanyByNameOrAlias(this.repositories, draft.name);
        const company = existing ?? this.repositories.companies.upsert(draft);
        if (existing === undefined) newlyCreated.push(company.id);
        if (addedCompanyIds.has(company.id)) return [];
        addedCompanyIds.add(company.id);
        const membership = this.repositories.itemCompanies.add(
          itemId,
          company.id,
          draft.note,
        );
        return [toView(company, membership)];
      });
    });
    for (const companyId of newlyCreated) this.companyEnrichment?.enqueue(companyId);
    return added;
  }

  removeCompany(itemId: CapabilityItemId, companyId: Company["id"]): void {
    this.removeCompanies(itemId, [companyId]);
  }

  removeCompanies(itemId: CapabilityItemId, companyIds: Company["id"][]): void {
    const uniqueIds = [...new Set(companyIds)];
    if (uniqueIds.length === 0) return;
    requireItem(this.repositories, itemId);
    try {
      this.repositories.runInTransaction(() => {
        const batch = this.repositories.companyResearchBatches.getActive();
        if (batch?.itemId === itemId && batch.entries.some(entry => uniqueIds.includes(entry.companyId as Company["id"]))) {
          throw new AppError("BUSINESS.CONFLICT");
        }
        for (const companyId of uniqueIds) {
          this.repositories.itemCompanies.remove(itemId, companyId);
          this.repositories.companies.deleteIfUnreferenced(companyId);
        }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new IndustryResearchServiceError("company removal failed");
    }
  }

  retryCompanyProfile(companyId: Company["id"]): boolean {
    if (this.repositories.companies.getById(companyId) === undefined) {
      throw new IndustryResearchServiceError("company not found");
    }
    return this.companyEnrichment?.retry?.(companyId) ?? false;
  }

  confirmCompanyProfileIdentity(companyId: Company["id"], input: unknown): boolean {
    if (this.repositories.companies.getById(companyId) === undefined) {
      throw new IndustryResearchServiceError("company not found");
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new IndustryResearchServiceError("invalid company identity hint");
    }
    const raw = input as Record<string, unknown>;
    const hint = {
      ...raw,
      name: typeof raw.name === "string" ? raw.name.trim() : raw.name,
      ...(typeof raw.officialWebsite === "string" ? { officialWebsite: raw.officialWebsite.trim() } : {}),
    };
    if (!Value.Check(CompanyProfileIdentityHintSchema, hint)) {
      throw new IndustryResearchServiceError("invalid company identity hint");
    }
    const normalizedHint = hint as CompanyProfileIdentityHint;
    if (normalizedHint.officialWebsite !== undefined) {
      try {
        const website = new URL(normalizedHint.officialWebsite);
        if ((website.protocol !== "http:" && website.protocol !== "https:") || !website.hostname) {
          throw new Error("invalid website");
        }
      } catch {
        throw new IndustryResearchServiceError("invalid company identity hint");
      }
    }
    return this.companyEnrichment?.confirmIdentity?.(companyId, normalizedHint) ?? false;
  }

  async recognizeCompanies(itemId: CapabilityItemId, text: string): Promise<CompanyDraft[]> {
    requireItem(this.repositories, itemId);
    if (text.trim().length === 0) {
      throw new IndustryResearchServiceError("recognition text must not be blank");
    }
    if (countUnicodeCodePoints(text) > RECOGNITION_CHUNK_MAX_CODE_POINTS) {
      throw new IndustryResearchServiceError("company recognition failed");
    }
    try {
      const seen = new Set<string>();
      return (await this.companyRecognizer.recognize(text)).flatMap((draft) => {
        const normalized = validateDraft(draft);
        const normalizedName = normalizeCompanyName(normalized.name);
        if (seen.has(normalizedName)) {
          return [];
        }
        seen.add(normalizedName);
        return [{ name: normalized.name }];
      });
    } catch {
      throw new IndustryResearchServiceError("company recognition failed");
    }
  }
}
