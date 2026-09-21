import type { Repositories, CompanyRepository } from "@deepfield/persistence";
import type { LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";
import type { CompanyDraft, Company, CompanyProfileResult, CompanyProfileWorkerRequest, CompanyProfileWorkerEvent, CompanyResearchWorkerRequest, CompanyResearchWorkerEvent, CompanyResearchStage } from "./contracts/index.js";

export interface IndustryResearchServiceRepositories {
  capabilityItems: Pick<Repositories["capabilityItems"], "getById" | "create" | "update" | "delete" | "list">;
  companies: Pick<Repositories["companies"], "getByNormalizedName" | "list" | "deleteIfUnreferenced" | "getById" | "update" | "upsert">;
  runInTransaction: Repositories["runInTransaction"];
  companyResearchBatches: Pick<Repositories["companyResearchBatches"], "getActive">;
  itemCompanies: Pick<Repositories["itemCompanies"], "listByItem" | "add" | "remove">;
  companyResearchRuns: Pick<Repositories["companyResearchRuns"], "summarizeByItem">;
}

export interface CompanyResearchServiceRepositories {
  runInTransaction: Repositories["runInTransaction"];
  companyResearchRuns: Pick<Repositories["companyResearchRuns"], "createResearching" | "getByIdForTarget" | "retryStructuring" | "retryResearching" | "getActive" | "listRuns" | "deleteTerminal" | "recoverAbandoned" | "markSearchSucceeded" | "completeRaw" | "completeStructured" | "deleteActive" | "failResearching" | "failStructuring">;
  companyResearchDiagnostics: Pick<Repositories["companyResearchDiagnostics"], "deleteByRunId" | "record">;
  toolExecutions: Pick<Repositories["toolExecutions"], "deleteByTraceIds">;
  capabilityItems: Pick<Repositories["capabilityItems"], "getById">;
  companies: Pick<Repositories["companies"], "getById">;
  itemCompanies: Pick<Repositories["itemCompanies"], "listByItem">;
}

export interface CompanyResearchBatchServiceRepositories {
  companyResearchBatches: Pick<Repositories["companyResearchBatches"], "deleteAllTerminal" | "getActive" | "getLatest" | "save" | "deleteTerminal">;
  companyResearchRuns: Pick<Repositories["companyResearchRuns"], "getByIdForTarget" | "deleteActive" | "deleteTerminal">;
  capabilityItems: Pick<Repositories["capabilityItems"], "getById">;
  runInTransaction: Repositories["runInTransaction"];
}

export interface CompanyRecognizer { recognize(text: string): Promise<CompanyDraft[]>; }
export interface RuntimeProfileResolver { resolveActiveLlm(): Promise<LlmRuntimeSnapshot>; resolveActiveSearch(): Promise<SearchRuntimeSnapshot>; }
export interface CompanyResearchWorkerPort { sendResearch(request: CompanyResearchWorkerRequest): AsyncIterable<CompanyResearchWorkerEvent>; cancelResearch(requestId: string, runId: string, stage: CompanyResearchStage): void; }
export interface CompanyProfileWorkerPort { sendProfile(request: CompanyProfileWorkerRequest): AsyncIterable<CompanyProfileWorkerEvent>; }
export interface CompanyProfileCompleter { prepare(company: Company, researchTopics: string[]): Promise<() => Promise<CompanyProfileResult>>; }
export type RequestIdFactory = () => string;
export interface CompanyRecognitionModelGateway { completeText(snapshot: LlmRuntimeSnapshot, system: string, prompt: string, signal?: AbortSignal): Promise<string>; }
export type UsageContextRunner = <T>(context: { sourceId: string }, work: () => T) => T;
export type ProfileRepository = Pick<CompanyRepository, "getById" | "resetEnrichingProfiles" | "list" | "setProfileStatus" | "confirmProfileIdentity" | "getNextPendingProfile" | "completeProfile">;

export type ProfileDiagnosticSink = (diagnostic: import("./contracts/index.js").CompanyProfileDiagnostic) => void;

/** Host owns the trusted save dialog and atomic filesystem replacement. */
export interface DocumentSavePort {
  writeFile(path: string, data: Buffer, options: { flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  randomToken(): string;
}
