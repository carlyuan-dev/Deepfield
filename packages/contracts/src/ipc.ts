import { Type } from "typebox";
import type { UsageDashboardApi } from "@deepfield/base/usage";
import type { Conversation } from "./conversations.js";
import type { AgentWorkerEvent, ChatMessage, ChatRequestOptions, ChatSendResult } from "./chat.js";
import type { SkillSummary } from "./skills.js";
import { LlmProfileDraftSchema, SearchProfileDraftSchema, type DiagnosticResult, type LlmProfileDraft, type SearchProfileDraft, type SettingsView } from "./settings.js";

export const SettingsGetArgsSchema = Type.Tuple([]);
export const SettingsLlmDraftArgsSchema = Type.Tuple([LlmProfileDraftSchema]);
export const SettingsSearchDraftArgsSchema = Type.Tuple([SearchProfileDraftSchema]);
export const SettingsProfileIdArgsSchema = Type.Tuple([Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])]);
export const SettingsDeleteProfileArgsSchema = Type.Tuple([Type.String({ minLength: 1, maxLength: 200 })]);
export const ConversationDeleteArgsSchema = Type.Tuple([Type.String({ minLength: 1, maxLength: 200 })]);
export const CopyTextArgsSchema = Type.Tuple([Type.String()]);

export type LlmConnectionStatus = "connected" | "disconnected";

import type { CapabilityBridge, CapabilityNavigationBridge } from "@deepfield/capability-sdk";

export interface DesktopApi {
  chatCapability?: {
    listTasks(conversationId: string): Promise<import("./chat-capability.js").ChatCapabilityTaskCard[]>;
    listConfirmations(conversationId: string): Promise<import("./chat-capability.js").ChatCapabilityConfirmation[]>;
    listOperations(conversationId: string): Promise<import("./chat-capability.js").ChatCapabilityOperationCard[]>;
    listViews(conversationId: string): Promise<import("./chat-capability.js").ChatCapabilityView[]>;
    approve(conversationId: string, confirmationRef: string, analyzeAfter: boolean): Promise<unknown>;
    dismiss(conversationId: string, confirmationRef: string): Promise<boolean>;
    open(conversationId: string, target: import("@deepfield/capability-sdk").ViewRef | import("@deepfield/capability-sdk").DraftRef): Promise<import("@deepfield/capability-sdk").ViewOpenResult>;
    chooseAnalysis(conversationId: string, capabilityId: string, taskId: string, enabled: boolean): Promise<boolean>;
    setActiveConversation(conversationId: string): Promise<void>;
    subscribe(listener: (conversationId: string) => void): () => void;
    subscribeStream(listener: (conversationId: string, event: AgentWorkerEvent) => void): () => void;
  };
  capabilityManagement: import("./capability-management.js").CapabilityManagementApi;
  capabilities: CapabilityBridge;
  capabilityNavigation?: CapabilityNavigationBridge;
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
    listInteractions(conversationId: string): Promise<import("./chat-interaction.js").InteractionRecord[]>;
    respondInteraction(conversationId: string, command: import("./chat-interaction.js").RespondCommand): Promise<import("./chat-interaction.js").InteractionRecord>;
    respondInteractionEditor(conversationId: string, command: import("./chat-interaction.js").RespondCommand): Promise<import("./chat-interaction.js").InteractionRecord>;
    readInteractionEditor(conversationId: string, interactionId: string): Promise<import("./chat-interaction.js").InteractionEditorState>;
    autoOpenInteractionEditor(conversationId: string, interactionId: string): Promise<unknown>;
    openInteractionEditor(conversationId: string, interactionId: string): Promise<unknown>;
    beginInteractionEdit(conversationId: string, interactionId: string, expectedRevision: number): Promise<import("./chat-interaction.js").InteractionRecord>;
    updateInteractionEditor(conversationId: string, interactionId: string, expectedRevision: number, patch: unknown): Promise<import("./chat-interaction.js").InteractionEditorState>;
    transitionInteractionEditor(conversationId: string, interactionId: string, expectedRevision: number, transitionId: string): Promise<import("./chat-interaction.js").InteractionEditorState>;
    onInteractions(listener: (conversationId: string) => void): () => void;
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
