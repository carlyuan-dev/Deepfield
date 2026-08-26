import type { Project, ProjectScope } from "@deepfield/contracts";

export interface ProjectWorkspaceProps {
  project: Project;
  onOpenChat(): void;
}

const SCOPE_LABELS: Record<string, string> = {
  focus: "研究焦点",
  geography: "地理范围",
  timeRange: "时间范围",
  exclusions: "排除项",
  customRequirements: "自定义要求",
};

function scopeEntries(scope: ProjectScope): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(scope)) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        entries.push([key, value.join("、")]);
      }
    } else if (value !== undefined && value.length > 0) {
      entries.push([key, value]);
    }
  }
  return entries;
}

export function ProjectWorkspace({ project, onOpenChat }: ProjectWorkspaceProps) {
  const entries = scopeEntries(project.scope);
  return (
    <div className="project-workspace">
      <h2>{project.industry}</h2>
      <dl className="scope-summary">
        {entries.map(([key, value]) => (
          <div key={key} className="scope-row">
            <dt>{SCOPE_LABELS[key] ?? key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="status">状态：项目已创建</p>
      <p className="notice">研究工作流将在下一阶段接入，尚未执行行业研究。</p>
      <button onClick={onOpenChat}>打开项目 Chat</button>
    </div>
  );
}
