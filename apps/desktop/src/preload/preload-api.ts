import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { UsageDashboardArgsSchema, UsageDashboardSchema } from "@deepfield/contracts";
import type { UsageDashboard } from "@deepfield/base/usage";
import { toPublicError, PublicAppErrorSchema, DiagnosticResultSchema, CompanyResearchWordExportResultSchema, AgentWorkerEventSchema, type AgentWorkerEvent, type ChatMessage, type ChatRequestOptions, type ChatSendResult, type Conversation, type DesktopApi, type LlmProfileDraft, type SearchProfileDraft, type SettingsView, type DiagnosticResult, type CompanyResearchWordExportResult, type SkillSummary } from "@deepfield/contracts";
import { CompanyResearchBatchStateSchema, CompanyProfileProgressSchema, type CompanyResearchBatchState, type CompanyProfileProgress, ResearchRunSchema, CompanyResearchEventSchema, CompanyProfileEventSchema, type CapabilityItem, type Company, type CompanyResearchState, type CompanyResearchEvent, type CompanyDraft, type CompanyProfileInput, type CompanyProfileIdentityHint, type CompanyProfileEvent, type ItemCompanyView, type ResearchRun, type ResearchRunSummary } from "../../../../capabilities/company-research/contracts/index.js";

export const IPC_CHANNELS = {
  usageGetDashboard: "deepfield:usage:getDashboard",
  companyResearchBatchStart: "deepfield:companyResearchBatch:start",
  companyResearchBatchGetState: "deepfield:companyResearchBatch:getState",
  companyResearchBatchCancel: "deepfield:companyResearchBatch:cancel",
  companyResearchBatchResume: "deepfield:companyResearchBatch:resume",
  companyResearchBatchSubscribe: "deepfield:companyResearchBatch:subscribe",
  companyResearchBatchEvents: "deepfield:companyResearchBatch:events",
  companyProfileProgressGet: "deepfield:companyProfiles:progress",
  companyProfileProgressSubscribe: "deepfield:companyProfiles:subscribeProgress",
  companyProfileProgressEvents: "deepfield:companyProfiles:progressEvents",
  copyText: "deepfield:clipboard:copyText",
  industryResearchCreateItem: "deepfield:industryResearch:createItem",
  industryResearchUpdateItem: "deepfield:industryResearch:updateItem",
  industryResearchDeleteItem: "deepfield:industryResearch:deleteItem",
  industryResearchDeleteItems: "deepfield:industryResearch:deleteItems",
  industryResearchListItems: "deepfield:industryResearch:listItems",
  industryResearchGetItem: "deepfield:industryResearch:getItem",
  industryResearchListCompanies: "deepfield:industryResearch:listCompanies",
  industryResearchUpdateCompany: "deepfield:industryResearch:updateCompany",
  industryResearchAddCompany: "deepfield:industryResearch:addCompany",
  industryResearchAddCompanies: "deepfield:industryResearch:addCompanies",
  industryResearchRemoveCompany: "deepfield:industryResearch:removeCompany",
  industryResearchRemoveCompanies: "deepfield:industryResearch:removeCompanies",
  industryResearchRecognizeCompanies: "deepfield:industryResearch:recognizeCompanies",
  industryResearchRetryCompanyProfile: "deepfield:industryResearch:retryCompanyProfile",
  industryResearchConfirmCompanyProfileIdentity: "deepfield:industryResearch:confirmCompanyProfileIdentity",
  industryResearchSubscribeCompanyProfiles: "deepfield:industryResearch:subscribeCompanyProfiles",
  industryResearchCompanyProfileEvents: "deepfield:industryResearch:companyProfileEvents",
  companyResearchStart: "deepfield:companyResearch:start",
  companyResearchCancel: "deepfield:companyResearch:cancel",
  companyResearchGetState: "deepfield:companyResearch:getState",
  companyResearchListRuns: "deepfield:companyResearch:listRuns",
  companyResearchGetRun: "deepfield:companyResearch:getRun",
  companyResearchExportWord: "deepfield:companyResearch:exportWord",
  companyResearchRetryFailed: "deepfield:companyResearch:retryFailed",
  companyResearchRetryStructuring: "deepfield:companyResearch:retryStructuring",
  companyResearchDeleteRun: "deepfield:companyResearch:deleteRun",
  companyResearchSubscribe: "deepfield:companyResearch:subscribe",
  companyResearchEvents: "deepfield:companyResearch:events",
  conversationsCreate: "deepfield:conversations:create",
  conversationsSetWebSearchEnabled: "deepfield:conversations:setWebSearchEnabled",
  conversationsDelete: "deepfield:conversations:delete",
  conversationsOpenInitial: "deepfield:conversations:openInitial",
  conversationsListRecent: "deepfield:conversations:listRecent",
  conversationUpdates: "deepfield:conversations:updates",
  settingsGet: "deepfield:settings:get",
  settingsSaveLlmProfile: "deepfield:settings:saveLlmProfile",
  settingsActivateLlmProfile: "deepfield:settings:activateLlmProfile",
  settingsDeleteLlmProfile: "deepfield:settings:deleteLlmProfile",
  settingsDiagnoseLlm: "deepfield:settings:diagnoseLlm",
  settingsSaveSearchProfile: "deepfield:settings:saveSearchProfile",
  settingsActivateSearchProfile: "deepfield:settings:activateSearchProfile",
  settingsDeleteSearchProfile: "deepfield:settings:deleteSearchProfile",
  settingsDiagnoseSearch: "deepfield:settings:diagnoseSearch",
  skillsList: "deepfield:skills:list",
  chatSend: "deepfield:chat:send",
  chatEvents: "deepfield:chat:events",
  chatListMessages: "deepfield:chat:listMessages",
} as const;

export interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): () => void;
}

export function createPreloadApi(ipc: IpcBridge): DesktopApi {
  // Reject with a plain validated DTO: contextBridge does not preserve Error custom fields.
  const invokeResult = async <T>(channel: string, schema: TSchema, ...args: unknown[]): Promise<T> => {
    let result: unknown;
    try { result = await ipc.invoke(channel, ...args); }
    catch { throw toPublicError(undefined); }
    if (Value.Check(Type.Object({ ok: Type.Literal(false), error: PublicAppErrorSchema }, { additionalProperties: false }), result)) {
      throw toPublicError(result.error);
    }
    if (!Value.Check(Type.Object({ ok: Type.Literal(true), value: schema }, { additionalProperties: false }), result)) throw toPublicError(undefined);
    if (schema === DiagnosticResultSchema) {
      const diagnostic = result.value as DiagnosticResult;
      if (!diagnostic.ok) return { ...diagnostic, message: "连接不可用", error: toPublicError(diagnostic.error) } as T;
      return { ...diagnostic, summary: "连接正常" } as T;
    }
    return result.value as T;
  };
  return {
    usage: { getDashboard: (query) => {
      if (!Value.Check(UsageDashboardArgsSchema, [query])) return Promise.reject(toPublicError(undefined));
      return invokeResult<UsageDashboard>(IPC_CHANNELS.usageGetDashboard, UsageDashboardSchema, query);
    } },
    copyText: (text) => ipc.invoke(IPC_CHANNELS.copyText, text) as Promise<void>,
    conversations: {
      setWebSearchEnabled: (conversationId, enabled) =>
        ipc.invoke(IPC_CHANNELS.conversationsSetWebSearchEnabled, conversationId, enabled) as Promise<Conversation>,
      create: () => ipc.invoke(IPC_CHANNELS.conversationsCreate) as Promise<Conversation>,
      delete: (conversationId) =>
        ipc.invoke(IPC_CHANNELS.conversationsDelete, conversationId) as Promise<void>,
      openInitial: () =>
        ipc.invoke(IPC_CHANNELS.conversationsOpenInitial) as Promise<{
          active: Conversation;
          recent: Conversation[];
        }>,
      listRecent: () =>
        ipc.invoke(IPC_CHANNELS.conversationsListRecent) as Promise<Conversation[]>,
      subscribe: (listener) => ipc.on(IPC_CHANNELS.conversationUpdates, (_event, value) => {
        const schema = Type.Object({
          id: Type.String(), title: Type.String(), hasUserMessage: Type.Boolean(),
          createdAt: Type.String(), updatedAt: Type.String(),
        }, { additionalProperties: false });
        if (Value.Check(schema, value)) listener(value as Conversation);
      }),
    },
    industryResearch: {
      getCompanyProfileProgress: (itemId) => invokeResult<CompanyProfileProgress>(IPC_CHANNELS.companyProfileProgressGet, CompanyProfileProgressSchema, itemId),
      subscribeCompanyProfileProgress: (listener) => {
        void ipc.invoke(IPC_CHANNELS.companyProfileProgressSubscribe).catch(() => {});
        return ipc.on(IPC_CHANNELS.companyProfileProgressEvents, (_event, value) => { if (Value.Check(CompanyProfileProgressSchema, value)) listener(value); });
      },
      createItem: (input) =>
        ipc.invoke(IPC_CHANNELS.industryResearchCreateItem, input) as Promise<CapabilityItem>,
      updateItem: (itemId, input) =>
        ipc.invoke(IPC_CHANNELS.industryResearchUpdateItem, itemId, input) as Promise<CapabilityItem>,
      deleteItem: (itemId) =>
        ipc.invoke(IPC_CHANNELS.industryResearchDeleteItem, itemId) as Promise<void>,
      deleteItems: (itemIds) =>
        ipc.invoke(IPC_CHANNELS.industryResearchDeleteItems, itemIds) as Promise<void>,
      listItems: () =>
        ipc.invoke(IPC_CHANNELS.industryResearchListItems) as Promise<CapabilityItem[]>,
      getItem: (itemId) =>
        ipc.invoke(IPC_CHANNELS.industryResearchGetItem, itemId) as Promise<
          CapabilityItem | undefined
        >,
      listCompanies: (itemId) =>
        ipc.invoke(IPC_CHANNELS.industryResearchListCompanies, itemId) as Promise<
          ItemCompanyView[]
        >,
      updateCompany: (companyId, input: CompanyProfileInput) =>
        ipc.invoke(IPC_CHANNELS.industryResearchUpdateCompany, companyId, input) as Promise<Company>,
      addCompany: (itemId, draft: CompanyDraft) =>
        ipc.invoke(IPC_CHANNELS.industryResearchAddCompany, itemId, draft) as Promise<
          ItemCompanyView
        >,
      addCompanies: (itemId, drafts: CompanyDraft[]) =>
        ipc.invoke(IPC_CHANNELS.industryResearchAddCompanies, itemId, drafts) as Promise<
          ItemCompanyView[]
        >,
      removeCompany: (itemId, companyId) =>
        ipc.invoke(IPC_CHANNELS.industryResearchRemoveCompany, itemId, companyId) as Promise<void>,
      removeCompanies: (itemId, companyIds) =>
        ipc.invoke(IPC_CHANNELS.industryResearchRemoveCompanies, itemId, companyIds) as Promise<void>,
      recognizeCompanies: (itemId, text) =>
        ipc.invoke(IPC_CHANNELS.industryResearchRecognizeCompanies, itemId, text) as Promise<
          CompanyDraft[]
        >,
      retryCompanyProfile: (companyId) =>
        ipc.invoke(IPC_CHANNELS.industryResearchRetryCompanyProfile, companyId) as Promise<boolean>,
      confirmCompanyProfileIdentity: (companyId, hint: CompanyProfileIdentityHint) =>
        ipc.invoke(IPC_CHANNELS.industryResearchConfirmCompanyProfileIdentity, companyId, hint) as Promise<boolean>,
      subscribeCompanyProfiles: (listener: (event: CompanyProfileEvent) => void) => {
        void ipc.invoke(IPC_CHANNELS.industryResearchSubscribeCompanyProfiles).catch(() => {});
        return ipc.on(IPC_CHANNELS.industryResearchCompanyProfileEvents, (_event, value) => {
          if (Value.Check(CompanyProfileEventSchema, value)) listener(value);
        });
      },
    },
    companyResearch: {
      start: (itemId, companyId, input) =>
        invokeResult<ResearchRun>(IPC_CHANNELS.companyResearchStart, ResearchRunSchema, itemId, companyId, input) as Promise<ResearchRun>,
      cancel: (runId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchCancel, runId) as Promise<void>,
      getState: (itemId, companyId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchGetState, itemId, companyId) as Promise<CompanyResearchState>,
      listRuns: (itemId, companyId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchListRuns, itemId, companyId) as Promise<ResearchRunSummary[]>,
      getRun: (itemId, companyId, runId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchGetRun, itemId, companyId, runId) as Promise<ResearchRun | undefined>,
      exportWord: (itemId, companyId, runId, selection) =>
        invokeResult<CompanyResearchWordExportResult>(IPC_CHANNELS.companyResearchExportWord, CompanyResearchWordExportResultSchema, itemId, companyId, runId, selection),
      retryStructuring: (itemId, companyId, runId) =>
        invokeResult<ResearchRun>(IPC_CHANNELS.companyResearchRetryStructuring, ResearchRunSchema, itemId, companyId, runId) as Promise<ResearchRun>,
      retryFailed: (itemId, companyId, runId, input) =>
        invokeResult<ResearchRun>(IPC_CHANNELS.companyResearchRetryFailed, ResearchRunSchema, itemId, companyId, runId, input) as Promise<ResearchRun>,
      deleteRun: (itemId, companyId, runId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchDeleteRun, itemId, companyId, runId) as Promise<void>,
      subscribe: (listener: (event: CompanyResearchEvent) => void) => {
        void ipc.invoke(IPC_CHANNELS.companyResearchSubscribe).catch(() => {});
        return ipc.on(IPC_CHANNELS.companyResearchEvents, (_event, value) => {
          if (Value.Check(CompanyResearchEventSchema, value)) listener(value);
        });
      },
    },
    companyResearchBatch: {
      start: (itemId, entries) => invokeResult<CompanyResearchBatchState>(IPC_CHANNELS.companyResearchBatchStart, CompanyResearchBatchStateSchema, itemId, entries),
      getState: (itemId) => invokeResult<CompanyResearchBatchState | null>(IPC_CHANNELS.companyResearchBatchGetState, Type.Union([CompanyResearchBatchStateSchema, Type.Null()]), itemId),
      cancel: async (batchId) => { await invokeResult(IPC_CHANNELS.companyResearchBatchCancel, Type.Null(), batchId); },
      resume: (batchId) => invokeResult<CompanyResearchBatchState>(IPC_CHANNELS.companyResearchBatchResume, CompanyResearchBatchStateSchema, batchId),
      subscribe: (listener) => {
        void ipc.invoke(IPC_CHANNELS.companyResearchBatchSubscribe).catch(() => {});
        return ipc.on(IPC_CHANNELS.companyResearchBatchEvents, (_event, value) => { if (Value.Check(CompanyResearchBatchStateSchema, value)) listener(value); });
      },
    },
    settings: {
      get: () => ipc.invoke(IPC_CHANNELS.settingsGet) as Promise<SettingsView>,
      saveLlmProfile: (input: LlmProfileDraft) => ipc.invoke(IPC_CHANNELS.settingsSaveLlmProfile, input) as Promise<SettingsView>,
      activateLlmProfile: (id: string | null) => ipc.invoke(IPC_CHANNELS.settingsActivateLlmProfile, id) as Promise<SettingsView>,
      deleteLlmProfile: (id: string) => ipc.invoke(IPC_CHANNELS.settingsDeleteLlmProfile, id) as Promise<SettingsView>,
      diagnoseLlm: (input: LlmProfileDraft) => invokeResult<DiagnosticResult>(IPC_CHANNELS.settingsDiagnoseLlm, DiagnosticResultSchema, input) as Promise<DiagnosticResult>,
      saveSearchProfile: (input: SearchProfileDraft) => ipc.invoke(IPC_CHANNELS.settingsSaveSearchProfile, input) as Promise<SettingsView>,
      activateSearchProfile: (id: string | null) => ipc.invoke(IPC_CHANNELS.settingsActivateSearchProfile, id) as Promise<SettingsView>,
      deleteSearchProfile: (id: string) => ipc.invoke(IPC_CHANNELS.settingsDeleteSearchProfile, id) as Promise<SettingsView>,
      diagnoseSearch: (input: SearchProfileDraft) => invokeResult<DiagnosticResult>(IPC_CHANNELS.settingsDiagnoseSearch, DiagnosticResultSchema, input) as Promise<DiagnosticResult>,
    },
    skills: {
      list: () => ipc.invoke(IPC_CHANNELS.skillsList) as Promise<SkillSummary[]>,
    },
    chat: {
      send: (
        conversationId: string,
        content: string,
        requestId: string,
        options: ChatRequestOptions,
      ) =>
        ipc.invoke(
          IPC_CHANNELS.chatSend,
          conversationId,
          content,
          requestId,
          options,
        ) as Promise<ChatSendResult>,
      subscribe: (listener: (event: AgentWorkerEvent) => void) =>
        ipc.on(IPC_CHANNELS.chatEvents, (_event, value) => {
          if (Value.Check(AgentWorkerEventSchema, value)) {
            listener(value);
          }
        }),
      listMessages: (conversationId: string) =>
        ipc.invoke(IPC_CHANNELS.chatListMessages, conversationId) as Promise<ChatMessage[]>,
    },
  };
}
