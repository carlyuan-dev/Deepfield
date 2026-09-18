import { Type, type Static } from "typebox";
import type { CapabilityItemId, CompanyId } from "./ids.js";
import { PublicAppErrorSchema, type PublicAppError } from "./errors.js";
import type { CompanyProfileResult } from "./company-profile.js";

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
    name: Type.String({ minLength: 1, maxLength: 300 }),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompanyDraft = Static<typeof CompanyDraftSchema>;

export const StockListingSchema = Type.Object(
  {
    exchange: Type.String({ minLength: 1, maxLength: 100 }),
    ticker: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export type StockListing = Static<typeof StockListingSchema>;

export const CompanyProfileInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 300 }),
    legalName: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    aliases: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 100 }),
    ),
    headquarters: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    foundedAt: Type.Optional(
      Type.String({ pattern: "^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$" }),
    ),
    officialWebsite: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
    ),
    stockListings: Type.Optional(Type.Array(StockListingSchema, { maxItems: 100 })),
    businessTags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: 5,
      }),
    ),
  },
  { additionalProperties: false },
);
export type CompanyProfileInput = Static<typeof CompanyProfileInputSchema>;
export const CompanyProfileFieldsSchema = Type.Omit(CompanyProfileInputSchema, ["name"]);
export type CompanyProfileFields = Static<typeof CompanyProfileFieldsSchema>;
export const CompanyProfileIdentityHintSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" }),
  officialWebsite: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, pattern: "^https?://\\S+$" })),
}, { additionalProperties: false });
export type CompanyProfileIdentityHint = Static<typeof CompanyProfileIdentityHintSchema>;
export type CompanyProfileStatus = "pending" | "enriching" | "ready" | "failed";

export const CompanyProfileEventSchema = Type.Object(
  {
    companyId: Type.String({ minLength: 1 }),
    issue: Type.Optional(PublicAppErrorSchema),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("enriching"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);
export type CompanyProfileEvent = Static<typeof CompanyProfileEventSchema>;

export interface Company {
  id: CompanyId;
  name: string;
  normalizedName: string;
  profileStatus: CompanyProfileStatus;
  profileProvenance?: CompanyProfileResult;
  profileIssue?: PublicAppError;
  profileIdentityHint?: CompanyProfileIdentityHint;
  legalName?: string;
  aliases?: string[];
  headquarters?: string;
  foundedAt?: string;
  officialWebsite?: string | null;
  stockListings?: StockListing[];
  businessTags?: string[];
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
  reportSummary?: { count: number; latestCreatedAt: string };
}
