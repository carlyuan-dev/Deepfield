import { randomUUID } from "node:crypto";
import type { Repositories } from "@deepfield/persistence";
import {
  ChatService,
  CompanyResearchService,
  CompanyResearchBatchService,
  CompanyProfileEnrichmentService,
  ContextBuilder,
  ConversationService,
  IndustryResearchService,
  type AgentWorkerPort,
  type CompanyResearchWorkerPort,
  type CompanyRecognizer,
  type CompanyProfileCompleter, type CompanyProfileWorkerPort,
  type ConversationTitleGenerator,
  type SecretReader,
} from "@deepfield/application";
import { createCompanyProfileCompleter } from "./company-profile-completer.js";

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
  const companyResearch = new CompanyResearchService(
    deps.repositories,
    deps.profiles,
    deps.worker,
    { requestIdFactory: randomUUID },
  );
  let companyResearchBatch: CompanyResearchBatchService | undefined;
  const companyProfiles = new CompanyProfileEnrichmentService(
    deps.repositories.companies,
    companyCompleter,
    {
      isForegroundBusy: () => companyResearch.isRunning() || !!companyResearchBatch?.isReserved(),
      getTopicCompanyIds: (itemId) => deps.repositories.itemCompanies.listByItem(itemId as import("@deepfield/contracts").CapabilityItemId).map(entry => entry.companyId),
      getTopicIds: () => deps.repositories.capabilityItems.list().map(item => item.id),
      getResearchTopics: (companyId) => deps.repositories.capabilityItems.list()
        .filter((item) => deps.repositories.itemCompanies.listByItem(item.id)
          .some((membership) => membership.companyId === companyId))
        .map((item) => item.industry),
    },
  );
  const industryResearch = new IndustryResearchService(
    deps.repositories,
    companyRecognizer,
    companyProfiles,
  );
  companyResearchBatch = new CompanyResearchBatchService(deps.repositories, companyResearch, companyProfiles);
  companyResearch.cleanupAbandoned();
  companyResearch.subscribe((event) => {
    if (event.type === "state_changed" && !companyResearch.isRunning()) {
      companyProfiles.resume();
    }
  });
  companyProfiles.start();
  return { industryResearch, conversationService, contextBuilder, chatService, companyResearch, companyResearchBatch, companyProfiles };
}
