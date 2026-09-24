export { ConversationService } from "./chat/conversation-service.js";
export { ChatInteractionCoordinator } from "./chat/interaction/coordinator.js";
export { classifyExplicitDecision } from "./chat/interaction/response-routing.js";
export { classifyTaskDecision, snapshotExactTaskCalls, exactTaskCallDigest, TaskGrantStore } from "./chat/interaction/task-authorization.js";
export type { ExactTaskCall, TaskGrantClaim } from "./chat/interaction/task-authorization.js";
export type { InteractionRepository, OperationAdapter, OperationSnapshot, OperationResult, TrustedInteractionContext } from "./chat/interaction/ports.js";
export { capabilityContext, capabilityDescriptionKey, restoredCapabilityDescriptions } from "./chat/capability-context.js";
export { renderChatHelp } from "./chat/chat-help.js";
export type { CapabilityUserHelp } from "./chat/chat-help.js";
export type { CapabilityDirectoryEntry } from "./chat/capability-context.js";
export { requestedCompletionAnalysis, taskEventId, shouldScheduleAnalysis } from "./chat/capability-task-links.js";
export { ContextBuilder, ContextBuilderError, MAIN_AGENT_SYSTEM_PROMPT } from "./chat/context-builder.js";
export {
  ChatService,
  ChatServiceError,
  DEEPSEEK_KEY_NAME,
  titleFromFirstMessage,
} from "./chat/chat-service.js";
export { SqliteToolAudit, SqliteToolAuditError } from "./tools/tool-audit.js";
export type { ChatSendResult, ChatServiceOptions } from "./chat/chat-service.js";
export type {
  AgentWorkerPort,
  ConversationTitleGenerator,
  ProviderKeyReader,
  RequestIdFactory,
  SecretReader,
  RuntimeProfileResolver,
} from "./ports.js";
export { freezeTaskScope, TaskScopeStore, type FrozenTaskScope, type ScopeClaim } from "./chat/interaction/task-scope.js";
