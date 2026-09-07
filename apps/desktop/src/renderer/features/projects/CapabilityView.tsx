import type { DesktopApi, Project } from "@deepfield/contracts";
import { ProjectForm } from "./ProjectForm.js";
import { ProjectWorkspace } from "./ProjectWorkspace.js";

export interface CapabilityViewProps {
  api: DesktopApi;
  projectId: string | undefined;
  project: Project | undefined;
  onCreated(project: Project): void;
  onOpenProjectChat(): void;
}

export function CapabilityView({
  api,
  projectId,
  project,
  onCreated,
  onOpenProjectChat,
}: CapabilityViewProps) {
  return (
    <section className="capability" aria-label="行业研究">
      <header className="capability-header">
        <span className="breadcrumb">能力 / 行业研究</span>
        {projectId !== undefined && <span className="status-chip">研究条目已创建</span>}
      </header>
      <h1 className="capability-title">行业研究</h1>
      {projectId === undefined ? (
        <ProjectForm api={api} onCreated={onCreated} />
      ) : project === undefined ? (
        <p className="muted">加载研究条目…</p>
      ) : (
        <ProjectWorkspace project={project} onExpandChat={onOpenProjectChat} />
      )}
    </section>
  );
}
