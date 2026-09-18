import { describe, expect, it } from "vitest";
import { ToolBudgetLedger } from "@deepfield/tool-platform";
import { createAgentRunControl, WEB_CHAT_POLICY } from "./agent-run-control.js";
import { buildRuntimeBudgetContext } from "./runtime-budget-context.js";

function controlWithRemaining(search: number, fetch: number, turns: number) {
  const ledger = new ToolBudgetLedger({ categoryCalls: { search: 4, fetch: 3 } });
  const consume = (name: "web_search" | "read_webpage", category: "search" | "fetch") => {
    const token = ledger.reserve({ name, version: 1 }, category);
    ledger.complete(token);
  };
  for (let index = search; index < 4; index += 1) consume("web_search", "search");
  for (let index = fetch; index < 3; index += 1) consume("read_webpage", "fetch");
  const control = createAgentRunControl(WEB_CHAT_POLICY, Number.POSITIVE_INFINITY);
  control.observeSnapshot(ledger.snapshot());
  for (let index = turns; index < WEB_CHAT_POLICY.toolDecisionTurns; index += 1) {
    control.recordToolDecisionTurn();
  }
  return control;
}

describe("runtime budget context", () => {
  it("reports current independent quotas and reserved synthesis", () => {
    const text = buildRuntimeBudgetContext(controlWithRemaining(2, 3, 3));

    expect(text).toContain("phase: deciding");
    expect(text).toContain("web_search: remaining 2 of 4");
    expect(text).toContain("read_webpage: remaining 3 of 3");
    expect(text).toContain("tool_decision_turns: remaining 3");
    expect(text).toContain("final_answer_turns_reserved: 1");
    expect(text).toContain("两类工具额度独立");
  });

  it("reports a tool-free synthesis phase", () => {
    const control = controlWithRemaining(0, 0, 3);

    const text = buildRuntimeBudgetContext(control);
    expect(text).toContain("phase: synthesizing");
    expect(text).toContain("user_network_permission: enabled");
    expect(text).toContain("available_tools: none");
  });

  it("distinguishes a global turn cap from disabled network permission", () => {
    const control = controlWithRemaining(2, 1, 2);
    const text = buildRuntimeBudgetContext(control, undefined, {
      forcedFinal: true,
      userNetworkPermission: "enabled",
    });

    expect(text).toContain("phase: final_answer");
    expect(text).toContain("user_network_permission: enabled");
    expect(text).toContain("available_tools: none (global model-turn cap)");
    expect(text).toContain("联网权限状态没有因此改变");
  });
});
