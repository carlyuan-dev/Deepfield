import { Type, type Static } from "typebox";
import type { UsageDashboardApi } from "@deepfield/base/usage";
import type { BatchResearchEntryInput, CompanyResearchBatchState, CompanyProfileProgress } from "./batch-research.js";
import { CompanyProfileIdentityHintSchema } from "./capability-items.js";
import type {
  CapabilityItem,
  Company,
  CompanyDraft,
  CompanyProfileInput,
  CompanyProfileEvent,
  CompanyProfileIdentityHint,
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
export const CopyTextArgsSchema = Type.Tuple([Type.String()]);

const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
export const CompanyResearchStartArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  StartCompanyResearchInputSchema,
]);
export const CompanyResearchCancelArgsSchema = Type.Tuple([IdSchema]);
export const CompanyResearchTargetArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
]);
export const CompanyResearchSubscribeArgsSchema = Type.Tuple([]);
export const CompanyResearchGetRunArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  IdSchema,
]);
export const CompanyResearchWordExportSelectionSchema = Type.Object({
  raw: Type.Boolean(),
  structured: Type.Boolean(),
}, { additionalProperties: false });
export type CompanyResearchWordExportSelection = Static<typeof CompanyResearchWordExportSelectionSchema>;
export const CompanyResearchExportArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  IdSchema,
  CompanyResearchWordExportSelectionSchema,
]);
export const CompanyResearchWordExportResultSchema = Type.Object({
  status: Type.Union([Type.Literal("saved"), Type.Literal("cancelled")]),
}, { additionalProperties: false });
export type CompanyResearchWordExportResult = Static<typeof CompanyResearchWordExportResultSchema>;
export const CompanyResearchRetryFailedArgsSchema = Type.Tuple([
  IdSchema,
  IdSchema,
  IdSchema,
  StartCompanyResearchInputSchema,
]);
export const CompanyResearchDeleteRunArgsSchema = Type.Tuple([IdSchema, IdSchema, IdSchema]);
export const CompanyResearchRetryStructuringArgsSchema = Type.Tuple([IdSchema, IdSchema, IdSchema]);
export const ConfirmCompanyProfileIdentityArgsSchema = Type.Tuple([
  IdSchema,
  CompanyProfileIdentityHintSchema,
]);

export type LlmConnectionStatus = "connected" | "disconnected";

export interface DesktopApi {
  usage: UsageDashboardApi;
  copyText(text: string): Promise<void>;
  conversations: {
    setWebSearchEnabled(conversationId: string, enabled: boolean): Promise<Conversation>;
    create(): Promise<Conversation>;
    delete(conversationId: string): Promise<void>;
    openInitial(): Promise<{ active: Conversation; recent: Conversation[] }>;
    listRecent(): Promise<Conversation[]>;
    subscribe(listener: (conversation: Conversation) => void): () => void;
  };
  industryResearch: {
    getCompanyProfileProgress(itemId: string): Promise<CompanyProfileProgress>;
    subscribeCompanyProfileProgress(listener: (state: CompanyProfileProgress) => void): () => void;
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
    confirmCompanyProfileIdentity(companyId: string, hint: CompanyProfileIdentityHint): Promise<boolean>;
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
    exportWord(itemId: string, companyId: string, runId: string, selection: CompanyResearchWordExportSelection): Promise<CompanyResearchWordExportResult>;
    retryStructuring(itemId: string, companyId: string, runId: string): Promise<ResearchRun>;
    retryFailed(
      itemId: string,
      companyId: string,
      runId: string,
      input: StartCompanyResearchInput,
    ): Promise<ResearchRun>;
    deleteRun(itemId: string, companyId: string, runId: string): Promise<void>;
    subscribe(listener: (event: CompanyResearchEvent) => void): () => void;
  };
  companyResearchBatch: {
    start(itemId: string, entries: BatchResearchEntryInput[]): Promise<CompanyResearchBatchState>;
    getState(itemId: string): Promise<CompanyResearchBatchState | null>;
    cancel(batchId: string): Promise<void>;
    resume(batchId: string): Promise<CompanyResearchBatchState>;
    subscribe(listener: (state: CompanyResearchBatchState) => void): () => void;
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
