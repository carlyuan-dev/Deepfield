import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { UsageDashboardArgsSchema, UsageDashboardSchema, UsageDeleteUnknownFailuresArgsSchema, UsageRepairArgsSchema, UsageRepairResultSchema, UsageAcknowledgeUnknownArgsSchema, UsageAcknowledgeHistoryArgsSchema } from "@deepfield/contracts";
import type { UsageDashboard } from "@deepfield/base/usage";
import { toPublicError, PublicAppErrorSchema, DiagnosticResultSchema, AgentWorkerEventSchema, type AgentWorkerEvent, type ChatMessage, type ChatRequestOptions, type ChatSendResult, type Conversation, type DesktopApi, type LlmProfileDraft, type SearchProfileDraft, type SettingsView, type DiagnosticResult, type SkillSummary } from "@deepfield/contracts";
import { CapabilityCallSchema, CapabilityEventSchema, CapabilityNavigationEventSchema, ViewOpenResultSchema, type ViewOpenResult } from "@deepfield/capability-sdk";
import { CapabilitySnapshotSchema, CapabilitySetEnabledArgsSchema, type CapabilitySnapshot } from "@deepfield/contracts";
import { ChatCapabilityTaskCardSchema, ChatCapabilityConfirmationSchema, ChatCapabilityOperationCardSchema, ChatCapabilityViewSchema, type ChatCapabilityTaskCard, type ChatCapabilityConfirmation, type ChatCapabilityOperationCard, type ChatCapabilityView } from "@deepfield/contracts";
import { CHAT_INTERACTION_CHANNELS, InteractionRecordSchema, InteractionEditorStateSchema, RespondCommandSchema, type InteractionRecord, type InteractionEditorState } from "@deepfield/contracts";

export const IPC_CHANNELS = {
  chatCapabilitySubscribe: "deepfield:chat-capability:subscribe",
  chatCapabilityUnsubscribe: "deepfield:chat-capability:unsubscribe",
  chatCapabilityEvents: "deepfield:chat-capability:events",
  chatCapabilityStream: "deepfield:chat-capability:stream",
  chatCapabilityActive: "deepfield:chat-capability:active",
  chatCapabilityTasks: "deepfield:chat-capability:tasks",
  chatCapabilityConfirmations: "deepfield:chat-capability:confirmations",
  chatCapabilityOperations: "deepfield:chat-capability:operations",
  chatCapabilityViews: "deepfield:chat-capability:views",
  chatCapabilityApprove: "deepfield:chat-capability:approve",
  chatCapabilityDismiss: "deepfield:chat-capability:dismiss",
  chatCapabilityOpen: "deepfield:chat-capability:open",
  chatCapabilityAnalyze: "deepfield:chat-capability:analyze",
  navigationSubscribe: "deepfield:navigation:subscribe",
  navigationUnsubscribe: "deepfield:navigation:unsubscribe",
  navigationEvents: "deepfield:navigation:events",
  navigationAck: "deepfield:navigation:ack",
  navigationRetry: "deepfield:navigation:retry",
  navigationManual: "deepfield:navigation:manual",
  capabilityManagementList: "deepfield:capability-management:list",
  capabilityManagementSetEnabled: "deepfield:capability-management:setEnabled",
  capabilityManagementRestart: "deepfield:capability-management:restart",
  capabilityManagementSubscribe: "deepfield:capability-management:subscribe",
  capabilityManagementUnsubscribe: "deepfield:capability-management:unsubscribe",
  capabilityManagementEvents: "deepfield:capability-management:events",
  capabilityInvoke: "deepfield:capability:invoke",
  capabilitySubscribe: "deepfield:capability:subscribe",
  capabilityUnsubscribe: "deepfield:capability:unsubscribe",
  capabilityEvents: "deepfield:capability:events",
  usageGetDashboard: "deepfield:usage:getDashboard",
  usageDeleteUnknownFailures: "deepfield:usage:deleteUnknownFailures",
  usageRepair: "deepfield:usage:repair",
  usageAcknowledgeUnknown: "deepfield:usage:acknowledgeUnknown",
  usageAcknowledgeHistory: "deepfield:usage:acknowledgeHistory",
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
  let managementSubscribers = 0;
  let navigationSubscribers = 0;
  let chatCapabilitySubscribers = 0;
  let interactionSubscribers = 0;
  const interactionId = Type.String({ minLength: 1, maxLength: 200 });
  const revision = Type.Integer({ minimum: 1 });
  const invokeInteraction = <T>(channel: string, result: TSchema, argsSchema: TSchema, ...args: unknown[]): Promise<T> => {
    if (!Value.Check(argsSchema, args)) return Promise.reject(toPublicError(undefined));
    return invokeResult<T>(channel, result, ...args);
  };
  return {
    chatCapability: {
      listTasks: conversationId => invokeResult<ChatCapabilityTaskCard[]>(IPC_CHANNELS.chatCapabilityTasks, Type.Array(ChatCapabilityTaskCardSchema), conversationId),
      listConfirmations: conversationId => invokeResult<ChatCapabilityConfirmation[]>(IPC_CHANNELS.chatCapabilityConfirmations, Type.Array(ChatCapabilityConfirmationSchema), conversationId),
      listOperations: conversationId => invokeResult<ChatCapabilityOperationCard[]>(IPC_CHANNELS.chatCapabilityOperations, Type.Array(ChatCapabilityOperationCardSchema), conversationId),
      listViews: conversationId => invokeResult<ChatCapabilityView[]>(IPC_CHANNELS.chatCapabilityViews, Type.Array(ChatCapabilityViewSchema), conversationId),
      approve: (conversationId, confirmationRef, analyzeAfter) => invokeResult(IPC_CHANNELS.chatCapabilityApprove, Type.Unknown(), conversationId, confirmationRef, analyzeAfter),
      dismiss: (conversationId, confirmationRef) => invokeResult<boolean>(IPC_CHANNELS.chatCapabilityDismiss, Type.Boolean(), conversationId, confirmationRef),
      open: (conversationId, target) => invokeResult(IPC_CHANNELS.chatCapabilityOpen, ViewOpenResultSchema, conversationId, target),
      chooseAnalysis: (conversationId, capabilityId, taskId, enabled) => invokeResult<boolean>(IPC_CHANNELS.chatCapabilityAnalyze, Type.Boolean(), conversationId, capabilityId, taskId, enabled),
      setActiveConversation: async conversationId => { await invokeResult(IPC_CHANNELS.chatCapabilityActive, Type.Null(), conversationId); },
      subscribe: listener => {
        const remove = ipc.on(IPC_CHANNELS.chatCapabilityEvents, (_event, value) => { if (typeof value === "string") listener(value); });
        if (++chatCapabilitySubscribers === 1) void ipc.invoke(IPC_CHANNELS.chatCapabilitySubscribe).catch(() => {});
        let active = true;
        return () => { if (!active) return; active = false; remove(); if (--chatCapabilitySubscribers === 0) void ipc.invoke(IPC_CHANNELS.chatCapabilityUnsubscribe).catch(() => {}); };
      },
      subscribeStream: listener => {
        const remove = ipc.on(IPC_CHANNELS.chatCapabilityStream, (_event, value) => {
          if (typeof value === "object" && value !== null && typeof (value as { conversationId?: unknown }).conversationId === "string"
            && Value.Check(AgentWorkerEventSchema, (value as { event?: unknown }).event)) {
            const payload = value as { conversationId: string; event: AgentWorkerEvent };
            listener(payload.conversationId, payload.event);
          }
        });
        if (++chatCapabilitySubscribers === 1) void ipc.invoke(IPC_CHANNELS.chatCapabilitySubscribe).catch(() => {});
        let active = true;
        return () => { if (!active) return; active = false; remove(); if (--chatCapabilitySubscribers === 0) void ipc.invoke(IPC_CHANNELS.chatCapabilityUnsubscribe).catch(() => {}); };
      },
    },
    capabilityNavigation: {
      noteManualNavigation: async () => { await invokeResult(IPC_CHANNELS.navigationManual, Type.Null()); },
      subscribe: listener => {
        const remove = ipc.on(IPC_CHANNELS.navigationEvents, (_event, value) => { if (Value.Check(CapabilityNavigationEventSchema, value)) listener(value); });
        if (++navigationSubscribers === 1) void ipc.invoke(IPC_CHANNELS.navigationSubscribe).catch(() => {});
        let active = true;
        return () => { if (!active) return; active = false; remove(); if (--navigationSubscribers === 0) void ipc.invoke(IPC_CHANNELS.navigationUnsubscribe).catch(() => {}); };
      },
      ack: (requestId, capabilityId, result) => invokeResult<boolean>(IPC_CHANNELS.navigationAck, Type.Boolean(), requestId, capabilityId, result),
      retry: requestId => invokeResult<ViewOpenResult>(IPC_CHANNELS.navigationRetry, ViewOpenResultSchema, requestId),
    },
    capabilityManagement: {
      list: () => invokeResult<CapabilitySnapshot>(IPC_CHANNELS.capabilityManagementList, CapabilitySnapshotSchema),
      setEnabled: async (id, enabled) => {
        if (!Value.Check(CapabilitySetEnabledArgsSchema, [id, enabled])) throw toPublicError(undefined);
        await invokeResult(IPC_CHANNELS.capabilityManagementSetEnabled, Type.Null(), id, enabled);
      },
      restart: async () => {
        await invokeResult(IPC_CHANNELS.capabilityManagementRestart, Type.Null());
      },
      subscribe: listener => {
        const remove = ipc.on(IPC_CHANNELS.capabilityManagementEvents, (_event, snapshot) => {
          if (Value.Check(CapabilitySnapshotSchema, snapshot)) listener(snapshot as CapabilitySnapshot);
        });
        if (++managementSubscribers === 1) void ipc.invoke(IPC_CHANNELS.capabilityManagementSubscribe).catch(() => {});
        let active = true;
        return () => { if (!active) return; active = false; remove(); if (--managementSubscribers === 0) void ipc.invoke(IPC_CHANNELS.capabilityManagementUnsubscribe).catch(() => {}); };
      },
    },
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
    }, deleteUnknownFailures: (snapshot) => {
      if (!Value.Check(UsageDeleteUnknownFailuresArgsSchema, [snapshot])) return Promise.reject(toPublicError(undefined));
      return invokeResult<number>(IPC_CHANNELS.usageDeleteUnknownFailures, Type.Integer({ minimum: 0 }), snapshot);
    }, repair: () => {
      if (!Value.Check(UsageRepairArgsSchema, [])) return Promise.reject(toPublicError(undefined));
      return invokeResult(IPC_CHANNELS.usageRepair, UsageRepairResultSchema);
    }, acknowledgeUnknownUsage: (attemptIds) => {
      if (!Value.Check(UsageAcknowledgeUnknownArgsSchema, [attemptIds])) return Promise.reject(toPublicError(undefined));
      return invokeResult<number>(IPC_CHANNELS.usageAcknowledgeUnknown, Type.Integer({ minimum: 0 }), attemptIds);
    }, acknowledgeHistoricalIssues: (fingerprint) => {
      if (!Value.Check(UsageAcknowledgeHistoryArgsSchema, [fingerprint])) return Promise.reject(toPublicError(undefined));
      return invokeResult<boolean>(IPC_CHANNELS.usageAcknowledgeHistory, Type.Boolean(), fingerprint);
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
      listInteractions: conversationId => invokeInteraction<InteractionRecord[]>(CHAT_INTERACTION_CHANNELS.list, Type.Array(InteractionRecordSchema), Type.Tuple([interactionId]), conversationId),
      respondInteraction: (conversationId, command) => invokeInteraction<InteractionRecord>(CHAT_INTERACTION_CHANNELS.respond, InteractionRecordSchema, Type.Tuple([interactionId, RespondCommandSchema]), conversationId, command),
      readInteractionEditor: (conversationId, id) => invokeInteraction<InteractionEditorState>(CHAT_INTERACTION_CHANNELS.editorRead, InteractionEditorStateSchema, Type.Tuple([interactionId, interactionId]), conversationId, id),
      autoOpenInteractionEditor: (conversationId, id) => invokeInteraction<ViewOpenResult>(CHAT_INTERACTION_CHANNELS.editorAutoOpen, ViewOpenResultSchema, Type.Tuple([interactionId, interactionId]), conversationId, id),
      openInteractionEditor: (conversationId, id) => invokeInteraction<ViewOpenResult>(CHAT_INTERACTION_CHANNELS.editorOpen, ViewOpenResultSchema, Type.Tuple([interactionId, interactionId]), conversationId, id),
      beginInteractionEdit: (conversationId, id, expectedRevision) => invokeInteraction<InteractionRecord>(CHAT_INTERACTION_CHANNELS.editorBegin, InteractionRecordSchema, Type.Tuple([interactionId, interactionId, revision]), conversationId, id, expectedRevision),
      updateInteractionEditor: (conversationId, id, expectedRevision, patch) => invokeInteraction<InteractionEditorState>(CHAT_INTERACTION_CHANNELS.editorUpdate, InteractionEditorStateSchema, Type.Tuple([interactionId, interactionId, revision, Type.Unknown()]), conversationId, id, expectedRevision, patch),
      transitionInteractionEditor: (conversationId, id, expectedRevision, transitionId) => invokeInteraction<InteractionEditorState>(CHAT_INTERACTION_CHANNELS.editorTransition, InteractionEditorStateSchema, Type.Tuple([interactionId, interactionId, revision, interactionId]), conversationId, id, expectedRevision, transitionId),
      respondInteractionEditor: (conversationId, command) => invokeInteraction<InteractionRecord>(CHAT_INTERACTION_CHANNELS.editorRespond, InteractionRecordSchema, Type.Tuple([interactionId, RespondCommandSchema]), conversationId, command),
      onInteractions: listener => {
        const remove = ipc.on(CHAT_INTERACTION_CHANNELS.events, (_event, value) => { if (typeof value === "string") listener(value); });
        if (++interactionSubscribers === 1) void ipc.invoke(CHAT_INTERACTION_CHANNELS.subscribe).catch(() => {});
        let active = true;
        return () => { if (!active) return; active = false; remove(); if (--interactionSubscribers === 0) void ipc.invoke(CHAT_INTERACTION_CHANNELS.unsubscribe).catch(() => {}); };
      },
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
