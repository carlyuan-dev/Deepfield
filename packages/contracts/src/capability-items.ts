import { Type, type Static } from "typebox";
import type { CapabilityItemId, CompanyId } from "./ids.js";

export const CreateIndustryResearchItemInputSchema = Type.Object(
  {
    industry: Type.String({ minLength: 1 }),
    researchScope: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CreateIndustryResearchItemInput = Static<typeof CreateIndustryResearchItemInputSchema>;

export const UpdateIndustryResearchItemInputSchema = Type.Object(
  {
    industry: Type.String({ minLength: 1 }),
    researchScope: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type UpdateIndustryResearchItemInput = Static<typeof UpdateIndustryResearchItemInputSchema>;

export interface CapabilityItem {
  id: CapabilityItemId;
  type: "industry-research";
  industry: string;
  researchScope?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export const CompanyDraftSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    countryOrRegion: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompanyDraft = Static<typeof CompanyDraftSchema>;

export interface Company {
  id: CompanyId;
  name: string;
  normalizedName: string;
  countryOrRegion?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ItemCompany {
  itemId: CapabilityItemId;
  companyId: CompanyId;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ItemCompanyView extends Company {
  itemId: CapabilityItemId;
  note?: string;
}
