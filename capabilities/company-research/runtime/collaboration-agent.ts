import type { CapabilityAgentCollaboration } from "@deepfield/capability-sdk";
import type { CompanyAgent } from "./ports.js";

/** The package still owns evidence, validation and its durable research-stage journal. */
export function coordinatedResearchAgent(agent: CompanyAgent, collaboration: CapabilityAgentCollaboration): CompanyAgent {
  return { async run(request, emit, signal) {
    let failure: unknown;
    const coordinator = collaboration.create({
      taskScopeId: request.requestId,
      limits: { concurrency: 1, maxTasks: 1, maxRuns: 1, maxRunsPerTask: 1,
        maxAgentTurns: request.toolAccess.maxAgentTurns, deadline: Date.now() + 10 * 60_000 },
      signal,
      execute: async (_task, controls) => {
        let text: string | undefined;
        try {
          await agent.run(request, event => {
            if (event.type === "completed") text = event.text;
            else emit(event);
          }, controls.signal);
          controls.signal.throwIfAborted();
          if (text === undefined) throw new Error("incomplete_lifecycle");
          return { result: { text, summary: text.slice(0, 1000) } };
        } catch (error) { failure = error; throw error; }
      },
    });
    try {
      const receipt = await coordinator.spawn({ title: "公司原始调研", text: request.prompt, configurationId: "research.raw" }, request.requestId);
      let cursor = 0;
      for (;;) {
        const run = coordinator.get(receipt.taskId).runs.at(-1)!;
        if (run.status === "completed" && run.result) {
          emit({ requestId: request.requestId, type: "completed", text: run.result.text });
          break;
        }
        if (!["queued", "running", "cancelling"].includes(run.status)) {
          signal.throwIfAborted();
          throw failure ?? new Error(run.errorCode ?? `research_${run.status}`);
        }
        const update = await coordinator.wait([receipt.runId], cursor, 30_000, signal);
        cursor = update.cursor;
      }
    } finally { await coordinator.close(); }
  } };
}
