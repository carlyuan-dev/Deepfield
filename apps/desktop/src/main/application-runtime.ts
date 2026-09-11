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
  profiles: import("@deepfield/application").RuntimeProfileResolver;
  worker: AgentWorkerPort & CompanyResearchWorkerPort;
  llmHelpers?: CompanyRecognizer & CompanyCompleter & ConversationTitleGenerator;
  companyRecognizer?: CompanyRecognizer;
  companyCompleter?: CompanyCompleter;
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
  const companyRecognizer = deps.companyRecognizer ?? deps.llmHelpers;
  const companyCompleter = deps.companyCompleter ?? deps.llmHelpers;
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
    deps.secrets,
    deps.worker,
    { requestIdFactory: randomUUID },
  );
  companyResearch.cleanupAbandoned();
  const companyProfiles = new CompanyProfileEnrichmentService(
    deps.repositories.companies,
    companyCompleter,
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
    companyRecognizer,
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
