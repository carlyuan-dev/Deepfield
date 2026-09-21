import type { CompanyResearchStage } from "../contracts/research.js";
export function researchFailure(stage: CompanyResearchStage) {
  return stage === "raw"
    ? { stage: "raw", code: "research_failed", message: "company research failed" } as const
    : { stage: "structure", code: "structuring_failed", message: "company research structuring failed" } as const;
}
