import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopApi } from "@deepfield/contracts";
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
import { SettingsView } from "./features/settings/SettingsView.js";

export interface AppProps {
  api: DesktopApi;
  requestIdFactory?: () => string;
  loadCapabilityModule?: CapabilityModuleLoader;
  initialWorkspace?: WorkspaceState;
}
type SettingsModule = "llm" | "search";

export function App({ api, requestIdFactory = createRequestId, loadCapabilityModule, initialWorkspace = initialWorkspaceState }: AppProps) {
  const { snapshot } = useCapabilities(api.capabilityManagement);
  const conversations = useConversations(api);
  const [workspace, dispatchWorkspace] = useReducer(workspaceReducer, initialWorkspace);
  const restored = useRef(false);
  const ready = snapshot?.packages.filter(item => item.status === "ready" && item.navigation && item.uiEntry).sort((a, b) => a.navigation!.order - b.navigation!.order || a.id.localeCompare(b.id)) ?? [];
  const selected = ready.find(item => item.id === workspace.activeCapability);
  useEffect(() => {
    if (!snapshot) return;
    if (!restored.current) {
      restored.current = true;
      const next = restoreWorkspace(workspace, ready.map(item => item.id));
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
          setSettingsOpen(false);
          void conversations.newConversation();
          openConversation();
        }}
        onOpenConversation={(conversationId) => {
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
          setSettingsOpen(false);
          dispatchWorkspace({ type: "OPEN_CAPABILITY_DIRECT", capabilityId });
        }}
        onOpenSettings={() => { setSettingsModule("llm"); setSettingsOpen(true); }}
      />
      <main className="workspace">
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
              />
            ) : null}
          </section>
          {selected && (
            <aside className="capability-pane" aria-label="Capability">
              <CapabilityHost
                key={selected.id}
                capabilityId={selected.id}
                uiEntry={selected.uiEntry!}
                {...(loadCapabilityModule ? { loadModule: loadCapabilityModule } : {})}
                bridge={api.capabilities}
                active={!settingsOpen}
                onClose={() => dispatchWorkspace({ type: "CLOSE_CAPABILITY" })}
                onOpenSettings={(module) => { setSettingsModule(module); setSettingsOpen(true); }}
              />
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
