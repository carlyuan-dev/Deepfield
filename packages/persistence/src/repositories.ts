import type { DatabaseSync } from "node:sqlite";
import { createCompanyResearchBatchRepository } from "./company-research-batch-repository.js";
import { createCapabilityItemRepository } from "./capability-item-repository.js";
import { createCompanyRepository } from "./company-repository.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createMessageRepository } from "./message-repository.js";
import { createItemCompanyRepository } from "./item-company-repository.js";
import { createToolExecutionRepository } from "./tool-execution-repository.js";
import { createCompanyResearchRunRepository } from "./company-research-run-repository.js";
import { createCompanyResearchDiagnosticRepository } from "./company-research-diagnostic-repository.js";
import { createCompanyProfileDiagnosticRepository } from "./company-profile-diagnostic-repository.js";
import { runInTransaction } from "./transactions.js";
import type { Repositories } from "./types.js";
import { createChatSessionRepository } from "./chat-session-repository.js";

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    chatSessions: createChatSessionRepository(db),
    companyResearchBatches: createCompanyResearchBatchRepository(db),
    capabilityItems: createCapabilityItemRepository(db),
    companies: createCompanyRepository(db),
    itemCompanies: createItemCompanyRepository(db),
    companyResearchRuns: createCompanyResearchRunRepository(db),
    companyResearchDiagnostics: createCompanyResearchDiagnosticRepository(db),
    companyProfileDiagnostics: createCompanyProfileDiagnosticRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    toolExecutions: createToolExecutionRepository(db),
    runInTransaction: (work) => runInTransaction(db, work),
  };
}
