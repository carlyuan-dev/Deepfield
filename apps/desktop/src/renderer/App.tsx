import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { DesktopApi, Project } from "@deepfield/contracts";
import { createChatEventHub } from "./state/chat-event-hub.js";
import { createRequestId } from "./request-id.js";
import {
  initialWorkspaceState,
  workspaceReducer,
  type ChatPaneState,
} from "./state/workspace.js";
import { useConversations } from "./state/use-conversations.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { CapabilityView } from "./features/projects/CapabilityView.js";
import { SettingsView } from "./features/settings/SettingsView.js";

export interface AppProps {
  api: DesktopApi;
  requestIdFactory?: () => string;
}

export function App({ api, requestIdFactory = createRequestId }: AppProps) {
  const conversations = useConversations(api);
  const [workspace, dispatchWorkspace] = useReducer(workspaceReducer, initialWorkspaceState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"checking" | "connected" | "disconnected">(
    "checking",
  );
  const [researchItem, setResearchItem] = useState<Project | undefined>(undefined);
  const eventHub = useMemo(() => createChatEventHub(), []);

  const checkConnection = useCallback((): void => {
    setConnectionStatus("checking");
    void api.llm.checkConnection().then(
      (status) => setConnectionStatus(status),
      () => setConnectionStatus("disconnected"),
    );
  }, [api]);

  useEffect(() => {
    checkConnection();
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
          void conversations.newConversation();
          openConversation();
        }}
        onOpenConversation={(conversationId) => {
          conversations.open(conversationId);
          openConversation();
        }}
        onOpenResearch={() =>
          dispatchWorkspace({ type: "OPEN_CAPABILITY_DIRECT", capabilityId: "industry-research" })
        }
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="workspace">
        {settingsOpen ? (
          <SettingsView
            api={api}
            onBack={() => setSettingsOpen(false)}
            onKeySaved={checkConnection}
          />
        ) : (
          <div className={`workspace-panes ${capabilityOpen ? "with-capability" : "chat-only"} ${chatPane}`}>
            <section
              className={`chat-pane ${chatPane}`}
              aria-label="Chat"
            >
              {capabilityOpen && (
                <button
                  className="chat-pane-toggle"
                  aria-label={chatPane === "expanded" ? "收起 Chat" : "展开 Chat"}
                  onClick={toggleChatPane}
                >
                  {chatPane === "expanded" ? "‹" : "›"}
                </button>
              )}
              {conversations.loading ? (
                <p className="muted pane-message">加载对话…</p>
              ) : conversations.error !== undefined ? (
                <div className="error pane-message" role="alert">
                  {conversations.error}
                  <button onClick={conversations.retry}>重新加载</button>
                </div>
              ) : conversations.activeConversation !== undefined ? (
                <ChatView
                  key={conversations.activeConversation.id}
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
                <div className="capability-pane-toolbar">
                  <button
                    className="capability-close"
                    aria-label="关闭 Capability"
                    onClick={() => dispatchWorkspace({ type: "CLOSE_CAPABILITY" })}
                  >
                    ×
                  </button>
                </div>
                <CapabilityView
                  api={api}
                  projectId={researchItem?.id}
                  project={researchItem}
                  onCreated={(project) => {
                    setResearchItem(project);
                  }}
                  onOpenProjectChat={() => openConversation()}
                />
              </aside>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
