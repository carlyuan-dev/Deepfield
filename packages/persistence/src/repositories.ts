import type { DatabaseSync } from "node:sqlite";
import { createActivityRepository } from "./activity-repository.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createMessageRepository } from "./message-repository.js";
import { createProjectRepository } from "./project-repository.js";
import { runInTransaction } from "./transactions.js";
import type { Repositories } from "./types.js";

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    projects: createProjectRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    activities: createActivityRepository(db),
    runInTransaction: (work) => runInTransaction(db, work),
  };
}
