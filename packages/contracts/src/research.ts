import { Type, type Static } from "typebox";
import { LlmRuntimeSnapshotSchema, SearchRuntimeSnapshotSchema, ToolAccessPolicySchema } from "./settings.js";
import type { CapabilityItemId, CompanyId, ResearchRunId } from "./ids.js";
import { CompanyProfileFieldsSchema } from "./capability-items.js";
import { CompanyResearchTemplateSnapshotSchema, ResearchDirectionSchema } from "./company-research-templates.js";
import type { JsonObject } from "./tools.js";

const DateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const TimestampSchema = Type.String({ minLength: 1, maxLength: 64 });
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
const TextSchema = Type.String({ minLength: 1, maxLength: 4000 });
// Bound transport/storage bodies; semantic output checks remain in the Harness.
const ReportTextSchema = Type.String({ minLength: 1, maxLength: 1_000_000 });
// Historical completed reports were only required to be nonblank, with no size cap.
const LegacyReportTextSchema = Type.String({ minLength: 1, pattern: "\\S" });

export const StartCompanyResearchInputSchema = Type.Object({
  direction: ResearchDirectionSchema,
  focusScope: Type.Optional(Type.String({ maxLength: 1000 })),
  asOfDate: DateSchema,
}, { additionalProperties: false });
export type StartCompanyResearchInput = Static<typeof StartCompanyResearchInputSchema>;

export const ResearchSectionStatusSchema = Type.Union([
  Type.Literal("found"), Type.Literal("partial"), Type.Literal("not_found"),
  Type.Literal("not_disclosed"), Type.Literal("conflicting"),
]);
export type ResearchSectionStatus = Static<typeof ResearchSectionStatusSchema>;
export const RESEARCH_SECTION_STATUS_LABELS = Object.freeze({
  found: "已找到", partial: "部分找到", not_found: "未找到",
  not_disclosed: "未披露", conflicting: "存在冲突",
} satisfies Record<ResearchSectionStatus, string>);

export const ResearchClaimTypeSchema = Type.Union([
  Type.Literal("reported_fact"), Type.Literal("company_statement"),
  Type.Literal("plan"), Type.Literal("estimate"), Type.Literal("forecast"),
]);
export type ResearchClaimType = Static<typeof ResearchClaimTypeSchema>;

export const StructuredResearchContentSchema = Type.Object({
  coreSummary: Type.Array(TextSchema, { minItems: 1, maxItems: 4 }),
  sections: Type.Array(Type.Object({
    sectionId: Type.String({ minLength: 1, maxLength: 100 }),
    status: ResearchSectionStatusSchema,
    summary: Type.Union([TextSchema, Type.Null()]),
    facts: Type.Array(Type.Object({
      text: TextSchema,
      timeContext: Type.Union([TextSchema, Type.Null()]),
      claimType: ResearchClaimTypeSchema,
      source: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 1000 }),
        url: Type.String({ minLength: 1, maxLength: 4000 }),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }), { maxItems: 8 }),
  }, { additionalProperties: false }), { minItems: 5, maxItems: 5 }),
}, { additionalProperties: false });
export type StructuredResearchContent = Static<typeof StructuredResearchContentSchema>;
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Plain JSON Schema for IPC/provider requests, without TypeBox's hidden metadata. */
export const STRUCTURED_RESEARCH_OUTPUT_SCHEMA: JsonObject = freezeJson(JSON.parse(JSON.stringify(StructuredResearchContentSchema)));

export const CompanyResearchContextSchema = Type.Object({
  ...CompanyProfileFieldsSchema.properties,
  currentDate: DateSchema,
  companyName: Type.String({ minLength: 1, maxLength: 300 }),
  topicName: Type.String({ minLength: 1, maxLength: 300 }),
  topicScope: Type.Optional(Type.String({ maxLength: 4000 })),
  companyNote: Type.Optional(Type.String({ maxLength: 4000 })),
  ...StartCompanyResearchInputSchema.properties,
}, { additionalProperties: false });
export type CompanyResearchContext = Static<typeof CompanyResearchContextSchema>;

const RunIdentity = {
  id: Type.Unsafe<ResearchRunId>(IdSchema),
  itemId: Type.Unsafe<CapabilityItemId>(IdSchema),
  companyId: Type.Unsafe<CompanyId>(IdSchema),
  createdAt: TimestampSchema,
};
export const KeyResearchStatusSchema = Type.Union([
  Type.Literal("researching"), Type.Literal("research_failed"), Type.Literal("structuring"),
  Type.Literal("structure_failed"), Type.Literal("completed"),
]);
export type KeyResearchStatus = Static<typeof KeyResearchStatusSchema>;

export const ResearchFailureCodeSchema = Type.Union([
  Type.Literal("structuring_failed"),
  Type.Literal("tool_failed"),
  Type.Literal("model_failed"),
  Type.Literal("empty_report"),
  Type.Literal("protocol_leak"),
  Type.Literal("language_validation_failed"),
  Type.Literal("incomplete_response"),
  Type.Literal("protocol_error"),
  Type.Literal("storage_failed"),
]);
export type ResearchFailureCode = Static<typeof ResearchFailureCodeSchema>;

/** Actual search execution success, independent of report quality or result count. */
export const ResearchSearchStatusSchema = Type.Union([
  Type.Literal("unknown"), Type.Literal("none"), Type.Literal("succeeded"),
]);

export const LegacyResearchRunSchema = Type.Object({
  ...RunIdentity,
  schemaVersion: Type.Literal("legacy-freeform-v1"),
  status: Type.Literal("completed"),
  searchStatus: Type.Optional(Type.Literal("unknown")),
  timeScope: Type.String({ minLength: 1, maxLength: 300 }),
  customRequirements: Type.Optional(Type.String({ maxLength: 4000 })),
  reportText: LegacyReportTextSchema,
  completedAt: TimestampSchema,
}, { additionalProperties: false });
export type LegacyResearchRun = Static<typeof LegacyResearchRunSchema>;

// Artifact requirements for each transition are owned by Application/Repository;
// this persisted JSON boundary validates shape and bounds without repairing data.
export const KeyResearchRunSchema = Type.Object({
  ...RunIdentity,
  schemaVersion: Type.Literal("company-research-report-v1"),
  status: KeyResearchStatusSchema,
  searchStatus: Type.Optional(ResearchSearchStatusSchema),
  ...StartCompanyResearchInputSchema.properties,
  researchContext: CompanyResearchContextSchema,
  template: CompanyResearchTemplateSnapshotSchema,
  harnessVersion: Type.Literal(1),
  rawReportText: Type.Optional(ReportTextSchema),
  structuredContent: Type.Optional(StructuredResearchContentSchema),
  structuringAttempts: Type.Integer({ minimum: 0 }),
  lastFailureCode: Type.Optional(ResearchFailureCodeSchema),
  rawCompletedAt: Type.Optional(TimestampSchema),
  completedAt: Type.Optional(TimestampSchema),
}, { additionalProperties: false });
export type KeyResearchRun = Static<typeof KeyResearchRunSchema>;

export const ResearchRunSchema = Type.Union([LegacyResearchRunSchema, KeyResearchRunSchema]);
export type ResearchRun = Static<typeof ResearchRunSchema>;

export const LegacyResearchRunSummarySchema = Type.Omit(LegacyResearchRunSchema, ["reportText"], { additionalProperties: false });
export const KeyResearchRunSummarySchema = Type.Omit(KeyResearchRunSchema, [
  "rawReportText", "structuredContent", "researchContext", "template", "harnessVersion",
], { additionalProperties: false });
export const ActiveResearchRunSummarySchema = Type.Object({
  ...KeyResearchRunSummarySchema.properties,
  status: Type.Union([Type.Literal("researching"), Type.Literal("structuring")]),
}, { additionalProperties: false });
export type ActiveResearchRunSummary = Static<typeof ActiveResearchRunSummarySchema>;
/** History includes failed and completed reports, never active runs. */
export const ResearchRunSummarySchema = Type.Union([
  LegacyResearchRunSummarySchema,
  Type.Object({
    ...KeyResearchRunSummarySchema.properties,
    status: Type.Union([Type.Literal("research_failed"), Type.Literal("structure_failed"), Type.Literal("completed")]),
  }, { additionalProperties: false }),
]);
export type ResearchRunSummary = Static<typeof ResearchRunSummarySchema>;

export const CompanyResearchStageSchema = Type.Union([Type.Literal("raw"), Type.Literal("structure")]);
export type CompanyResearchStage = Static<typeof CompanyResearchStageSchema>;
export const CompanyResearchGlobalActiveRunSchema = Type.Object({
  runId: Type.Unsafe<ResearchRunId>(IdSchema),
  itemId: Type.Unsafe<CapabilityItemId>(IdSchema),
  companyId: Type.Unsafe<CompanyId>(IdSchema),
  stage: CompanyResearchStageSchema,
}, { additionalProperties: false });
export type CompanyResearchGlobalActiveRun = Static<typeof CompanyResearchGlobalActiveRunSchema>;

export const CompanyResearchStateSchema = Type.Object({
  active: Type.Optional(Type.Object({
    run: ActiveResearchRunSummarySchema,
    draftText: Type.String({ maxLength: 1_000_000 }),
    latestActivity: Type.Optional(Type.Object({
      callKey: Type.String({ minLength: 1, maxLength: 64 }),
      name: Type.String({ minLength: 1, maxLength: 48 }),
      summary: Type.Optional(Type.String({ maxLength: 96 })),
      status: Type.Union([
        Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"),
        Type.Literal("skipped"), Type.Literal("reused"),
      ]),
      errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false })),
  runs: Type.Array(ResearchRunSummarySchema),
  // Required even when the selected target is idle; null explicitly means free.
  globalActiveRun: Type.Union([CompanyResearchGlobalActiveRunSchema, Type.Null()]),
}, { additionalProperties: false });
export type CompanyResearchState = Static<typeof CompanyResearchStateSchema>;

const WorkerRequestFields = {
  requestId: IdSchema,
  runId: IdSchema,
  llm: LlmRuntimeSnapshotSchema,
  toolAccess: ToolAccessPolicySchema,
  context: CompanyResearchContextSchema,
  template: CompanyResearchTemplateSnapshotSchema,
};
export const CompanyResearchRawWorkerRequestSchema = Type.Object({
  ...WorkerRequestFields,
  kind: Type.Literal("company-research.raw.run"),
  stage: Type.Literal("raw"),
  search: SearchRuntimeSnapshotSchema,
}, { additionalProperties: false });
export type CompanyResearchRawWorkerRequest = Static<typeof CompanyResearchRawWorkerRequestSchema>;
export const CompanyResearchStructureWorkerRequestSchema = Type.Object({
  ...WorkerRequestFields,
  kind: Type.Literal("company-research.structure.run"),
  stage: Type.Literal("structure"),
  rawReportText: ReportTextSchema,
  // JSON Schema const validates the schema as data, not as the candidate output.
  outputSchema: Type.Unsafe<JsonObject>({ type: "object", const: STRUCTURED_RESEARCH_OUTPUT_SCHEMA }),
}, { additionalProperties: false });
export type CompanyResearchStructureWorkerRequest = Static<typeof CompanyResearchStructureWorkerRequestSchema>;
export const CompanyResearchWorkerRequestSchema = Type.Union([
  CompanyResearchRawWorkerRequestSchema, CompanyResearchStructureWorkerRequestSchema,
]);
export type CompanyResearchWorkerRequest = Static<typeof CompanyResearchWorkerRequestSchema>;

export const CompanyResearchCancelRequestSchema = Type.Object({
  requestId: IdSchema,
  kind: Type.Literal("company-research.cancel"),
  runId: IdSchema,
  stage: CompanyResearchStageSchema,
}, { additionalProperties: false });
export type CompanyResearchCancelRequest = Static<typeof CompanyResearchCancelRequestSchema>;

const EventIdentity = { requestId: IdSchema, runId: IdSchema, stage: CompanyResearchStageSchema };
const RawTextDeltaSchema = Type.Object({
  ...EventIdentity,
  stage: Type.Literal("raw"),
  type: Type.Literal("text_delta"),
  delta: Type.String({ maxLength: 1_000_000 }),
}, { additionalProperties: false });
const ResearchToolActivitySchema = Type.Object({
  ...EventIdentity,
  stage: Type.Literal("raw"),
  type: Type.Literal("tool_activity"),
  callKey: Type.String({ minLength: 1, maxLength: 64 }),
  name: Type.String({ minLength: 1, maxLength: 48 }),
  summary: Type.Optional(Type.String({ maxLength: 96 })),
  status: Type.Union([
    Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"),
    Type.Literal("skipped"), Type.Literal("reused"),
  ]),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  agentTurnIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  batchId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  budgetConsumed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const RawFailureCodeSchema = Type.Exclude(ResearchFailureCodeSchema, Type.Literal("structuring_failed"));
export const CompanyResearchModelErrorCategorySchema = Type.Union([
  Type.Literal("provider_failed"), Type.Literal("stream_failed"), Type.Literal("incomplete_lifecycle"),
  Type.Literal("invalid_final_empty"), Type.Literal("invalid_final_protocol"), Type.Literal("invalid_final_language"),
  Type.Literal("invalid_final_tool_use"), Type.Literal("json_parse"), Type.Literal("schema_invalid"),
  Type.Literal("shape_invalid"), Type.Literal("status_invalid"), Type.Literal("source_mismatch"),
  Type.Literal("truncated"), Type.Literal("storage_failed"),
]);
export type CompanyResearchModelErrorCategory = Static<typeof CompanyResearchModelErrorCategorySchema>;
export const CompanyResearchValidationIssueSchema = Type.Object({
  path: Type.String({ maxLength: 160, pattern: "^(?:/(?:[A-Za-z][A-Za-z0-9_-]*|\\*|[0-9]{1,3})){0,8}$" }),
  expected: Type.String({ minLength: 1, maxLength: 48, pattern: "^[a-z_]+$" }),
  actual: Type.Union([Type.Literal("object"), Type.Literal("array"), Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("null"), Type.Literal("undefined")]),
}, { additionalProperties: false });
export type CompanyResearchValidationIssue = Static<typeof CompanyResearchValidationIssueSchema>;
export const CompanyResearchModelDiagnosticSchema = Type.Object({
  ...EventIdentity,
  type: Type.Literal("model_diagnostic"),
  traceId: IdSchema,
  phase: Type.Union([Type.Literal("deciding"), Type.Literal("synthesizing"), Type.Literal("structuring")]),
  agentTurns: Type.Integer({ minimum: 0, maximum: 1000 }),
  searchCalls: Type.Integer({ minimum: 0, maximum: 1000 }),
  fetchCalls: Type.Integer({ minimum: 0, maximum: 1000 }),
  maxModelInputCharsEstimate: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
  outputChars: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
  stopReason: Type.Union([
    Type.Literal("stop"), Type.Literal("length"), Type.Literal("tool_use"),
    Type.Literal("error"), Type.Literal("aborted"), Type.Literal("unknown"),
  ]),
  errorCategory: Type.Optional(CompanyResearchModelErrorCategorySchema),
  attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
  validationIssues: Type.Optional(Type.Array(CompanyResearchValidationIssueSchema, { maxItems: 20 })),
  failedCandidate: Type.Optional(Type.String({ maxLength: 16_384 })),
  startedAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", maxLength: 24 }),
  finishedAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", maxLength: 24 }),
  durationMs: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
}, { additionalProperties: false });
export type CompanyResearchModelDiagnostic = Static<typeof CompanyResearchModelDiagnosticSchema>;
export const CompanyResearchWorkerEventSchema = Type.Union([
  Type.Object({ ...EventIdentity, type: Type.Literal("started") }, { additionalProperties: false }),
  RawTextDeltaSchema,
  ResearchToolActivitySchema,
  CompanyResearchModelDiagnosticSchema,
  Type.Object({ ...EventIdentity, type: Type.Literal("completed"), text: ReportTextSchema }, { additionalProperties: false }),
  Type.Object({
    ...EventIdentity, stage: Type.Literal("raw"), type: Type.Literal("failed"),
    code: RawFailureCodeSchema, message: Type.Literal("company research failed"),
  }, { additionalProperties: false }),
  Type.Object({
    ...EventIdentity, stage: Type.Literal("raw"), type: Type.Literal("failed"),
    code: Type.Literal("research_failed"), message: Type.Literal("company research failed"),
  }, { additionalProperties: false }),
  Type.Object({
    ...EventIdentity, stage: Type.Literal("raw"), type: Type.Literal("failed"),
    code: Type.Literal("web_search_failed"), message: Type.Literal("company research web search failed"),
  }, { additionalProperties: false }),
  Type.Object({
    ...EventIdentity, stage: Type.Literal("structure"), type: Type.Literal("failed"),
    code: Type.Literal("structuring_failed"), message: Type.Literal("company research structuring failed"),
  }, { additionalProperties: false }),
  Type.Object({ ...EventIdentity, type: Type.Literal("cancelled") }, { additionalProperties: false }),
]);
export type CompanyResearchWorkerEvent = Static<typeof CompanyResearchWorkerEventSchema>;

/** Application emits after durable transitions/cleanup; all targets refresh occupancy.
 * Worker completion is deliberately excluded: raw completion is not run completion,
 * and a structure candidate is not a validated, persisted report.
 */
export const CompanyResearchStateChangedEventSchema = Type.Object({
  type: Type.Literal("state_changed"),
  itemId: IdSchema,
  companyId: IdSchema,
  runId: IdSchema,
  // Public fixed category only; provider diagnostics never cross this boundary.
  outcome: Type.Optional(Type.Union([
    Type.Literal("research_failed"), Type.Literal("web_search_failed"), Type.Literal("tool_failed"),
    Type.Literal("model_failed"), Type.Literal("empty_report"), Type.Literal("protocol_leak"),
    Type.Literal("language_validation_failed"), Type.Literal("incomplete_response"),
    Type.Literal("protocol_error"), Type.Literal("storage_failed"), Type.Literal("cancelled"),
  ])),
}, { additionalProperties: false });
export const CompanyResearchEventSchema = Type.Union([
  CompanyResearchStateChangedEventSchema, RawTextDeltaSchema, ResearchToolActivitySchema,
]);
export type CompanyResearchEvent = Static<typeof CompanyResearchEventSchema>;
