import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { DesktopApi, Project } from "@deepfield/contracts";
import { initialWorkspaceState, workspaceReducer } from "./state/workspace.js";
import { createChatEventHub } from "./state/chat-event-hub.js";
import { createRequestId } from "./request-id.js";
import { Sidebar, type SidebarActive } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { ChatRail } from "./components/ChatRail.js";
import { CapabilityView } from "./features/projects/CapabilityView.js";
import { SettingsView } from "./features/settings/SettingsView.js";

export interface AppProps {
  api: DesktopApi;
  requestIdFactory?: () => string;
}

export function App({ api, requestIdFactory = createRequestId }: AppProps) {
  const [workspace, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const eventHub = useMemo(() => createChatEventHub(), []);

  useEffect(() => {
    const unsubscribe = api.chat.subscribe((event) => eventHub.emit(event));
    return () => {
      unsubscribe();
      eventHub.dispose();
    };
  }, [api, eventHub]);

  const refreshProjects = useCallback((): void => {
    void api.projects.list().then(
      (list) => setProjects(list),
      () => setProjectsError("加载项目列表失败"),
    );
  }, [api]);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const activeCapability = workspace.capability[workspace.activeCapability];
  const showRail = workspace.view === "capability" && activeCapability.chatRail !== "hidden";
  const chatProjectId = workspace.view === "chat" ? workspace.chat.projectId : undefined;
  const capabilityProject = activeCapability.projectId
    ? projects.find((project) => project.id === activeCapability.projectId)
    : undefined;
  const chatProjectLabel = chatProjectId
    ? projects.find((project) => project.id === chatProjectId)?.industry
    : undefined;

  const active: SidebarActive = settingsOpen
    ? "settings"
    : workspace.view === "capability"
      ? "capability"
      : "chat";

  return (
    <div className="shell">
      <Sidebar
        projects={projects}
        projectsError={projectsError}
        active={active}
        onOpenChat={() => {
          setSettingsOpen(false);
          dispatch({ type: "OPEN_CHAT" });
        }}
        onOpenResearch={() => {
          setSettingsOpen(false);
          dispatch({ type: "OPEN_CAPABILITY_DIRECT", projectId: undefined });
        }}
        onOpenProject={(projectId) => {
          setSettingsOpen(false);
          dispatch({ type: "OPEN_CAPABILITY_DIRECT", projectId });
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="workspace">
        {settingsOpen ? (
          <SettingsView api={api} onBack={() => setSettingsOpen(false)} />
        ) : workspace.view === "chat" ? (
          <ChatView
            api={api}
            eventHub={eventHub}
            requestIdFactory={requestIdFactory}
            projectId={chatProjectId}
            projectLabel={chatProjectLabel}
            onOpenResearch={() =>
              dispatch({
                type: "OPEN_CAPABILITY_FROM_CHAT",
                projectId: chatProjectId,
              })
            }
            onNeedProject={() =>
              dispatch({ type: "OPEN_CAPABILITY_DIRECT", projectId: undefined })
            }
          />
        ) : (
          <CapabilityView
            api={api}
            source={workspace.activeCapability}
            projectId={activeCapability.projectId}
            project={capabilityProject}
            onCreated={(project) => {
              dispatch({
                type: "PROJECT_CREATED",
                projectId: project.id,
                fromChat: workspace.activeCapability === "chat",
              });
              setProjects((previous) => [project, ...previous]);
            }}
            onOpenProjectChat={(projectId) => dispatch({ type: "OPEN_PROJECT_CHAT", projectId })}
          />
        )}
      </main>
      {showRail && (
        <ChatRail
          api={api}
          eventHub={eventHub}
          requestIdFactory={requestIdFactory}
          projectId={activeCapability.projectId}
          collapsed={activeCapability.chatRail === "collapsed"}
          onCollapse={() => dispatch({ type: "COLLAPSE_CHAT" })}
          onExpand={() => dispatch({ type: "EXPAND_CHAT" })}
        />
      )}
    </div>
  );
}
