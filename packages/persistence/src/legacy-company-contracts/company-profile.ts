/** Frozen legacy SQLite validation contract. Do not depend on optional capability code. */
import { Type, type Static } from "typebox";
import { CompanyProfileFieldsSchema, CompanyProfileIdentityHintSchema } from "./capability-items.js";
import { LlmRuntimeSnapshotSchema, SearchRuntimeSnapshotSchema } from "../../../contracts/src/settings.js";
import { CompanyResearchModelDiagnosticSchema, CompanyResearchModelErrorCategorySchema } from "./research.js";

const text = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
export const ProfileSourceRefSchema = Type.Object({
  url: text,
  kind: Type.Union([Type.Literal("search_snippet"), Type.Literal("opened_page")]),
}, { additionalProperties: false });
export const ProfileSourceSchema = Type.Object({
  ...ProfileSourceRefSchema.properties, title: text, excerpt: text,
}, { additionalProperties: false });
const refs = Type.Array(ProfileSourceRefSchema, { minItems: 1, maxItems: 10 });
export const ProfileFieldEvidenceSchema = Type.Object(Object.fromEntries(
  Object.keys(CompanyProfileFieldsSchema.properties).map((key) => [key, Type.Optional(refs)]),
), { additionalProperties: false });
export const CompanyProfileCandidateSchema = Type.Object({
  identity: Type.Union([
    Type.Object({ disposition: Type.Literal("matched"), matchedName: text, reason: text, sources: refs }, { additionalProperties: false }),
    Type.Object({ disposition: Type.Union([Type.Literal("ambiguous"), Type.Literal("unresolved")]), reason: text, sources: refs }, { additionalProperties: false }),
  ]),
  fields: CompanyProfileFieldsSchema,
  fieldEvidence: ProfileFieldEvidenceSchema,
}, { additionalProperties: false });
export const CompanyProfileResultSchema = Type.Object({
  ...CompanyProfileCandidateSchema.properties,
  sources: Type.Array(ProfileSourceSchema, { minItems: 1, maxItems: 40 }),
}, { additionalProperties: false });
export type CompanyProfileResult = Static<typeof CompanyProfileResultSchema>;
export type ProfileSource = Static<typeof ProfileSourceSchema>;
export type ProfileSourceRef = Static<typeof ProfileSourceRefSchema>;
export const CompanyProfileWorkerRequestSchema = Type.Object({
  kind: Type.Literal("company-profile.enrich"), requestId: text, companyId: text, name: text,
  researchTopics: Type.Array(text, { maxItems: 100 }),
  existingFields: CompanyProfileFieldsSchema,
  identityHint: Type.Optional(CompanyProfileIdentityHintSchema),
  llm: LlmRuntimeSnapshotSchema, search: SearchRuntimeSnapshotSchema,
}, { additionalProperties: false });
export type CompanyProfileWorkerRequest = Static<typeof CompanyProfileWorkerRequestSchema>;
const identity = { kind: Type.Literal("company-profile.event"), requestId: text, companyId: text };
export const ProfileDiagnosticCodeSchema = Type.Union([Type.Literal("ok"), Type.Literal("json_parse"), Type.Literal("schema_invalid"), Type.Literal("source_missing"), Type.Literal("kind_mismatch"), Type.Literal("empty_field"), Type.Literal("identity"), Type.Literal("search_unavailable"), Type.Literal("agent_failed")]);
const diagnosticPath = Type.String({ maxLength: 160, pattern: "^(?:/(?:identity|disposition|matchedName|reason|sources|fields|fieldEvidence|legalName|aliases|headquarters|foundedAt|officialWebsite|stockListings|businessTags|exchange|ticker|url|kind|\\*|[0-9]{1,3})){0,8}$" });
const actualType = Type.Union([Type.Literal("object"), Type.Literal("array"), Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("null"), Type.Literal("undefined")]);
export const ProfileSchemaIssueSchema = Type.Object({
  path: diagnosticPath,
  expected: Type.Union([Type.Literal("object"), Type.Literal("array"), Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("null"), Type.Literal("required"), Type.Literal("allowed_property"), Type.Literal("enum"), Type.Literal("pattern"), Type.Literal("minItems"), Type.Literal("maxItems"), Type.Literal("minLength"), Type.Literal("maxLength"), Type.Literal("anyOf"), Type.Literal("schema")]),
  actual: actualType,
}, { additionalProperties: false });
export type ProfileSchemaIssue = Static<typeof ProfileSchemaIssueSchema>;
export const CompanyProfileDiagnosticSchema = Type.Object({
  ...identity, type: Type.Literal("diagnostic"),
  phase: Type.Union([Type.Literal("agent"), Type.Literal("json_parse"), Type.Literal("schema"), Type.Literal("evidence"), Type.Literal("complete")]),
  code: ProfileDiagnosticCodeSchema,
  path: Type.Optional(diagnosticPath),
  schemaIssues: Type.Array(ProfileSchemaIssueSchema, { maxItems: 20 }),
  searchSourceCount: Type.Integer({ minimum: 0, maximum: 1000 }),
  openedSourceCount: Type.Integer({ minimum: 0, maximum: 1000 }),
  searchToolCalls: Type.Integer({ minimum: 0, maximum: 1000 }),
  readToolCalls: Type.Integer({ minimum: 0, maximum: 1000 }),
  outputChars: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
  piError: Type.Optional(CompanyResearchModelErrorCategorySchema),
  formatRepair: Type.Optional(Type.Object({
    attempted: Type.Literal(true),
    outcome: Type.Union([
      Type.Literal("succeeded"), Type.Literal("invalid"),
      Type.Literal("failed"), Type.Literal("cancelled"),
    ]),
    durationMs: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  model: Type.Optional(Type.Pick(CompanyResearchModelDiagnosticSchema, ["phase", "agentTurns", "searchCalls", "fetchCalls", "maxModelInputCharsEstimate", "outputChars", "stopReason", "errorCategory", "startedAt", "finishedAt", "durationMs"])),
}, { additionalProperties: false });
export type CompanyProfileDiagnostic = Static<typeof CompanyProfileDiagnosticSchema>;
export const CompanyProfileWorkerEventSchema = Type.Union([
  CompanyProfileDiagnosticSchema,
  Type.Object({ ...identity, type: Type.Literal("completed"), result: CompanyProfileResultSchema }, { additionalProperties: false }),
  Type.Object({ ...identity, type: Type.Literal("failed"), code: Type.Union([
    Type.Literal("search_unavailable"), Type.Literal("invalid_evidence"), Type.Literal("agent_failed"),
  ]) }, { additionalProperties: false }),
]);
export type CompanyProfileWorkerEvent = Static<typeof CompanyProfileWorkerEventSchema>;
