import { Type } from "typebox";
import type {
  CapabilityItem,
  CompanyDraft,
  CreateIndustryResearchItemInput,
  ItemCompanyView,
  UpdateIndustryResearchItemInput,
} from "./capability-items.js";
import type { Conversation } from "./conversations.js";
import type { AgentWorkerEvent, ChatMessage, ChatRequestOptions, ChatSendResult } from "./chat.js";
import type { SkillSummary } from "./skills.js";
import type {
  CompanyResearchState,
  CompanyResearchWorkerEvent,
  ResearchRun,
  StartCompanyResearchInput,
} from "./research.js";
import { StartCompanyResearchInputSchema } from "./research.js";

const CompanyResearchIdSchema = Type.String({ minLength: 1, maxLength: 200 });
export const CompanyResearchStartArgsSchema = Type.Tuple([
  CompanyResearchIdSchema,
  CompanyResearchIdSchema,
  StartCompanyResearchInputSchema,
]);
export const CompanyResearchCancelArgsSchema = Type.Tuple([CompanyResearchIdSchema]);
export const CompanyResearchTargetArgsSchema = Type.Tuple([
  CompanyResearchIdSchema,
  CompanyResearchIdSchema,
]);
export const CompanyResearchSubscribeArgsSchema = Type.Tuple([]);

export type LlmConnectionStatus = "connected" | "disconnected";

export interface DesktopApi {
  conversations: {
    create(): Promise<Conversation>;
    openInitial(): Promise<{ active: Conversation; recent: Conversation[] }>;
    listRecent(): Promise<Conversation[]>;
  };
  industryResearch: {
    createItem(input: CreateIndustryResearchItemInput): Promise<CapabilityItem>;
    updateItem(itemId: string, input: UpdateIndustryResearchItemInput): Promise<CapabilityItem>;
    deleteItem(itemId: string): Promise<void>;
    deleteItems(itemIds: string[]): Promise<void>;
    listItems(): Promise<CapabilityItem[]>;
    getItem(itemId: string): Promise<CapabilityItem | undefined>;
    listCompanies(itemId: string): Promise<ItemCompanyView[]>;
    addCompany(itemId: string, draft: CompanyDraft): Promise<ItemCompanyView>;
    addCompanies(itemId: string, drafts: CompanyDraft[]): Promise<ItemCompanyView[]>;
    removeCompany(itemId: string, companyId: string): Promise<void>;
    removeCompanies(itemId: string, companyIds: string[]): Promise<void>;
    recognizeCompanies(itemId: string, text: string): Promise<CompanyDraft[]>;
  };
  companyResearch: {
    start(
      itemId: string,
      companyId: string,
      input: StartCompanyResearchInput,
    ): Promise<ResearchRun>;
    cancel(runId: string): Promise<void>;
    getState(itemId: string, companyId: string): Promise<CompanyResearchState>;
    listCompleted(itemId: string, companyId: string): Promise<ResearchRun[]>;
    subscribe(listener: (event: CompanyResearchWorkerEvent) => void): () => void;
  };
  settings: {
    hasDeepSeekKey(): Promise<boolean>;
    setDeepSeekKey(value: string): Promise<void>;
  };
  llm: {
    checkConnection(): Promise<LlmConnectionStatus>;
  };
  skills: {
    list(): Promise<SkillSummary[]>;
  };
  chat: {
    send(
      conversationId: string,
      content: string,
      requestId: string,
      options: ChatRequestOptions,
    ): Promise<ChatSendResult>;
    subscribe(listener: (event: AgentWorkerEvent) => void): () => void;
    listMessages(conversationId: string): Promise<ChatMessage[]>;
  };
}
