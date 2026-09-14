import { Type } from "typebox";
import type {
  CapabilityItem,
  Company,
  CompanyDraft,
  CompanyProfileInput,
  CompanyProfileEvent,
  CreateIndustryResearchItemInput,
  ItemCompanyView,
  UpdateIndustryResearchItemInput,
} from "./capability-items.js";
import type { Conversation } from "./conversations.js";
import type { AgentWorkerEvent, ChatMessage, ChatRequestOptions, ChatSendResult } from "./chat.js";
import type { SkillSummary } from "./skills.js";
import type {
  CompanyResearchState,
  CompanyResearchEvent,
  ResearchRun,
  ResearchRunSummary,
  StartCompanyResearchInput,
} from "./research.js";
import { StartCompanyResearchInputSchema } from "./research.js";
import { LlmProfileDraftSchema, SearchProfileDraftSchema, type DiagnosticResult, type LlmProfileDraft, type SearchProfileDraft, type SettingsView } from "./settings.js";

export const SettingsGetArgsSchema = Type.Tuple([]);
export const SettingsLlmDraftArgsSchema = Type.Tuple([LlmProfileDraftSchema]);
export const SettingsSearchDraftArgsSchema = Type.Tuple([SearchProfileDraftSchema]);
export const SettingsProfileIdArgsSchema = Type.Tuple([Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])]);
export const SettingsDeleteProfileArgsSchema = Type.Tuple([Type.String({ minLength: 1, maxLength: 200 })]);
export const ConversationDeleteArgsSchema = Type.Tuple([Type.String({ minLength: 1, maxLength: 200 })]);

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
export const CompanyResearchGetRunArgsSchema = Type.Tuple([
  CompanyResearchIdSchema,
  CompanyResearchIdSchema,
  CompanyResearchIdSchema,
]);
export const CompanyResearchRetryStructuringArgsSchema = CompanyResearchGetRunArgsSchema;

export type LlmConnectionStatus = "connected" | "disconnected";

export interface DesktopApi {
  conversations: {
    create(): Promise<Conversation>;
    delete(conversationId: string): Promise<void>;
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
    updateCompany(companyId: string, input: CompanyProfileInput): Promise<Company>;
    addCompany(itemId: string, draft: CompanyDraft): Promise<ItemCompanyView>;
    addCompanies(itemId: string, drafts: CompanyDraft[]): Promise<ItemCompanyView[]>;
    removeCompany(itemId: string, companyId: string): Promise<void>;
    removeCompanies(itemId: string, companyIds: string[]): Promise<void>;
    recognizeCompanies(itemId: string, text: string): Promise<CompanyDraft[]>;
    retryCompanyProfile(companyId: string): Promise<boolean>;
    subscribeCompanyProfiles(listener: (event: CompanyProfileEvent) => void): () => void;
  };
  companyResearch: {
    start(
      itemId: string,
      companyId: string,
      input: StartCompanyResearchInput,
    ): Promise<ResearchRun>;
    cancel(runId: string): Promise<void>;
    getState(itemId: string, companyId: string): Promise<CompanyResearchState>;
    listRuns(itemId: string, companyId: string): Promise<ResearchRunSummary[]>;
    getRun(itemId: string, companyId: string, runId: string): Promise<ResearchRun | undefined>;
    retryStructuring(itemId: string, companyId: string, runId: string): Promise<ResearchRun>;
    subscribe(listener: (event: CompanyResearchEvent) => void): () => void;
  };
  settings: {
    get(): Promise<SettingsView>;
    saveLlmProfile(input: LlmProfileDraft): Promise<SettingsView>;
    activateLlmProfile(id: string | null): Promise<SettingsView>;
    deleteLlmProfile(id: string): Promise<SettingsView>;
    diagnoseLlm(input: LlmProfileDraft): Promise<DiagnosticResult>;
    saveSearchProfile(input: SearchProfileDraft): Promise<SettingsView>;
    activateSearchProfile(id: string | null): Promise<SettingsView>;
    deleteSearchProfile(id: string): Promise<SettingsView>;
    diagnoseSearch(input: SearchProfileDraft): Promise<DiagnosticResult>;
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
