import type { Repositories } from "@deepfield/persistence";
import {
  ChatService,
  ContextBuilder,
  ConversationService,
  ProjectService,
  type AgentWorkerPort,
  type ConversationTitleGenerator,
  type SecretReader,
} from "@deepfield/application";

export interface ApplicationRuntimeDeps {
  repositories: Repositories;
  secrets: SecretReader;
  worker: AgentWorkerPort;
  titleGenerator?: ConversationTitleGenerator;
}

export interface ApplicationRuntime {
  projectService: ProjectService;
  conversationService: ConversationService;
  contextBuilder: ContextBuilder;
  chatService: ChatService;
}

export function createApplicationRuntime(deps: ApplicationRuntimeDeps): ApplicationRuntime {
  const projectService = new ProjectService(deps.repositories);
  const conversationService = new ConversationService(deps.repositories);
  const contextBuilder = new ContextBuilder(deps.repositories);
  const chatService = new ChatService(
    deps.repositories,
    contextBuilder,
    deps.secrets,
    deps.worker,
    deps.titleGenerator === undefined ? {} : { titleGenerator: deps.titleGenerator },
  );
  return { projectService, conversationService, contextBuilder, chatService };
}
