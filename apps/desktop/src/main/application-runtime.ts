import { randomUUID } from "node:crypto";
import type { Repositories } from "@deepfield/persistence";
import {
  ChatService,
  CompanyResearchService,
  CompanyProfileEnrichmentService,
  ContextBuilder,
  ConversationService,
  IndustryResearchService,
  type AgentWorkerPort,
  type CompanyResearchWorkerPort,
  type CompanyRecognizer,
  type CompanyCompleter,
  type ConversationTitleGenerator,
  type SecretReader,
} from "@deepfield/application";

export interface ApplicationRuntimeDeps {
  repositories: Repositories;
  secrets: SecretReader;
  worker: AgentWorkerPort & CompanyResearchWorkerPort;
  companyRecognizer: CompanyRecognizer;
  companyCompleter: CompanyCompleter;
  titleGenerator?: ConversationTitleGenerator;
}

export interface ApplicationRuntime {
  industryResearch: IndustryResearchService;
  conversationService: ConversationService;
  contextBuilder: ContextBuilder;
  chatService: ChatService;
  companyResearch: CompanyResearchService;
  companyProfiles: CompanyProfileEnrichmentService;
}

export function createApplicationRuntime(deps: ApplicationRuntimeDeps): ApplicationRuntime {
  const conversationService = new ConversationService(deps.repositories);
  const contextBuilder = new ContextBuilder(deps.repositories);
  const chatService = new ChatService(
    deps.repositories,
    contextBuilder,
    deps.secrets,
    deps.worker,
    deps.titleGenerator === undefined ? {} : { titleGenerator: deps.titleGenerator },
  );
  const companyResearch = new CompanyResearchService(
    deps.repositories,
    deps.secrets,
    deps.worker,
    { requestIdFactory: randomUUID },
  );
  companyResearch.cleanupAbandoned();
  const companyProfiles = new CompanyProfileEnrichmentService(
    deps.repositories.companies,
    deps.companyCompleter,
    {
      isForegroundBusy: () => companyResearch.isRunning(),
      getResearchTopics: (companyId) => deps.repositories.capabilityItems.list()
        .filter((item) => deps.repositories.itemCompanies.listByItem(item.id)
          .some((membership) => membership.companyId === companyId))
        .map((item) => item.industry),
    },
  );
  const industryResearch = new IndustryResearchService(
    deps.repositories,
    deps.companyRecognizer,
    companyProfiles,
  );
  companyResearch.subscribe((event) => {
    if (event.type === "state_changed" && !companyResearch.isRunning()) {
      companyProfiles.resume();
    }
  });
  companyProfiles.start();
  return { industryResearch, conversationService, contextBuilder, chatService, companyResearch, companyProfiles };
}
