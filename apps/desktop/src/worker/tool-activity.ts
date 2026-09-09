const MAX_NAME_LENGTH = 48;
const MAX_SUMMARY_LENGTH = 96;

const KNOWN_TOOL_NAMES = new Set([
  "get_current_datetime",
  "calculator",
  "convert_timezone",
  "list_conversations",
  "read_conversation",
  "search_conversations",
  "fetch_url",
  "fetch_pdf",
  "parse_html",
  "parse_pdf",
  "check_link_accessibility",
  "echo_probe",
]);

export interface SafeToolActivity {
  name: string;
  summary?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clippedLine(value: string, maximum = MAX_SUMMARY_LENGTH): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (line.length <= maximum) return line;
  return `${line.slice(0, Math.max(0, maximum - 1))}…`;
}

function safeName(toolName: string): string {
  if (KNOWN_TOOL_NAMES.has(toolName)) return toolName;
  if (/^[a-z][a-z0-9_]{0,47}$/u.test(toolName)) return clippedLine(toolName, MAX_NAME_LENGTH);
  return "unknown_tool";
}

function urlHost(args: Record<string, unknown> | undefined): string | undefined {
  const candidate = args?.["url"];
  if (typeof candidate !== "string") return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return clippedLine(parsed.hostname.toLowerCase());
  } catch {
    return undefined;
  }
}

function timeZone(args: Record<string, unknown> | undefined): string | undefined {
  const candidate = args?.["timeZone"];
  return typeof candidate === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/u.test(candidate)
    ? candidate
    : undefined;
}

function summaryFor(toolName: string, args: unknown): string | undefined {
  const input = record(args);
  switch (toolName) {
    case "fetch_url":
    case "fetch_pdf":
    case "check_link_accessibility":
      return urlHost(input) ?? "公开网址";
    case "get_current_datetime":
      return timeZone(input) ?? "本机时区";
    case "convert_timezone": {
      const zone = timeZone(input);
      return zone === undefined ? "时区转换" : `转换至 ${zone}`;
    }
    case "calculator": {
      const expression = input?.["expression"];
      return typeof expression === "string" && /^[\d\s()+\-*/%.^]{1,64}$/u.test(expression)
        ? clippedLine(expression, 64)
        : "算术表达式";
    }
    case "list_conversations":
      return "最近对话";
    case "read_conversation":
      return "指定对话";
    case "search_conversations":
      return "本地对话搜索";
    case "parse_html":
      return "网页内容";
    case "parse_pdf":
      return "PDF 内容";
    case "echo_probe":
      return "本地测试";
    default:
      return "参数已隐藏";
  }
}

/** Reduce provider-owned tool metadata to a bounded, display-safe activity. */
export function safeToolActivity(toolName: string, args: unknown): SafeToolActivity {
  const name = safeName(toolName);
  const summary = summaryFor(name, args);
  return { name, ...(summary === undefined ? {} : { summary: clippedLine(summary) }) };
}
