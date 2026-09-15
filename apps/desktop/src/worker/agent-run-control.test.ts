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
  it("enters synthesis when search is unavailable and there is no usable URL to fetch", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    control.observeSnapshot(snapshot({ search: 0, fetch: 2 }));

    expect(control.availableNetworkTools()).toEqual([]);
    expect(control.phase()).toBe("synthesizing");
  });

  it("keeps fetch available after search exhaustion when a usable URL is known", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    control.recordKnownUrls(["https://example.test/article"]);
    control.observeSnapshot(snapshot({ search: 0, fetch: 2 }));

    expect(control.availableNetworkTools()).toEqual(["read_webpage"]);
    expect(control.phase()).toBe("deciding");
  });

  it("reserves the final model turn", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    for (let index = 0; index < 5; index += 1) control.recordToolDecisionTurn();

    expect(control.phase()).toBe("synthesizing");
  });

  it("disables a fatal tool category without spending or hiding the other quota", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);
    control.recordKnownUrls(["https://example.test/article"]);
    control.observeSnapshot(snapshot({ search: 3, fetch: 2 }));

    expect(control.disableNetworkTool("web_search")).toBe(true);
    expect(control.networkToolEnabled("web_search")).toBe(false);
    expect(control.networkToolEnabled("read_webpage")).toBe(true);
    expect(control.availableNetworkTools()).toEqual(["read_webpage"]);
    expect(control.phase()).toBe("deciding");
    expect(control.disableNetworkTool("web_search")).toBe(false);

    expect(control.disableNetworkTool("read_webpage")).toBe(true);
    expect(control.availableNetworkTools()).toEqual([]);
    expect(control.phase()).toBe("synthesizing");
  });

  it("keeps per-tool availability queryable while a batch is executing", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);
    control.observeSnapshot(snapshot({ search: 2, fetch: 1 }));
    control.recordToolDecisionTurn();
    control.beginExecution();

    expect(control.availableNetworkTools()).toEqual([]);
    expect(control.networkToolEnabled("web_search")).toBe(true);
    control.disableNetworkTool("web_search");
    expect(control.networkToolEnabled("web_search")).toBe(false);
    expect(control.networkToolEnabled("read_webpage")).toBe(true);
  });

  it("reports only the first explicit synthesis transition", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);
    control.observeSnapshot(snapshot({ search: 1, fetch: 1 }));

    expect(control.requestSynthesis()).toBe(true);
    expect(control.requestSynthesis()).toBe(false);
    expect(control.phase()).toBe("synthesizing");
  });

  it("moves to synthesis when its caller reports the deadline elapsed", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);

    control.observeDeadline(10_000);

    expect(control.phase()).toBe("synthesizing");
  });

  it("returns to deciding between batches and synthesizes after execution exhausts both budgets", () => {
    const control = createAgentRunControl(WEB_CHAT_POLICY, 10_000);
    control.observeSnapshot(snapshot({ search: 2, fetch: 1 }));

    control.recordToolDecisionTurn();
    control.beginExecution();
    control.observeSnapshot(snapshot({ search: 1, fetch: 1 }));
    control.recordBatchEvidence({ successfulSearches: 1 });
    control.completeBatch();

    expect(control.phase()).toBe("deciding");
    expect(control.availableNetworkTools()).toEqual(["web_search", "read_webpage"]);

    control.recordToolDecisionTurn();
    control.beginExecution();
    control.observeSnapshot(snapshot({ search: 0, fetch: 0 }));
    control.recordBatchEvidence({ successfulSearches: 1 });
    control.completeBatch();

    expect(control.phase()).toBe("synthesizing");
  });
});
