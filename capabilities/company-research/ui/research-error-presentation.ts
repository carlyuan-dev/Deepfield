import { toPublicError } from "@deepfield/contracts";
import { configurationErrorText } from "../../../apps/desktop/src/renderer/features/settings/error-presentation.js";
import { ResearchReadinessError } from "./research-readiness.js";

export interface ResearchActionErrorPresentation {
  message: string;
  settingsModule?: "llm" | "search";
}

export function researchActionError(value: unknown, action: "start" | "retry"): ResearchActionErrorPresentation {
  // This class is constructed locally by UI preflight only, never by IPC.
  if (value instanceof ResearchReadinessError) return {
    message: value.message,
    settingsModule: value.context?.service ?? "llm",
  };
  const error = toPublicError(value);
  const configured = configurationErrorText(value, "research");
  if (configured) return {
    message: configured,
    ...(error.category === "configuration" ? { settingsModule: error.context?.service ?? "llm" } : {}),
  };
  switch (error.code) {
    case "INPUT.INVALID": return { message: "调研输入无效，请检查研究方向、截至日期和关注范围。" };
    case "BUSINESS.CONFLICT": return { message: "当前调研状态不允许此操作，请刷新或等待正在运行的调研结束。" };
    case "RESOURCE.NOT_FOUND": return { message: "调研目标已不存在，请刷新后重试。" };
    case "STORAGE.FAILED": return { message: "无法保存调研状态，请稍后重试。" };
    default: return { message: action === "retry" ? "无法重新尝试，请稍后重试" : "无法开始调研，请稍后重试" };
  }
}

export function researchActionErrorText(value: unknown, action: "start" | "retry"): string {
  return researchActionError(value, action).message;
}
