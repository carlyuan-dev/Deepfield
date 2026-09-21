import type { Repositories } from "@deepfield/persistence";
import { ChatService, ContextBuilder, ConversationService, type AgentWorkerPort, type ConversationTitleGenerator, type RuntimeProfileResolver } from "@deepfield/application";

export interface ApplicationRuntimeDeps {
  repositories: Repositories;
  profiles: RuntimeProfileResolver;
  worker: AgentWorkerPort;
  titleGenerator?: ConversationTitleGenerator;
}
export function createApplicationRuntime(deps: ApplicationRuntimeDeps) {
  const conversationService = new ConversationService(deps.repositories);
  const contextBuilder = new ContextBuilder(deps.repositories);
  const chatService = new ChatService(deps.repositories, contextBuilder, deps.profiles, deps.worker, deps.titleGenerator ? { titleGenerator: deps.titleGenerator } : {});
  return { conversationService, contextBuilder, chatService };
}
export type ApplicationRuntime = ReturnType<typeof createApplicationRuntime>;
