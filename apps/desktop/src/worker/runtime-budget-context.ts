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
): string {
  if (control.phase() === "synthesizing" || control.phase() === "done") {
    return [
      "<runtime_budget>",
      `phase: ${control.phase()}`,
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
    quotaLine("web_search", snapshot?.categories.search),
    quotaLine("read_webpage", snapshot?.categories.fetch),
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
