import { useEffect, useMemo, useState } from "react";
import type { DesktopApi, Project } from "@deepfield/contracts";
import { createChatEventHub } from "./state/chat-event-hub.js";
import { createRequestId } from "./request-id.js";
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
  const [view, setView] = useState<"chat" | "capability">("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [researchProject, setResearchProject] = useState<Project | undefined>(undefined);
  const eventHub = useMemo(() => createChatEventHub(), []);

  useEffect(() => {
    const unsubscribe = api.chat.subscribe((event) => eventHub.emit(event));
    return () => {
      unsubscribe();
      eventHub.dispose();
    };
  }, [api, eventHub]);

  const openChat = (): void => {
    setSettingsOpen(false);
    setView("chat");
  };
  const openResearch = (): void => {
    setSettingsOpen(false);
    setView("capability");
  };
  const openSettings = (): void => {
    setSettingsOpen(true);
  };

  const active: "chat" | "capability" | "settings" =
    settingsOpen ? "settings" : view === "capability" ? "capability" : "chat";

  return (
    <div className="shell">
      <Sidebar
        conversations={conversations.conversations}
        active={active}
        onNewConversation={() => {
          void conversations.newConversation();
          openChat();
        }}
        onOpenConversation={(conversationId) => {
          conversations.open(conversationId);
          openChat();
        }}
        onOpenResearch={openResearch}
        onOpenSettings={openSettings}
      />
      <main className="workspace">
        {settingsOpen ? (
          <SettingsView api={api} onBack={() => setSettingsOpen(false)} />
        ) : view === "capability" ? (
          <CapabilityView
            api={api}
            source="directUi"
            projectId={researchProject?.id}
            project={researchProject}
            onCreated={(project) => {
              setResearchProject(project);
            }}
            onOpenProjectChat={() => openChat()}
          />
        ) : conversations.loading ? (
          <p className="muted">加载对话…</p>
        ) : conversations.error !== undefined ? (
          <div className="error" role="alert">
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
      </main>
    </div>
  );
}
