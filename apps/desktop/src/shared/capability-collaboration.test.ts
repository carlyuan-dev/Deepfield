import { expect, it } from "vitest";
import { createCapabilityHostServices, getCapabilityAgentCollaboration } from "@deepfield/capability-sdk";
import { scopeCapabilityCollaboration } from "./capability-collaboration.js";
import { coordinatedResearchAgent } from "../../../../capabilities/company-research/runtime/collaboration-agent.js";
import type { PiExecutionRequest } from "@deepfield/capability-sdk";

it("runs the package's existing research executor under its own scope and preserves result, errors and cancellation", async () => {
  const cleanup: Array<() => Promise<void>> = [];
  const services = scopeCapabilityCollaboration(createCapabilityHostServices({ "agent.collaboration.v1": {} }), "company-research", fn => cleanup.push(fn));
  const port = getCapabilityAgentCollaboration(services)!;
  const request = { requestId: "raw-test", prompt: "研究范围", toolAccess: { maxAgentTurns: 4 } } as PiExecutionRequest;
  const events: string[] = [];
  const agent = coordinatedResearchAgent({ async run(value, emit) { expect(value.prompt).toBe("研究范围"); emit({ requestId: value.requestId, type: "completed", text: "report with sources" }); } }, port);
  try {
    await agent.run(request, event => { if (event.type === "completed") events.push(event.text); }, new AbortController().signal);
    expect(events).toEqual(["report with sources"]);
    const error = new Error("specific-evidence-failure");
    const broken = coordinatedResearchAgent({ async run() { throw error; } }, port);
    await expect(broken.run(request, () => {}, new AbortController().signal)).rejects.toBe(error);
    let called = false;
    const cancelled = coordinatedResearchAgent({ async run() { called = true; } }, port);
    await expect(cancelled.run(request, () => {}, AbortSignal.abort())).rejects.toThrow();
    expect(called).toBe(false);
  } finally { for (const close of cleanup) await close(); }
  expect(getCapabilityAgentCollaboration(createCapabilityHostServices({}))).toBeUndefined();
});
