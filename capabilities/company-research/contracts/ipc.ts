import { Type, type Static } from "typebox";
import { CompanyProfileIdentityHintSchema } from "./capability-items.js";
import { StartCompanyResearchInputSchema } from "./research.js";

const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
export const CompanyResearchStartArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  StartCompanyResearchInputSchema,
]);
export const CompanyResearchCancelArgsSchema = Type.Tuple([IdSchema]);
export const CompanyResearchTargetArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
]);
export const CompanyResearchSubscribeArgsSchema = Type.Tuple([]);
export const CompanyResearchGetRunArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  IdSchema,
]);
export const CompanyResearchWordExportSelectionSchema = Type.Object({
  raw: Type.Boolean(),
  structured: Type.Boolean(),
}, { additionalProperties: false });
export type CompanyResearchWordExportSelection = Static<typeof CompanyResearchWordExportSelectionSchema>;
export const CompanyResearchExportArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  IdSchema,
  CompanyResearchWordExportSelectionSchema,
]);
export const CompanyResearchWordExportResultSchema = Type.Object({
  status: Type.Union([Type.Literal("saved"), Type.Literal("cancelled")]),
}, { additionalProperties: false });
export type CompanyResearchWordExportResult = Static<typeof CompanyResearchWordExportResultSchema>;
export const CompanyResearchRetryFailedArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  IdSchema,
  StartCompanyResearchInputSchema,
]);
export const CompanyResearchDeleteRunArgsSchema = Type.Tuple([IdSchema, IdSchema, IdSchema]);
export const CompanyResearchRetryStructuringArgsSchema = Type.Tuple([IdSchema, IdSchema, IdSchema]);
export const ConfirmCompanyProfileIdentityArgsSchema = Type.Tuple([
  IdSchema,
  CompanyProfileIdentityHintSchema,
]);
