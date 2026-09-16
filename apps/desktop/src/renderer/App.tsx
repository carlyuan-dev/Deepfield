import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopApi } from "@deepfield/contracts";
import { createChatEventHub } from "./state/chat-event-hub.js";
import { createRequestId } from "./request-id.js";
import {
  initialWorkspaceState,
  workspaceReducer,
  type ChatPaneState,
} from "./state/workspace.js";
import { useConversations } from "./state/use-conversations.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatPaneHeader } from "./components/ChatPaneHeader.js";
import { ChatView } from "./components/ChatView.js";
import { IndustryResearchCapability } from "./features/industry-research/IndustryResearchCapability.js";
import { SettingsView } from "./features/settings/SettingsView.js";

export interface AppProps {
  api: DesktopApi;
  requestIdFactory?: () => string;
}
type SettingsModule = "llm" | "search";

export function App({ api, requestIdFactory = createRequestId }: AppProps) {
  const conversations = useConversations(api);
  const [workspace, dispatchWorkspace] = useReducer(workspaceReducer, initialWorkspaceState);
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
  const capabilityOpen = workspace.activeCapability !== undefined;

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
        onOpenResearch={() => {
          setSettingsOpen(false);
          dispatchWorkspace({ type: "OPEN_CAPABILITY_DIRECT", capabilityId: "industry-research" });
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
              />
            ) : null}
          </section>
          {capabilityOpen && (
            <aside className="capability-pane" aria-label="Capability">
              <IndustryResearchCapability
                api={api}
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
