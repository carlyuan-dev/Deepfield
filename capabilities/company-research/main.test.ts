import { describe, expect, it, vi } from "vitest";
import { makeDeps, RESEARCH_INPUT } from "../../apps/desktop/src/main/ipc-test-helpers.js";

describe("package-owned operation boundary", () => {
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
