import { describe, expect, it } from "vitest";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
import { WEB_CHAT_POLICY, createAgentRunControl } from "./agent-run-control.js";

function snapshot(remaining: { search: number; fetch: number }): ToolBudgetSnapshot {
  const dimension = (value: number) => ({
    limit: value,
    reserved: 0,
    consumed: 0,
    remaining: value,
    exhausted: value === 0,
  });
  return {
    total: dimension(remaining.search + remaining.fetch),
    categories: {
      search: dimension(remaining.search),
      fetch: dimension(remaining.fetch),
      link_check: dimension(0),
      parse: dimension(0),
      none: dimension(0),
    },
  };
}

describe("createAgentRunControl", () => {
  it("keeps fetch available after search exhaustion", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    control.observeSnapshot(snapshot({ search: 0, fetch: 2 }));

    expect(control.availableNetworkTools()).toEqual(["read_webpage"]);
    expect(control.phase()).toBe("deciding");
  });

  it("reserves the final model turn", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    for (let index = 0; index < 5; index += 1) control.recordToolDecisionTurn();

    expect(control.phase()).toBe("synthesizing");
  });

  it("moves to synthesis when its caller reports the deadline elapsed", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    control.observeDeadline(10_000);

    expect(control.phase()).toBe("synthesizing");
  });
});
