import { Type, type Static } from "typebox";
import { CompanyProfileCandidateSchema, ProfileSourceRefSchema, type ProfileSource } from "../contracts/index.js";

/** Model-only references; persisted profiles keep their original URL/kind contract. */
const refs = Type.Array(Type.Union([
  Type.Object({ evidenceId: Type.String({ pattern: "^e[1-9][0-9]*$" }) }, { additionalProperties: false }),
  ProfileSourceRefSchema,
]), { minItems: 1, maxItems: 10 });
const text = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
export const CompanyProfileModelCandidateSchema = Type.Object({
  identity: Type.Union([
    Type.Object({ disposition: Type.Literal("matched"), subjectType: Type.Union([Type.Literal("company"), Type.Literal("brand"), Type.Literal("product")]), matchedName: text, reason: text, sources: refs }, { additionalProperties: false }),
    Type.Object({ disposition: Type.Union([Type.Literal("ambiguous"), Type.Literal("unresolved")]), reason: text, sources: refs }, { additionalProperties: false }),
  ]),
  fields: CompanyProfileCandidateSchema.properties.fields,
  fieldEvidence: Type.Object(Object.fromEntries(Object.keys(CompanyProfileCandidateSchema.properties.fieldEvidence.properties).map(field => [field, Type.Optional(refs)])), { additionalProperties: false }),
}, { additionalProperties: false });
export type CompanyProfileModelCandidate = Static<typeof CompanyProfileModelCandidateSchema>;
export type ProfileCatalogSource = ProfileSource & { evidenceId: string };
