import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  CompanyResearchWorkerEventSchema,
  type AgentWorkerEvent,
  type CapabilityItem,
  type CompanyResearchState,
  type CompanyResearchWorkerEvent,
  type ChatMessage,
  type ChatRequestOptions,
  type ChatSendResult,
  type CompanyDraft,
  type Conversation,
  type DesktopApi,
  type ItemCompanyView,
  type LlmConnectionStatus,
  type ResearchRun,
  type SkillSummary,
} from "@deepfield/contracts";

export const IPC_CHANNELS = {
  industryResearchCreateItem: "deepfield:industryResearch:createItem",
  industryResearchUpdateItem: "deepfield:industryResearch:updateItem",
  industryResearchDeleteItem: "deepfield:industryResearch:deleteItem",
  industryResearchDeleteItems: "deepfield:industryResearch:deleteItems",
  industryResearchListItems: "deepfield:industryResearch:listItems",
  industryResearchGetItem: "deepfield:industryResearch:getItem",
  industryResearchListCompanies: "deepfield:industryResearch:listCompanies",
  industryResearchAddCompany: "deepfield:industryResearch:addCompany",
  industryResearchAddCompanies: "deepfield:industryResearch:addCompanies",
  industryResearchRemoveCompany: "deepfield:industryResearch:removeCompany",
  industryResearchRemoveCompanies: "deepfield:industryResearch:removeCompanies",
  industryResearchRecognizeCompanies: "deepfield:industryResearch:recognizeCompanies",
  companyResearchStart: "deepfield:companyResearch:start",
  companyResearchCancel: "deepfield:companyResearch:cancel",
  companyResearchGetState: "deepfield:companyResearch:getState",
  companyResearchListCompleted: "deepfield:companyResearch:listCompleted",
  companyResearchSubscribe: "deepfield:companyResearch:subscribe",
  companyResearchEvents: "deepfield:companyResearch:events",
  conversationsCreate: "deepfield:conversations:create",
  conversationsOpenInitial: "deepfield:conversations:openInitial",
  conversationsListRecent: "deepfield:conversations:listRecent",
  settingsHasDeepSeekKey: "deepfield:settings:hasDeepSeekKey",
  settingsSetDeepSeekKey: "deepfield:settings:setDeepSeekKey",
  llmCheckConnection: "deepfield:llm:checkConnection",
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
  return {
    conversations: {
      create: () => ipc.invoke(IPC_CHANNELS.conversationsCreate) as Promise<Conversation>,
      openInitial: () =>
        ipc.invoke(IPC_CHANNELS.conversationsOpenInitial) as Promise<{
          active: Conversation;
          recent: Conversation[];
        }>,
      listRecent: () =>
        ipc.invoke(IPC_CHANNELS.conversationsListRecent) as Promise<Conversation[]>,
    },
    industryResearch: {
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
    },
    companyResearch: {
      start: (itemId, companyId, input) =>
        ipc.invoke(IPC_CHANNELS.companyResearchStart, itemId, companyId, input) as Promise<ResearchRun>,
      cancel: (runId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchCancel, runId) as Promise<void>,
      getState: (itemId, companyId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchGetState, itemId, companyId) as Promise<CompanyResearchState>,
      listCompleted: (itemId, companyId) =>
        ipc.invoke(IPC_CHANNELS.companyResearchListCompleted, itemId, companyId) as Promise<ResearchRun[]>,
      subscribe: (listener: (event: CompanyResearchWorkerEvent) => void) => {
        void ipc.invoke(IPC_CHANNELS.companyResearchSubscribe).catch(() => {});
        return ipc.on(IPC_CHANNELS.companyResearchEvents, (_event, value) => {
          if (Value.Check(CompanyResearchWorkerEventSchema, value)) listener(value);
        });
      },
    },
    settings: {
      hasDeepSeekKey: () =>
        ipc.invoke(IPC_CHANNELS.settingsHasDeepSeekKey) as Promise<boolean>,
      setDeepSeekKey: (value: string) =>
        ipc.invoke(IPC_CHANNELS.settingsSetDeepSeekKey, value) as Promise<void>,
    },
    llm: {
      checkConnection: () =>
        ipc.invoke(IPC_CHANNELS.llmCheckConnection) as Promise<LlmConnectionStatus>,
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
