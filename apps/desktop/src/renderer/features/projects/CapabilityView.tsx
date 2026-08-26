import type { DesktopApi, Project } from "@deepfield/contracts";
import type { CapabilitySource } from "../../state/workspace.js";
import { ProjectForm } from "./ProjectForm.js";
import { ProjectWorkspace } from "./ProjectWorkspace.js";

export interface CapabilityViewProps {
  api: DesktopApi;
  source: CapabilitySource;
  projectId: string | undefined;
  project: Project | undefined;
  onCreated(project: Project): void;
  onOpenProjectChat(projectId: string): void;
}

export function CapabilityView({
  api,
  source,
  projectId,
  project,
  onCreated,
  onOpenProjectChat,
}: CapabilityViewProps) {
  const launchSource = source === "chat" ? "chat" : "direct-ui";
  return (
    <section className="capability" aria-label="行业研究">
      <header className="capability-header">
        <span className="breadcrumb">能力 / 行业研究</span>
        {projectId !== undefined && <span className="status-chip">项目已创建</span>}
      </header>
      <h1 className="capability-title">行业研究</h1>
      {projectId === undefined ? (
        <ProjectForm api={api} launchSource={launchSource} onCreated={onCreated} />
      ) : project === undefined ? (
        <p className="muted">加载项目…</p>
      ) : (
        <ProjectWorkspace
          project={project}
          onOpenChat={() => onOpenProjectChat(project.id)}
        />
      )}
    </section>
  );
}
