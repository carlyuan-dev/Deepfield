import { Type, type Static } from "typebox";
import type { CapabilityItemId, CompanyId, ResearchRunId } from "./ids.js";

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
