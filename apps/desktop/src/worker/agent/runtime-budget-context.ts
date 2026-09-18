import type { BudgetDimensionSnapshot } from "@deepfield/tool-platform";
import type { AgentRunControl } from "./agent-run-control.js";

export interface RuntimeBatchSummary {
  requested: number;
  executed: number;
  reused: number;
  skipped: number;
  remaining: {
    web_search: number | undefined;
    read_webpage: number | undefined;
  };
  availableToolsNextTurn: string[];
}

function quotaLine(name: string, budget: BudgetDimensionSnapshot | undefined): string {
  if (budget?.limit === undefined || budget.remaining === undefined) {
    return `${name}: unavailable`;
  }
  return `${name}: remaining ${budget.remaining} of ${budget.limit}`;
}

export function buildRuntimeBudgetContext(
  control: AgentRunControl,
  batchSummary?: RuntimeBatchSummary,
  options: { forcedFinal?: boolean; userNetworkPermission?: "enabled" | "disabled" } = {},
): string {
  const permission = options.userNetworkPermission ?? "enabled";
  const availableNetworkTools = control.availableNetworkTools();
  if (options.forcedFinal) {
    const snapshot = control.budgetSnapshot();
    return [
      "<runtime_budget>",
      "phase: final_answer",
      `user_network_permission: ${permission}`,
      `network_tools_available_before_final: ${availableNetworkTools.join(", ") || "none"}`,
      `web_search_executed: ${snapshot?.categories.search.consumed ?? 0}`,
      `read_webpage_executed: ${snapshot?.categories.fetch.consumed ?? 0}`,
      "available_tools: none (global model-turn cap)",
      ...(batchSummary === undefined ? [] : [`batch_summary: ${JSON.stringify(batchSummary)}`]),
      "</runtime_budget>",
      "",
      "已达到本轮模型调用上限；联网权限状态没有因此改变。",
      "基于完整对话与工具结果直接输出最终答案，不得再调用工具。",
    ].join("\n");
  }
  if (control.phase() === "synthesizing" || control.phase() === "done") {
    return [
      "<runtime_budget>",
      `phase: ${control.phase()}`,
      `user_network_permission: ${permission}`,
      "available_tools: none",
      "</runtime_budget>",
      "",
      "工具阶段已经结束。基于已有结果输出最终答案。",
      "不得提出新的工具调用或搜索计划。",
    ].join("\n");
  }

  const snapshot = control.budgetSnapshot();
  const turns = control.turns();
  const lines = [
    "<runtime_budget>",
    `phase: ${control.phase()}`,
    `user_network_permission: ${permission}`,
    `available_network_tools: ${availableNetworkTools.join(", ") || "none"}`,
    quotaLine("web_search", snapshot?.categories.search),
    quotaLine("read_webpage", snapshot?.categories.fetch),
    `web_search_executed: ${snapshot?.categories.search.consumed ?? 0}`,
    `read_webpage_executed: ${snapshot?.categories.fetch.consumed ?? 0}`,
    `tool_decision_turns: remaining ${Math.max(0, turns.toolDecisionMax - turns.toolDecisionUsed)}`,
    `final_answer_turns_reserved: ${turns.synthesisReserved}`,
  ];
  if (batchSummary !== undefined) {
    lines.push(`batch_summary: ${JSON.stringify(batchSummary)}`);
  }
  lines.push(
    "</runtime_budget>",
    "",
    "只规划剩余额度允许的调用。两类工具额度独立。",
    "不要重复完全相同的查询或网址。",
  );
  return lines.join("\n");
}
