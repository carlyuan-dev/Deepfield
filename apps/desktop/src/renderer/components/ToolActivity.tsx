import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolActivityView } from "../state/chat.js";
import { UrlPopoverLink, isSafeHttpUrl } from "./UrlPopoverLink.js";

const TOOL_LABELS: Readonly<Record<string, string>> = {
  web_search: "联网搜索",
  read_webpage: "读取网页",
  get_current_datetime: "获取日期时间",
  calculator: "计算器",
  convert_timezone: "转换时区",
  list_conversations: "列出对话",
  read_conversation: "读取对话",
  search_conversations: "搜索对话",
  fetch_url: "读取网页",
  fetch_pdf: "下载 PDF",
  parse_html: "解析网页",
  parse_pdf: "解析 PDF",
  check_link_accessibility: "检查链接",
  echo_probe: "本地测试",
};

const STATUS_LABELS: Readonly<Record<ToolActivityView["status"], string>> = {
  running: "调用中",
  completed: "已完成",
  failed: "调用失败",
  skipped: "已跳过",
  reused: "已复用",
};

interface ActivityBatch {
  key: string;
  agentTurnIndex: number;
  activities: ToolActivityView[];
}

function labelFor(name: string): string {
  const known = TOOL_LABELS[name];
  if (known !== undefined) return known;
  const clipped = name.length > 32 ? `${name.slice(0, 31)}…` : name;
  return clipped === "unknown_tool" ? "其他工具" : clipped;
}

function batchActivities(activities: ToolActivityView[]): {
  batches: ActivityBatch[];
  unbatched: ToolActivityView[];
} {
  const batches = new Map<string, ActivityBatch>();
  const unbatched: ToolActivityView[] = [];
  for (const activity of activities) {
    if (activity.agentTurnIndex === undefined || activity.batchId === undefined) {
      unbatched.push(activity);
      continue;
    }
    const key = `${activity.agentTurnIndex}:${activity.batchId}`;
    const batch = batches.get(key);
    if (batch !== undefined) {
      batch.activities.push(activity);
    } else {
      batches.set(key, {
        key,
        agentTurnIndex: activity.agentTurnIndex,
        activities: [activity],
      });
    }
  }
  return { batches: [...batches.values()], unbatched };
}

function trimSummary(activities: ToolActivityView[]): string | undefined {
  const trimmed = activities.filter(
    (activity) => activity.status === "skipped" && activity.errorCode === "budget_trimmed",
  );
  if (trimmed.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const activity of trimmed) {
    const label = activity.name === "web_search" ? "搜索" : labelFor(activity.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return `${[...counts].map(([label, count]) => `${count} 个${label}`).join("、")}因本轮额度跳过`;
}

function failureSummary(activities: ToolActivityView[]): string | undefined {
  const failures = activities.filter(
    (activity) => activity.status === "failed" && activity.budgetConsumed !== false,
  );
  if (failures.length === 0) return undefined;
  const reasons = [...new Set(failures.map((activity) => activity.errorCode).filter(Boolean))];
  return reasons.length === 0
    ? `${failures.length} 个调用失败`
    : `${failures.length} 个调用失败：${reasons.join("、")}`;
}

function statusFor(activity: ToolActivityView): { className: string; label: string } {
  if (activity.status === "failed" && activity.budgetConsumed === false) {
    return { className: "not-executed", label: "未执行" };
  }
  return { className: activity.status, label: STATUS_LABELS[activity.status] };
}

function ActivityRows({ activities }: { activities: ToolActivityView[] }) {
  return (
    <ol className="tool-activity-list">
      {activities.map((activity) => {
        const status = statusFor(activity);
        const showErrorCode = activity.errorCode !== undefined && activity.errorCode !== "budget_trimmed";
        return (
          <li key={activity.callKey} className="tool-activity-row">
            <span className="tool-activity-name">{labelFor(activity.name)}</span>
            <span className="tool-activity-meta">
              <span className={`tool-activity-status ${status.className}`}>{status.label}</span>
              {activity.durationMs !== undefined && (
                <span className="tool-activity-duration">{activity.durationMs}ms</span>
              )}
              {showErrorCode && <span className="tool-activity-error">{activity.errorCode}</span>}
              {activity.resultCount !== undefined && <span className="tool-activity-result-count">{activity.resultCount} 条结果</span>}
            </span>
            {(activity.queryOrUrl ?? activity.summary) !== undefined && (
              <span className="tool-activity-summary">{activity.queryOrUrl ?? activity.summary}</span>
            )}
            {(activity.sources?.length ?? 0) > 0 && (
              <ul className="tool-activity-sources">
                {activity.sources?.filter(source => isSafeHttpUrl(source.url)).map((source, index) => (
                  <li key={`${source.url}-${index}`}><UrlPopoverLink href={source.url}>{source.title || source.url}</UrlPopoverLink></li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface ToolActivityProps {
  activities: ToolActivityView[];
  terminal: boolean;
}

export function ToolActivity({ activities, terminal }: ToolActivityProps) {
  const { batches, unbatched } = useMemo(() => batchActivities(activities), [activities]);
  const runningBatchKeys = useMemo(
    () =>
      batches
        .filter((batch) => batch.activities.some((activity) => activity.status === "running"))
        .map((batch) => batch.key),
    [batches],
  );
  const [expanded, setExpanded] = useState(
    () => !terminal && activities.some((activity) => activity.status === "running"),
  );
  const [expandedBatchKeys, setExpandedBatchKeys] = useState<ReadonlySet<string>>(
    () => new Set(runningBatchKeys),
  );
  const previousCount = useRef(activities.length);
  const wasTerminal = useRef(terminal);

  useEffect(() => {
    if (
      !terminal &&
      activities.length > previousCount.current &&
      activities.some((activity) => activity.status === "running")
    ) {
      setExpanded(true);
      setExpandedBatchKeys((current) => new Set([...current, ...runningBatchKeys]));
    }
    previousCount.current = activities.length;
  }, [activities, runningBatchKeys, terminal]);

  useEffect(() => {
    if (terminal && !wasTerminal.current) {
      setExpanded(false);
      setExpandedBatchKeys(new Set());
    }
    wasTerminal.current = terminal;
  }, [terminal]);

  if (activities.length === 0) return null;
  const title = `${terminal ? "已调用" : "正在调用"} ${activities.length} 个工具`;
  const collapsedSummaries = [trimSummary(activities), failureSummary(activities)].filter(
    (summary): summary is string => summary !== undefined,
  );

  return (
    <section className="tool-activity" aria-label="工具调用">
      <button
        type="button"
        className="tool-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true" className="tool-activity-arrow">
          {expanded ? "↑" : "↓"}
        </span>
        <span>{title}</span>
        {!expanded && collapsedSummaries.length > 0 && (
          <span aria-hidden="true" className="tool-activity-batch-summary">
            {collapsedSummaries.join("；")}
          </span>
        )}
      </button>
      {expanded && (
        <div className="tool-activity-groups">
          {batches.map((batch) => {
            const batchExpanded = expandedBatchKeys.has(batch.key);
            const summaries = [trimSummary(batch.activities), failureSummary(batch.activities)].filter(
              (summary): summary is string => summary !== undefined,
            );
            return (
              <section key={batch.key} className="tool-activity-batch">
                <button
                  type="button"
                  className="tool-activity-batch-toggle"
                  aria-expanded={batchExpanded}
                  onClick={() =>
                    setExpandedBatchKeys((current) => {
                      const next = new Set(current);
                      if (next.has(batch.key)) next.delete(batch.key);
                      else next.add(batch.key);
                      return next;
                    })
                  }
                >
                  <span aria-hidden="true" className="tool-activity-arrow">
                    {batchExpanded ? "↑" : "↓"}
                  </span>
                  <span>第 {batch.agentTurnIndex} 轮工具调用</span>
                  {!batchExpanded && summaries.length > 0 && (
                    <span className="tool-activity-batch-summary">{summaries.join("；")}</span>
                  )}
                </button>
                {batchExpanded && <ActivityRows activities={batch.activities} />}
              </section>
            );
          })}
          {unbatched.length > 0 && <ActivityRows activities={unbatched} />}
        </div>
      )}
    </section>
  );
}
