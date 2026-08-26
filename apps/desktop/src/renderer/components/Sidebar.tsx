import type { Project } from "@deepfield/contracts";

export type SidebarActive = "chat" | "capability" | "settings" | undefined;

export interface SidebarProps {
  projects: Project[];
  projectsError: string | undefined;
  active: SidebarActive;
  onOpenChat(): void;
  onOpenResearch(): void;
  onOpenProject(projectId: string): void;
  onOpenSettings(): void;
}

export function Sidebar({
  projects,
  projectsError,
  active,
  onOpenChat,
  onOpenResearch,
  onOpenProject,
  onOpenSettings,
}: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="brand">Deepfield</div>
      <ul className="nav-primary">
        <li>
          <button className={active === "chat" ? "active" : ""} onClick={onOpenChat}>
            新对话
          </button>
        </li>
        <li>
          <button className={active === "capability" ? "active" : ""} onClick={onOpenResearch}>
            行业研究
          </button>
        </li>
      </ul>
      <div className="nav-section-title">项目</div>
      {projectsError !== undefined && (
        <p className="nav-error" role="alert">
          {projectsError}
        </p>
      )}
      <ul className="nav-projects">
        {projects.map((project) => (
          <li key={project.id}>
            <button onClick={() => onOpenProject(project.id)}>{project.industry}</button>
          </li>
        ))}
        {projects.length === 0 && <li className="muted">暂无项目</li>}
      </ul>
      <div className="nav-section-title">更多</div>
      <ul className="nav-future">
        <li>
          <button disabled title="后续开放">
            公司库
          </button>
        </li>
        <li>
          <button disabled title="后续开放">
            项目资料库
          </button>
        </li>
        <li>
          <button disabled title="后续开放">
            任务中心
          </button>
        </li>
      </ul>
      <div className="nav-footer">
        <button className={active === "settings" ? "active" : ""} onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </nav>
  );
}
