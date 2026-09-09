import { randomUUID } from "node:crypto";
import type { Repositories } from "@deepfield/persistence";
import {
  ChatService,
  CompanyResearchService,
  ContextBuilder,
  ConversationService,
  IndustryResearchService,
  type AgentWorkerPort,
  type CompanyResearchWorkerPort,
  type CompanyRecognizer,
  type ConversationTitleGenerator,
  type SecretReader,
} from "@deepfield/application";

export interface ApplicationRuntimeDeps {
  repositories: Repositories;
  secrets: SecretReader;
  worker: AgentWorkerPort & CompanyResearchWorkerPort;
  companyRecognizer: CompanyRecognizer;
  titleGenerator?: ConversationTitleGenerator;
}

export interface ApplicationRuntime {
  industryResearch: IndustryResearchService;
  conversationService: ConversationService;
  contextBuilder: ContextBuilder;
  chatService: ChatService;
  companyResearch: CompanyResearchService;
}

export function createApplicationRuntime(deps: ApplicationRuntimeDeps): ApplicationRuntime {
  const industryResearch = new IndustryResearchService(
    deps.repositories,
    deps.companyRecognizer,
  );
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
  return { industryResearch, conversationService, contextBuilder, chatService, companyResearch };
}
