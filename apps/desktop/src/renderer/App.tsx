import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { DesktopApi, InteractionRecord } from "@deepfield/contracts";
import type { CapabilityInteractionEditor } from "@deepfield/capability-sdk";
import { createChatEventHub } from "./state/chat-event-hub.js";
import { createRequestId } from "./request-id.js";
import {
  initialWorkspaceState,
  workspaceReducer,
  type ChatPaneState,
  type WorkspaceState,
  restoreWorkspace,
} from "./state/workspace.js";
import { useConversations } from "./state/use-conversations.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatPaneHeader } from "./components/ChatPaneHeader.js";
import { ChatView } from "./components/ChatView.js";
import { CapabilityHost, type CapabilityModuleLoader } from "./capabilities/CapabilityHost.js";
import { useCapabilities } from "./capabilities/use-capabilities.js";
import { createCapabilityInteractionState } from "./capabilities/ui-runtime.js";
import { createBoundInteractionEditor } from "./capabilities/bound-interaction-editor.js";
import { SettingsView } from "./features/settings/SettingsView.js";

export interface AppProps {
  api: DesktopApi;
  requestIdFactory?: () => string;
  loadCapabilityModule?: CapabilityModuleLoader;
  initialWorkspace?: WorkspaceState;
}
type SettingsModule = "llm" | "search";
function interactionDraftKey(item: InteractionRecord): string | undefined {
  if (item.payload.kind !== "approval" || !item.payload.operation.draftRef) return undefined;
  try { const ref: unknown = JSON.parse(item.payload.operation.draftRef);
    return ref && typeof ref === "object" && "capabilityId" in ref && typeof ref.capabilityId === "string"
      && "draftId" in ref && typeof ref.draftId === "string" ? `${ref.capabilityId}:${ref.draftId}` : undefined;
  } catch { return undefined; }
}

export function App({ api, requestIdFactory = createRequestId, loadCapabilityModule, initialWorkspace = initialWorkspaceState }: AppProps) {
  const { snapshot } = useCapabilities(api.capabilityManagement);
  const conversations = useConversations(api);
  const [workspace, dispatchWorkspace] = useReducer(workspaceReducer, initialWorkspace);
  const restored = useRef(false);
  const manualNavigationGeneration = useRef(0);
  const requestNavigationGeneration = useRef(new Map<string, number>());
  const noteManualNavigation = useCallback(() => {
    manualNavigationGeneration.current += 1;
    void api.capabilityNavigation?.noteManualNavigation?.();
  }, [api.capabilityNavigation]);
  const rememberRequestGeneration = useCallback((requestId: string) => {
    const values = requestNavigationGeneration.current;
    if (!values.has(requestId)) values.set(requestId, manualNavigationGeneration.current);
    if (values.size > 100) values.delete(values.keys().next().value!);
  }, []);
  const ready = snapshot?.packages.filter(item => item.status === "ready" && item.navigation && item.uiEntry).sort((a, b) => a.navigation!.order - b.navigation!.order || a.id.localeCompare(b.id)) ?? [];
  const readyUi = snapshot?.packages.filter(item => item.status === "ready" && item.uiEntry) ?? [];
  const selected = readyUi.find(item => item.id === workspace.activeCapability);
  const interaction = useMemo(createCapabilityInteractionState, []);
  const [blockedNavigation, setBlockedNavigation] = useState<string>();
  const [editorBinding, setEditorBinding] = useState<{ conversationId: string; interactionId: string; capabilityId: string }>();
  const [editorContinuation, setEditorContinuation] = useState<{ conversationId: string; interactionId: string; capabilityId: string; draftId: string }>();
  const editorOpenSequence = useRef(0);
  useEffect(() => {
    if (editorContinuation && snapshot && !readyUi.some(item => item.id === editorContinuation.capabilityId)) {
      setEditorBinding(undefined);
      setEditorContinuation(undefined);
    }
  }, [snapshot, readyUi, editorContinuation]);
  useEffect(() => {
    if (!editorContinuation || !api.chat.onInteractions || !api.chat.listInteractions) return;
    let active = true;
    const { conversationId, interactionId, capabilityId, draftId } = editorContinuation;
    const refresh = () => { void api.chat.listInteractions!(conversationId).then(items => {
      if (!active) return;
      const current = items.find(item => item.id === interactionId);
      if (!current) {
        setEditorContinuation(value => value?.interactionId === interactionId ? undefined : value);
        setEditorBinding(binding => binding?.conversationId === conversationId && binding.interactionId === interactionId ? undefined : binding);
        return;
      }
      if (current?.status === "cancelled" || current?.status === "invalidated" || current?.status === "failed" || current?.status === "uncertain") {
        setEditorContinuation(value => value?.interactionId === interactionId ? undefined : value);
        setEditorBinding(binding => binding?.conversationId === conversationId && binding.interactionId === interactionId ? undefined : binding);
        return;
      }
      if (current.status !== "waiting" && current.status !== "editing" && current.status !== "executing") {
        const next = items.find(item => item.id !== interactionId && item.status === "waiting" && interactionDraftKey(item) === `${capabilityId}:${draftId}`);
        if (next && workspace.activeCapability === capabilityId) {
          setEditorContinuation({ conversationId, interactionId: next.id, capabilityId, draftId });
          setEditorBinding({ conversationId, interactionId: next.id, capabilityId });
        } else {
          setEditorBinding(binding => binding?.conversationId === conversationId && binding.interactionId === interactionId ? undefined : binding);
        }
      }
    }).catch(() => {}); };
    const unsubscribe = api.chat.onInteractions(id => { if (id === conversationId) refresh(); });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [api.chat, editorContinuation, workspace.activeCapability]);
  const boundEditor = useMemo<CapabilityInteractionEditor | undefined>(() => {
    if (!editorBinding) return undefined;
    const { conversationId, interactionId } = editorBinding;
    return createBoundInteractionEditor(api.chat, { conversationId, interactionId }, decision => {
        if (decision === "cancel") setEditorContinuation(value => value?.interactionId === interactionId ? undefined : value);
        setEditorBinding(binding => binding?.conversationId === conversationId && binding.interactionId === interactionId ? undefined : binding);
    });
  }, [api.chat, editorBinding]);
  const openInteractionEditor = useCallback(async (item: InteractionRecord, expectedGeneration?: number) => {
    const sequence = ++editorOpenSequence.current;
    const ownerId = item.conversationId;
    if (expectedGeneration !== undefined && (manualNavigationGeneration.current !== expectedGeneration || conversations.activeConversation?.id !== ownerId)) return;
    if (item.payload.kind === "approval" && !item.payload.operation.draftRef) {
      if (expectedGeneration !== undefined) await api.chat.autoOpenInteractionEditor(ownerId, item.id);
      return;
    }
    const value = await api.chat.readInteractionEditor?.(ownerId, item.id);
    if (!value || value.interaction.id !== item.id || value.interaction.conversationId !== ownerId) throw new Error("editor_binding_mismatch");
    if (expectedGeneration !== undefined && (manualNavigationGeneration.current !== expectedGeneration || conversations.activeConversation?.id !== ownerId)) return;
    const capabilityId = value.form.draft.capabilityId;
    const result = expectedGeneration === undefined
      ? await api.chat.openInteractionEditor(ownerId, item.id) as { status?: string; message?: string }
      : await api.chat.autoOpenInteractionEditor(ownerId, item.id) as { status?: string; message?: string };
    if (result?.status !== "opened") {
      throw new Error(result?.message ?? "editor_navigation_failed");
    }
    if (sequence !== editorOpenSequence.current || (expectedGeneration !== undefined && manualNavigationGeneration.current !== expectedGeneration)) return;
    setEditorBinding({ conversationId: ownerId, interactionId: item.id, capabilityId });
    setEditorContinuation({ conversationId: ownerId, interactionId: item.id, capabilityId, draftId: value.form.draft.draftId });
  }, [api, conversations.activeConversation?.id]);
  const onNewInteraction = useCallback((item: InteractionRecord) => {
    const generation = requestNavigationGeneration.current.get(item.requestId);
    if (generation === undefined || generation !== manualNavigationGeneration.current || conversations.activeConversation?.id !== item.conversationId) return;
    void openInteractionEditor(item, generation).catch(() => {});
  }, [openInteractionEditor, conversations.activeConversation?.id]);
  const navigationContext = useRef({ selected, ready: readyUi, editorBinding });
  navigationContext.current = { selected, ready: readyUi, editorBinding };
  useEffect(() => {
    const bridge = api.capabilityNavigation;
    if (!bridge) return;
    const cancelled = new Set<string>();
    let subscribed = true;
    const unsubscribe = bridge.subscribe(event => {
      if (event.kind === "cancel") { cancelled.add(event.requestId); interaction.cancel(event.requestId); return; }
      const previous = navigationContext.current.selected?.id;
      void (async () => {
        // A result may reach navigation before React processes the terminal interaction event.
        // Release only that completed editor; a still-pending human form keeps its dirty guard.
        const binding = navigationContext.current.editorBinding;
        if (binding) {
          const items = await api.chat.listInteractions(binding.conversationId).catch(() => []);
          if (!subscribed || cancelled.delete(event.requestId) || Date.now() >= event.expiresAt) return;
          const item = items.find(item => item.id === binding.interactionId);
          if (item && !["waiting", "editing", "executing"].includes(item.status)) {
            flushSync(() => setEditorBinding(current => current?.interactionId === binding.interactionId ? undefined : current));
          }
        }
        const available = navigationContext.current.ready.some(item => item.id === event.target.capabilityId);
        const result = available ? await interaction.open(event, id => {
          setSettingsOpen(false);
          dispatchWorkspace({ type: "OPEN_CAPABILITY_FROM_CHAT", capabilityId: id });
          return () => dispatchWorkspace(previous ? { type: "OPEN_CAPABILITY_FROM_CHAT", capabilityId: previous } : { type: "CLOSE_CAPABILITY" });
        }) : { status: "not_found" as const, message: "ui_unavailable" };
        if (result.status === "opened") setSettingsOpen(false);
        const accepted = await bridge.ack(event.requestId, event.target.capabilityId, result).catch(() => false);
        if (accepted && result.status === "blocked" && result.message === "unsaved_input") setBlockedNavigation(event.requestId);
      })();
    });
    return () => { subscribed = false; interaction.cancel(undefined, false); unsubscribe(); };
  }, [api.capabilityNavigation, api.chat, interaction]);
  useEffect(() => {
    if (!snapshot) return;
    if (!restored.current) {
      restored.current = true;
      const next = restoreWorkspace(workspace, readyUi.map(item => item.id));
      if (next.activeCapability !== workspace.activeCapability) {
        dispatchWorkspace(next.activeCapability ? { type: workspace.chatPane === "collapsed" ? "OPEN_CAPABILITY_DIRECT" : "OPEN_CAPABILITY_FROM_CHAT", capabilityId: next.activeCapability } : { type: "CLOSE_CAPABILITY" });
      }
    } else if (workspace.activeCapability && !selected) dispatchWorkspace({ type: "CLOSE_CAPABILITY" });
  }, [snapshot, workspace, selected]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsModule, setSettingsModule] = useState<SettingsModule>("llm");
  const [generationDeleteError, setGenerationDeleteError] = useState<string | undefined>(undefined);
  const [connectionStatus, setConnectionStatus] = useState<"checking" | "connected" | "disconnected">(
    "checking",
  );
  const connectionCheckSequence = useRef(0);
  const eventHub = useMemo(() => createChatEventHub(), []);
  useEffect(() => eventHub.subscribe(({ event }) => {
    if (event.type === "started") rememberRequestGeneration(event.requestId);
  }), [eventHub, rememberRequestGeneration]);

  const checkConnection = useCallback((): void => {
    const sequence = ++connectionCheckSequence.current;
    setConnectionStatus("checking");
    void api.settings.get().then(
      (settings) => {
        const active = settings.llm.profiles.find((profile) => profile.id === settings.llm.activeProfileId);
        if (sequence === connectionCheckSequence.current) setConnectionStatus(active?.hasCredential ? "connected" : "disconnected");
      },
      () => {
        if (sequence === connectionCheckSequence.current) setConnectionStatus("disconnected");
      },
    );
  }, [api]);

  useEffect(() => {
    checkConnection();
    const interval = window.setInterval(checkConnection, 30_000);
    window.addEventListener("focus", checkConnection);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkConnection);
    };
  }, [checkConnection]);

  useEffect(() => {
    const unsubscribe = api.chat.subscribe((event) => eventHub.emit(event));
    return () => {
      unsubscribe();
      eventHub.dispose();
    };
  }, [api, eventHub]);

  const chatPane: ChatPaneState = workspace.chatPane;
  const capabilityOpen = selected !== undefined;

  const toggleChatPane = (): void => {
    dispatchWorkspace({ type: chatPane === "expanded" ? "COLLAPSE_CHAT" : "EXPAND_CHAT" });
  };
  const openConversation = (): void => {
    dispatchWorkspace({ type: "OPEN_CONVERSATION" });
  };

  const active: "chat" | "capability" | "settings" =
    settingsOpen
      ? "settings"
      : workspace.activeCapability !== undefined && chatPane === "collapsed"
        ? "capability"
        : "chat";

  return (
    <div className="shell">
      <Sidebar
        conversations={conversations.conversations}
        activeConversationId={conversations.activeConversation?.id}
        connectionStatus={connectionStatus}
        active={active}
        onNewConversation={() => {
          noteManualNavigation();
          setSettingsOpen(false);
          void conversations.newConversation();
          openConversation();
        }}
        onOpenConversation={(conversationId) => {
          noteManualNavigation();
          setSettingsOpen(false);
          conversations.open(conversationId);
          openConversation();
        }}
        deletionError={generationDeleteError ?? conversations.deletionError}
        onDeleteConversation={(conversationId) => {
          if (eventHub.isConversationActive(conversationId)) {
            setGenerationDeleteError("对话生成中，请等待完成后再删除");
            return;
          }
          setGenerationDeleteError(undefined);
          if (window.confirm("确定删除这个对话吗？此操作无法撤销。")) {
            void conversations.deleteConversation(conversationId);
          }
        }}
        capabilities={ready.map(item => ({ id: item.id, title: item.navigation!.title }))}
        activeCapability={selected?.id}
        onOpenCapability={(capabilityId) => {
          noteManualNavigation();
          interaction.cancel(undefined, false);
          setEditorBinding(undefined);
          setEditorContinuation(undefined);
          setSettingsOpen(false);
          dispatchWorkspace({ type: "OPEN_CAPABILITY_DIRECT", capabilityId });
        }}
        onOpenSettings={() => { noteManualNavigation(); setSettingsModule("llm"); setSettingsOpen(true); }}
      />
      <main className="workspace">
        {blockedNavigation && <div role="status">当前页面有未保存输入。<button onClick={() => {
          const id = blockedNavigation; setBlockedNavigation(undefined);
          void api.capabilityNavigation?.retry(id).catch(() => {});
        }}>打开</button></div>}
        {settingsOpen && (
          <SettingsView
            api={api}
            onKeySaved={checkConnection}
            onBack={() => setSettingsOpen(false)}
            initialModule={settingsModule}
          />
        )}
        <div hidden={settingsOpen} className={`workspace-panes ${capabilityOpen ? "with-capability" : "chat-only"} ${chatPane}`}>
          <section
            className={`chat-pane ${chatPane}`}
            aria-label="Chat"
          >
            <ChatPaneHeader
              title={conversations.activeConversation?.title ?? "Chat"}
              paneState={chatPane}
              capabilityOpen={capabilityOpen}
              onToggle={toggleChatPane}
            />
            {conversations.loading ? (
              <p className="muted pane-message">加载对话…</p>
            ) : conversations.error !== undefined ? (
              <div className="error pane-message" role="alert">
                {conversations.error}
                <button onClick={conversations.retry}>重新加载</button>
              </div>
            ) : conversations.activeConversation !== undefined ? (
              <ChatView
                api={api}
                eventHub={eventHub}
                requestIdFactory={requestIdFactory}
                conversation={conversations.activeConversation}
                acceptUpdated={conversations.acceptUpdated}
                setWebSearchEnabled={conversations.setWebSearchEnabled}
                savingWebSearch={conversations.savingWebSearch}
                settingError={conversations.settingError}
                openInteractionEditor={openInteractionEditor}
                onNewInteraction={onNewInteraction}
                onRequestStart={rememberRequestGeneration}
              />
            ) : null}
          </section>
          {selected && (
            <aside className="capability-pane" aria-label="Capability"
              onClickCapture={event => {
                if (event.nativeEvent.isTrusted && !(event.target as Element).closest('[role="dialog"]') && (event.target as Element).closest("button,a,[role=button],[role=link]"))
                  noteManualNavigation();
              }}
              onKeyDownCapture={event => {
                if (event.nativeEvent.isTrusted && (event.key === "Enter" || event.key === " ")
                  && !(event.target as Element).closest('[role="dialog"]')
                  && (event.target as Element).closest("button,a,[role=button],[role=link]"))
                  noteManualNavigation();
              }}>
              <CapabilityHost
                key={selected.id}
                capabilityId={selected.id}
                uiEntry={selected.uiEntry!}
                {...(loadCapabilityModule ? { loadModule: loadCapabilityModule } : {})}
                bridge={api.capabilities}
                interaction={interaction}
                {...(editorBinding?.capabilityId === selected.id && boundEditor ? { interactionEditor: boundEditor } : {})}
                active={!settingsOpen}
                onClose={() => { noteManualNavigation(); interaction.cancel(undefined, false); setEditorBinding(undefined); setEditorContinuation(undefined); dispatchWorkspace({ type: "CLOSE_CAPABILITY" }); }}
                onOpenSettings={(module) => { noteManualNavigation(); setSettingsModule(module); setSettingsOpen(true); }}
              />
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
