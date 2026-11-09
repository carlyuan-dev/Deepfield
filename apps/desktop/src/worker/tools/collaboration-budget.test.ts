import { expect, it } from "vitest";
import { createToolRuntime } from "./tool-runtime.js";

it("keeps distinct parent/child traces while sharing a search ceiling across release and reattachment", async () => {
  let searches = 0;
  const runtime = createToolRuntime({ audit: { start: async () => {}, finish: async () => {} } });
  const provider = { id: "fixture", capabilities: { timeRange: false }, async search() { searches++; return { provider: "fixture", results: [] }; } };
  runtime.bindBudgetScope("scope", { maxCalls: 5, categoryCalls: { search: 2, fetch: 3 } }, { search: 1, fetch: 0 });
  for (const id of ["parent", "child-a", "child-b"]) {
    runtime.attachBudgetScope(id, "scope");
    runtime.bindSearchProvider(id, provider, { categoryCalls: { search: 100 } });
  }
  const execute = (id: string) => runtime.createAgentTools({ traceId: id, actor: "child_agent", networkEnabled: true })
    .find(tool => tool.name === "web_search")!.execute(id, { query: "fixture", maxResults: 1 }, new AbortController().signal);
  const initial = await Promise.allSettled([execute("parent"), execute("child-a")]);
  expect(initial.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(searches).toBe(1);
  expect(runtime.budgetSnapshot("scope").categories.search.consumed).toBe(2);
  runtime.releaseTrace("parent"); runtime.releaseTrace("child-a");
  await expect(execute("child-b")).rejects.toThrow("budget_exceeded");
  expect(searches).toBe(1);
  runtime.releaseTrace("child-b");
  expect(runtime.releaseBudgetScope("scope")).toBe(true);
});
