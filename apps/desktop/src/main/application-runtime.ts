import type { Repositories } from "@deepfield/persistence";
import { ChatService, ContextBuilder, ConversationService, type AgentWorkerPort, type ConversationTitleGenerator, type RuntimeProfileResolver } from "@deepfield/application";

export interface ApplicationRuntimeDeps {
  interactions?: import("@deepfield/application").ChatInteractionCoordinator;
  respondToInteraction?: import("@deepfield/application").ChatServiceOptions["respondToInteraction"];
  respondToTask?: import("@deepfield/application").ChatServiceOptions["respondToTask"];
  onUserMessage?: (conversationId: string) => void;
  onTaskStopped?: (conversationId: string) => void;
  taskScope?: (conversationId: string) => unknown;
  onDispose?: () => void;
  repositories: Repositories;
  profiles: RuntimeProfileResolver;
  worker: AgentWorkerPort;
  titleGenerator?: ConversationTitleGenerator;
  capabilityDirectory?: () => import("@deepfield/application").CapabilityDirectoryEntry[];
  capabilityHelp?: () => import("@deepfield/application").CapabilityUserHelp[];
  helpTools?: (webSearch: boolean) => Array<{ name: string; description: string }>;
  onRequestStarted?: (requestId: string, conversationId: string, prompt: string, restoredKeys: readonly string[]) => void;
  onRequestFinished?: (requestId: string) => void;
  onAnalysisChanged?: (conversationId: string) => void;
  onAutoEvent?: (conversationId: string, event: import("@deepfield/contracts").AgentWorkerEvent) => void;
  isConversationActive?: (conversationId: string) => boolean;
}
export function createApplicationRuntime(deps: ApplicationRuntimeDeps) {
  const conversationService = new ConversationService(deps.repositories);
  const contextBuilder = new ContextBuilder(deps.repositories);
  const chatService = new ChatService(deps.repositories, contextBuilder, deps.profiles, deps.worker, {
    ...(deps.interactions ? { interactions: deps.interactions } : {}),
    ...(deps.respondToInteraction ? { respondToInteraction: deps.respondToInteraction } : {}),
    ...(deps.respondToTask ? { respondToTask: deps.respondToTask } : {}),
    ...(deps.onUserMessage ? { onUserMessage: deps.onUserMessage } : {}),
    ...(deps.onTaskStopped ? { onTaskStopped: deps.onTaskStopped } : {}),
    ...(deps.taskScope ? { taskScope: deps.taskScope } : {}),
    ...(deps.onDispose ? { onDispose: deps.onDispose } : {}),
    ...(deps.titleGenerator ? { titleGenerator: deps.titleGenerator } : {}),
    ...(deps.capabilityDirectory ? { capabilityDirectory: deps.capabilityDirectory } : {}),
    ...(deps.capabilityHelp ? { capabilityHelp: deps.capabilityHelp } : {}),
    ...(deps.helpTools ? { helpTools: deps.helpTools } : {}),
    ...(deps.onRequestStarted ? { onRequestStarted: deps.onRequestStarted } : {}),
    ...(deps.onRequestFinished ? { onRequestFinished: deps.onRequestFinished } : {}),
    ...(deps.onAnalysisChanged ? { onAnalysisChanged: deps.onAnalysisChanged } : {}),
    ...(deps.onAutoEvent ? { onAutoEvent: deps.onAutoEvent } : {}),
    ...(deps.isConversationActive ? { isConversationActive: deps.isConversationActive } : {}),
  });
  return { conversationService, contextBuilder, chatService };
}
export type ApplicationRuntime = ReturnType<typeof createApplicationRuntime>;
