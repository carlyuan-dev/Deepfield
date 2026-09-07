import { useState, type FormEvent } from "react";
import type { DesktopApi, Project, ProjectScope } from "@deepfield/contracts";

export interface ProjectFormProps {
  api: DesktopApi;
  onCreated(project: Project): void;
}

const SCOPE_LABELS: Record<string, string> = {
  focus: "研究焦点",
  geography: "地理范围",
  timeRange: "时间范围",
  exclusions: "排除项",
  customRequirements: "自定义要求",
};

function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function ProjectForm({ api, onCreated }: ProjectFormProps) {
  const [industry, setIndustry] = useState("");
  const [focus, setFocus] = useState("");
  const [geography, setGeography] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [exclusionsText, setExclusionsText] = useState("");
  const [customText, setCustomText] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmedIndustry = industry.trim();
    if (trimmedIndustry.length === 0) {
      setError("请填写行业");
      return;
    }
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    const scope: ProjectScope = {};
    if (focus.trim().length > 0) {
      scope.focus = focus.trim();
    }
    if (geography.trim().length > 0) {
      scope.geography = geography.trim();
    }
    if (timeRange.trim().length > 0) {
      scope.timeRange = timeRange.trim();
    }
    const exclusions = parseList(exclusionsText);
    if (exclusions.length > 0) {
      scope.exclusions = exclusions;
    }
    const customRequirements = parseList(customText);
    if (customRequirements.length > 0) {
      scope.customRequirements = customRequirements;
    }
    try {
      const project = await api.projects.create({
        industry: trimmedIndustry,
        scope,
        launchSource: "direct-ui",
      });
      onCreated(project);
    } catch {
      setError("创建失败，请重试");
      setSubmitting(false);
    }
  };

  return (
    <form className="project-form" onSubmit={handleSubmit}>
      <h2>创建行业研究条目</h2>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        行业
        <input
          value={industry}
          onChange={(event) => setIndustry(event.target.value)}
          placeholder="例如：人形机器人"
          required
        />
      </label>
      <div className="form-grid">
        <label>
          {SCOPE_LABELS.focus}
          <input value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="可选" />
        </label>
        <label>
          {SCOPE_LABELS.geography}
          <input
            value={geography}
            onChange={(event) => setGeography(event.target.value)}
            placeholder="可选"
          />
        </label>
        <label>
          {SCOPE_LABELS.timeRange}
          <input
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
            placeholder="可选"
          />
        </label>
      </div>
      <label>
        {SCOPE_LABELS.exclusions}
        <textarea
          value={exclusionsText}
          onChange={(event) => setExclusionsText(event.target.value)}
          placeholder="每行或逗号分隔，可选"
          rows={2}
        />
      </label>
      <label>
        {SCOPE_LABELS.customRequirements}
        <textarea
          value={customText}
          onChange={(event) => setCustomText(event.target.value)}
          placeholder="每行或逗号分隔，可选"
          rows={2}
        />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? "创建中…" : "创建研究条目"}
      </button>
    </form>
  );
}
