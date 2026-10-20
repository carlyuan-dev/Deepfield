import { databaseView, type DatabaseInput } from "./database.js";
import { createCapabilityInvocationRepository } from "./capability-invocation-repository.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createMessageRepository } from "./message-repository.js";
import { createToolExecutionRepository } from "./tool-execution-repository.js";
import { runInTransaction } from "./transactions.js";
import type { Repositories } from "./types.js";
import { createChatSessionRepository } from "./chat-session-repository.js";
import { createChatCapabilityRepository } from "./chat-capability-repository.js";
import { createChatInteractionRepository } from "./chat-interaction-repository.js";

export function createRepositories(connection: DatabaseInput): Repositories {
  const db = databaseView(connection);
  return {
    chatCapabilities: createChatCapabilityRepository(db),
    chatInteractions: createChatInteractionRepository(db),
    capabilityInvocations: createCapabilityInvocationRepository(db),
    chatSessions: createChatSessionRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    toolExecutions: createToolExecutionRepository(db),
    runInTransaction: (work) => runInTransaction(db, work),
  };
}
