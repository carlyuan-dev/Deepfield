import { useEffect, useRef, useState } from "react";
import type { ToolActivityView } from "../state/chat.js";

const TOOL_LABELS: Readonly<Record<string, string>> = {
  web_search: "联网搜索",
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
};

function labelFor(name: string): string {
  const known = TOOL_LABELS[name];
  if (known !== undefined) return known;
  const clipped = name.length > 32 ? `${name.slice(0, 31)}…` : name;
  return clipped === "unknown_tool" ? "其他工具" : clipped;
}

export interface ToolActivityProps {
  activities: ToolActivityView[];
  terminal: boolean;
}

export function ToolActivity({ activities, terminal }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(
    () => !terminal && activities.some((activity) => activity.status === "running"),
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
    }
    previousCount.current = activities.length;
  }, [activities, terminal]);

  useEffect(() => {
    if (terminal && !wasTerminal.current) {
      setExpanded(false);
    }
    wasTerminal.current = terminal;
  }, [terminal]);

  if (activities.length === 0) return null;
  const title = `${terminal ? "已调用" : "正在调用"} ${activities.length} 个工具`;

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
      </button>
      {expanded && (
        <ol className="tool-activity-list">
          {activities.map((activity) => (
            <li key={activity.callKey} className="tool-activity-row">
              <span className="tool-activity-name">{labelFor(activity.name)}</span>
              {activity.summary !== undefined && (
                <span className="tool-activity-summary">{activity.summary}</span>
              )}
              <span className={`tool-activity-status ${activity.status}`}>
                {STATUS_LABELS[activity.status]}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
