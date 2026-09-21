import { describe, expect, it, vi } from "vitest";
import { makeDeps, RESEARCH_INPUT } from "../../apps/desktop/src/main/ipc-test-helpers.js";

describe("package-owned operation boundary", () => {
  it.each([
    ["start", "startCalls", ["item-1", "company-1", RESEARCH_INPUT]],
    ["cancel", "cancelCalls", ["run-1"]],
    ["getState", "getStateCalls", ["item-1", "company-1"]],
    ["listRuns", "listRunsCalls", ["item-1", "company-1"]],
    ["getRun", "getRunCalls", ["item-1", "company-1", "run-1"]],
    ["exportWord", "exportCalls", ["item-1", "company-1", "run-1", { raw: false, structured: true }]],
    ["retryFailed", "retryFailedCalls", ["item-1", "company-1", "run-1", RESEARCH_INPUT]],
    ["retryStructuring", "retryStructuringCalls", ["item-1", "company-1", "run-1"]],
    ["deleteRun", "deleteRunCalls", ["item-1", "company-1", "run-1"]],
  ] as const)("validates exact arity and every field of %s before calling service", async (channel, calls, valid) => {
    const { capabilities, companyResearch, companyResearchWordExport, dispose } = makeDeps();
    const serviceCalls = () => channel === "exportWord"
      ? companyResearchWordExport.exportCalls
      : Reflect.get(companyResearch, calls) as unknown[];
    const invalid: unknown[][] = [[], valid.slice(0, -1), [...valid, "extra"]];
    valid.forEach((value, index) => {
      const replacements = typeof value === "string" ? ["", "x".repeat(201), null, 1, {}] : channel === "exportWord"
        ? [null, {}, { raw: true }, { raw: "yes", structured: false }, { raw: true, structured: false, extra: true }]
        : [null, {}, { ...RESEARCH_INPUT, extra: true }, { ...RESEARCH_INPUT, direction: "unknown" }, { ...RESEARCH_INPUT, asOfDate: "today" }, { ...RESEARCH_INPUT, focusScope: "x".repeat(1001) }];
      for (const replacement of replacements) {
        const args: unknown[] = [...valid];
        args[index] = replacement;
        invalid.push(args);
      }
    });
    for (const args of invalid) {
      await expect(capabilities.call({ capabilityId: "company-research", operation: `companyResearch.${channel}`, requestId: "r", input: args })).rejects.toMatchObject({ code: "INPUT.INVALID" });
    }
    expect(serviceCalls()).toHaveLength(0);
    await capabilities.call({ capabilityId: "company-research", operation: `companyResearch.${channel}`, requestId: "r", input: [...valid] });
    expect(serviceCalls()).toHaveLength(1);
    dispose();
  });


  it.each([
    "industryResearch.createItem", "industryResearch.updateCompany", "industryResearch.addCompanies", "industryResearch.removeCompanies",
    "companyResearch.start", "companyResearch.cancel", "companyResearch.getRun", "companyResearch.retryFailed", "companyResearch.retryStructuring", "companyResearch.deleteRun", "companyResearch.exportWord",
    "companyResearchBatch.start", "companyResearchBatch.cancel", "settings.get",
  ])("rejects malformed argument tuples for %s", async operation => {
    const { capabilities, dispose } = makeDeps();
    await expect(capabilities.call({ capabilityId: "company-research", operation, requestId: "r", input: null })).rejects.toMatchObject({ code: "INPUT.INVALID" });
    dispose();
  });
  it("validates successful business results and rejects unknown operations", async () => {
    const { capabilities, companyResearch, dispose } = makeDeps();
    const call = { capabilityId: "company-research", operation: "companyResearch.start", requestId: "r", input: ["item-1", "company-1", RESEARCH_INPUT] };
    expect(await capabilities.call(call)).toMatchObject({ id: "run-1", status: "researching" });
    vi.spyOn(companyResearch, "start").mockResolvedValue({ apiKey: "secret" } as never);
    await expect(capabilities.call(call)).rejects.toMatchObject({ code: "INTERNAL.UNKNOWN" });
    await expect(capabilities.call({ ...call, operation: "arbitrary.channel" })).rejects.toMatchObject({ code: "capability_unavailable" });
    dispose();
  });
  it("publishes validated namespaced events and removes subscriptions on disposal", async () => {
    const { capabilities, companyResearch, dispose } = makeDeps(); const listener = vi.fn(); capabilities.subscribe(listener);
    companyResearch.emit({ type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" });
    expect(listener).toHaveBeenCalledWith({ capabilityId: "company-research", topic: "companyResearch.subscribe", payload: { type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" } });
    dispose(); await capabilities.dispose();
    companyResearch.emit({ type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
