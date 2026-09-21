import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { UsageDashboardArgsSchema, UsageDashboardSchema } from "@deepfield/contracts";
import type { UsageDashboard } from "@deepfield/base/usage";
import { toPublicError, PublicAppErrorSchema, DiagnosticResultSchema, AgentWorkerEventSchema, type AgentWorkerEvent, type ChatMessage, type ChatRequestOptions, type ChatSendResult, type Conversation, type DesktopApi, type LlmProfileDraft, type SearchProfileDraft, type SettingsView, type DiagnosticResult, type SkillSummary } from "@deepfield/contracts";
import { CapabilityCallSchema, CapabilityEventSchema } from "@deepfield/capability-sdk";

export const IPC_CHANNELS = {
  capabilityInvoke: "deepfield:capability:invoke",
  capabilitySubscribe: "deepfield:capability:subscribe",
  capabilityUnsubscribe: "deepfield:capability:unsubscribe",
  capabilityEvents: "deepfield:capability:events",
  usageGetDashboard: "deepfield:usage:getDashboard",
  copyText: "deepfield:clipboard:copyText",
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
  let subscribers = 0;
  return {
    capabilities: {
      invoke: call => {
        if (!Value.Check(CapabilityCallSchema, call)) return Promise.reject(toPublicError(undefined));
        return invokeResult(IPC_CHANNELS.capabilityInvoke, Type.Unknown(), call);
      },
      subscribe: listener => {
        const dispose = ipc.on(IPC_CHANNELS.capabilityEvents, (_event, value) => { if (Value.Check(CapabilityEventSchema, value)) listener(value); });
        if (++subscribers === 1) void ipc.invoke(IPC_CHANNELS.capabilitySubscribe).catch(() => {});
        let active = true;
        return () => { if (!active) return; active = false; dispose(); if (--subscribers === 0) void ipc.invoke(IPC_CHANNELS.capabilityUnsubscribe).catch(() => {}); };
      },
    },
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
