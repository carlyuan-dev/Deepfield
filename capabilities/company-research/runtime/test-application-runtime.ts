import type { CompanyResearchWorkerPort, CompanyRecognizer, CompanyProfileCompleter, CompanyProfileWorkerPort } from "../host-ports.js";
import { createCompanyResearchServices } from "../application/create-services.js";
import { randomUUID } from "node:crypto";
import type { Repositories } from "@deepfield/persistence";
import { ChatService, ContextBuilder, ConversationService, type AgentWorkerPort, type ConversationTitleGenerator, type SecretReader } from "@deepfield/application";
import { CompanyResearchService, CompanyResearchBatchService, CompanyProfileEnrichmentService, IndustryResearchService } from "../application/index.js";
import { createCompanyProfileCompleter } from "../application/company-profile-completer.js";

export interface ApplicationRuntimeDeps {
  repositories: Repositories;
  secrets: SecretReader;
  profiles: import("@deepfield/application").RuntimeProfileResolver;
  worker: AgentWorkerPort & CompanyResearchWorkerPort & Partial<CompanyProfileWorkerPort>;
  llmHelpers?: CompanyRecognizer & ConversationTitleGenerator;
  companyRecognizer?: CompanyRecognizer;
  companyCompleter?: CompanyProfileCompleter;
  titleGenerator?: ConversationTitleGenerator;
}

export interface ApplicationRuntime {
  dispose(): Promise<void>;
  industryResearch: IndustryResearchService;
  conversationService: ConversationService;
  contextBuilder: ContextBuilder;
  chatService: ChatService;
  companyResearch: CompanyResearchService;
  companyResearchBatch: CompanyResearchBatchService;
  companyProfiles: CompanyProfileEnrichmentService;
}

export function createApplicationRuntime(deps: ApplicationRuntimeDeps): ApplicationRuntime {
  const companyRecognizer = deps.companyRecognizer ?? deps.llmHelpers;
  const companyCompleter = deps.companyCompleter ?? createCompanyProfileCompleter(deps.profiles, {
    sendProfile: (request) => {
      if (!deps.worker.sendProfile) throw new Error("profile worker unavailable");
      return deps.worker.sendProfile(request);
    },
  }, (diagnostic) => deps.repositories.companyProfileDiagnostics.record(diagnostic));
  const titleGenerator = deps.titleGenerator ?? deps.llmHelpers;
  if (companyRecognizer === undefined || companyCompleter === undefined) {
    throw new Error("llm helpers are not configured");
  }
  const conversationService = new ConversationService(deps.repositories);
  const contextBuilder = new ContextBuilder(deps.repositories);
  const chatService = new ChatService(
    deps.repositories,
    contextBuilder,
    deps.profiles,
    deps.worker,
    titleGenerator === undefined ? {} : { titleGenerator },
  );
  const services = createCompanyResearchServices({
    repositories: {
      capabilityItems: deps.repositories.capabilityItems,
      companies: deps.repositories.companies,
      itemCompanies: deps.repositories.itemCompanies,
      companyResearchRuns: deps.repositories.companyResearchRuns,
      companyResearchDiagnostics: deps.repositories.companyResearchDiagnostics,
      companyResearchBatches: deps.repositories.companyResearchBatches,
      toolExecutions: { deleteByTraceIds: ids => deps.repositories.toolExecutions.deleteByTraceIds(ids) },
      runInTransaction: work => deps.repositories.runInTransaction(work),
    },
    profiles: deps.profiles,
    worker: { sendResearch: request => deps.worker.sendResearch(request), cancelResearch: (...args) => deps.worker.cancelResearch(...args) },
    companyRecognizer, companyCompleter, requestIdFactory: randomUUID,
  });
  return { ...services, conversationService, contextBuilder, chatService };
}
