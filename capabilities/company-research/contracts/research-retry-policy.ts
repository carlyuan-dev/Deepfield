import type { ResearchRun, ResearchRunSummary, StartCompanyResearchInput } from "./research.js";

export type ResearchRetryMode = "unavailable" | "raw" | "structure";
export function normalizeResearchInput(input: StartCompanyResearchInput): StartCompanyResearchInput {
  const focusScope = input.focusScope?.trim();
  return { direction: input.direction, asOfDate: input.asOfDate, ...(focusScope ? { focusScope } : {}) };
}

/** Domain policy only; callers retain validation, readiness and atomic ownership guards. */
export function researchRetryMode(saved: ResearchRun | ResearchRunSummary | undefined, latest?: StartCompanyResearchInput): ResearchRetryMode {
  if (saved?.schemaVersion !== "company-research-report-v1") return "unavailable";
  if (saved.status !== "research_failed" && saved.status !== "structure_failed" && !(saved.status === "completed" && saved.searchStatus === "none")) return "unavailable";
  const input = normalizeResearchInput(latest ?? saved);
  const previous = normalizeResearchInput(saved);
  if (saved.status === "structure_failed" && saved.searchStatus !== "none" && previous.direction === input.direction && previous.asOfDate === input.asOfDate && previous.focusScope === input.focusScope) return "structure";
  return "raw";
}
