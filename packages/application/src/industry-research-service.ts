import { Value } from "typebox/value";
import {
  CompanyDraftSchema,
  CreateIndustryResearchItemInputSchema,
  RECOGNITION_CHUNK_MAX_CODE_POINTS,
  UpdateIndustryResearchItemInputSchema,
  countUnicodeCodePoints,
  type CapabilityItem,
  type CapabilityItemId,
  type Company,
  type CompanyDraft,
  type ItemCompany,
  type ItemCompanyView as ContractItemCompanyView,
  type UpdateIndustryResearchItemInput,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import { normalizeCompanyName } from "@deepfield/persistence";
import type { CompanyRecognizer } from "./ports.js";

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
  const countryOrRegion = trimOptional(draft.countryOrRegion);
  const note = trimOptional(draft.note);
  return {
    name,
    ...(countryOrRegion !== undefined ? { countryOrRegion } : {}),
    ...(note !== undefined ? { note } : {}),
  };
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

export class IndustryResearchService {
  constructor(
    private readonly repositories: Repositories,
    private readonly companyRecognizer: CompanyRecognizer,
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
    } catch {
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
    return this.repositories.itemCompanies.listByItem(itemId).flatMap((membership) => {
      const company = this.repositories.companies.getById(membership.companyId);
      return company === undefined ? [] : [toView(company, membership)];
    });
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
    return this.repositories.runInTransaction(() => {
      return validated.map((draft) => {
        const company = this.repositories.companies.upsert(draft);
        const membership = this.repositories.itemCompanies.add(
          itemId,
          company.id,
          draft.note,
        );
        return toView(company, membership);
      });
    });
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
        for (const companyId of uniqueIds) {
          this.repositories.itemCompanies.remove(itemId, companyId);
          this.repositories.companies.deleteIfUnreferenced(companyId);
        }
      });
    } catch {
      throw new IndustryResearchServiceError("company removal failed");
    }
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
        return [normalized];
      });
    } catch {
      throw new IndustryResearchServiceError("company recognition failed");
    }
  }
}
