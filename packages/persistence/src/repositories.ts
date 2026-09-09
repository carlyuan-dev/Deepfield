import type { DatabaseSync } from "node:sqlite";
import { createCapabilityItemRepository } from "./capability-item-repository.js";
import { createCompanyRepository } from "./company-repository.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createMessageRepository } from "./message-repository.js";
import { createItemCompanyRepository } from "./item-company-repository.js";
import { createToolExecutionRepository } from "./tool-execution-repository.js";
import { runInTransaction } from "./transactions.js";
import type { Repositories } from "./types.js";

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    capabilityItems: createCapabilityItemRepository(db),
    companies: createCompanyRepository(db),
    itemCompanies: createItemCompanyRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    toolExecutions: createToolExecutionRepository(db),
    runInTransaction: (work) => runInTransaction(db, work),
  };
}
