import { Type } from "typebox";
import { PublicAppErrorSchema } from "@deepfield/contracts";
import { CompanyProfileInputSchema, CompanyProfileIdentityHintSchema } from "./capability-items.js";
import { CompanyProfileResultSchema } from "./company-profile.js";

export const CapabilityItemSchema = Type.Object({ id: Type.String(), type: Type.Literal("industry-research"), industry: Type.String(), researchScope: Type.Optional(Type.String()), notes: Type.Optional(Type.String()), createdAt: Type.String(), updatedAt: Type.String() }, { additionalProperties: false });
export const CompanySchema = Type.Object({ ...CompanyProfileInputSchema.properties, id: Type.String(), normalizedName: Type.String(), profileStatus: Type.Union([Type.Literal("pending"), Type.Literal("enriching"), Type.Literal("ready"), Type.Literal("failed")]), profileProvenance: Type.Optional(CompanyProfileResultSchema), profileIssue: Type.Optional(PublicAppErrorSchema), profileIdentityHint: Type.Optional(CompanyProfileIdentityHintSchema), createdAt: Type.String(), updatedAt: Type.String() }, { additionalProperties: false });
export const ItemCompanyViewSchema = Type.Object({ ...CompanySchema.properties, itemId: Type.String(), note: Type.Optional(Type.String()), reportSummary: Type.Optional(Type.Object({ count: Type.Integer({ minimum: 0 }), latestCreatedAt: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false });
