import { Type, type Static } from "typebox";
import type { CapabilityItemId, CompanyId, ResearchRunId } from "./ids.js";
import { DEFAULT_DEEPSEEK_MODEL_ID } from "./chat.js";

export const StartCompanyResearchInputSchema = Type.Object(
  {
    timeScope: Type.String({ minLength: 1, maxLength: 300 }),
    customRequirements: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type StartCompanyResearchInput = Static<typeof StartCompanyResearchInputSchema>;

export interface ResearchRun {
  id: ResearchRunId;
  itemId: CapabilityItemId;
  companyId: CompanyId;
  status: "running" | "completed";
  timeScope: string;
  customRequirements?: string;
  reportText?: string;
  createdAt: string;
  completedAt?: string;
}

export interface CompanyResearchState {
  active?: { run: ResearchRun; draftText: string };
  completed: ResearchRun[];
}

export const CompanyResearchContextSchema = Type.Object(
  {
    currentDate: Type.String({ minLength: 1, maxLength: 64 }),
    companyName: Type.String({ minLength: 1, maxLength: 300 }),
    countryOrRegion: Type.Optional(Type.String({ maxLength: 200 })),
    industry: Type.String({ minLength: 1, maxLength: 300 }),
    researchScope: Type.Optional(Type.String({ maxLength: 4000 })),
    companyNote: Type.Optional(Type.String({ maxLength: 4000 })),
    timeScope: Type.String({ minLength: 1, maxLength: 300 }),
    customRequirements: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type CompanyResearchContext = Static<typeof CompanyResearchContextSchema>;

export const CompanyResearchWorkerRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    kind: Type.Literal("company-research.run"),
    runId: Type.String({ minLength: 1 }),
    apiKey: Type.String(),
    modelId: Type.Literal(DEFAULT_DEEPSEEK_MODEL_ID),
    context: CompanyResearchContextSchema,
  },
  { additionalProperties: false },
);
export type CompanyResearchWorkerRequest = Static<typeof CompanyResearchWorkerRequestSchema>;

export const CompanyResearchCancelRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    kind: Type.Literal("company-research.cancel"),
    runId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CompanyResearchCancelRequest = Static<typeof CompanyResearchCancelRequestSchema>;

const CompanyResearchEventIdentitySchema = {
  requestId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
};

export const CompanyResearchWorkerEventSchema = Type.Union([
  Type.Object(
    { ...CompanyResearchEventIdentitySchema, type: Type.Literal("started") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CompanyResearchEventIdentitySchema,
      type: Type.Literal("text_delta"),
      delta: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CompanyResearchEventIdentitySchema,
      type: Type.Literal("completed"),
      text: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CompanyResearchEventIdentitySchema,
      type: Type.Literal("failed"),
      code: Type.Literal("research_failed"),
      message: Type.Literal("company research failed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CompanyResearchEventIdentitySchema, type: Type.Literal("cancelled") },
    { additionalProperties: false },
  ),
]);
export type CompanyResearchWorkerEvent = Static<typeof CompanyResearchWorkerEventSchema>;
