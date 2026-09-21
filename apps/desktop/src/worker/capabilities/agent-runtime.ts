import { createPiAgentExecutor } from "../agent/pi-agent-executor.js";
import { PiChatAgentError, type PiRuntime, type PiToolSessionProvider } from "../agent/pi-runtime.js";
import { defaultPiRuntime } from "../agent/pi-default-runtime.js";
import { PiModelGateway, type ModelGateway } from "../../shared/model-gateway.js";
import { createMeteredSearchProvider } from "../../shared/usage-search.js";
import { successfulToolOutput } from "../tools/pi-tool-adapter.js";
import type { PiExecutionRequest, PiExecutionEvent } from "@deepfield/capability-sdk";

/** Stateless execution port. No Chat context, transcript, memory, skill or conversation tools. */
export function createCapabilityAgentRuntime(options: { runtime?: PiRuntime; toolSessions?: PiToolSessionProvider; gateway?: ModelGateway } = {}) {
  const gateway = options.gateway ?? new PiModelGateway();
  return {
    gateway,
    classifyError(error: unknown) { return error instanceof PiChatAgentError ? error.code : undefined; },
    createAgent(config: { diagnostic?: (value: import("../agent/pi-runtime.js").PiRunDiagnostic) => void; allowedTools?: readonly string[]; onToolOutput?: (name: string, output: unknown) => void }) {
      const base = options.toolSessions;
      const sessions: PiToolSessionProvider | undefined = base ? {
        bindSearchProvider: (...args) => base.bindSearchProvider(...args),
        budgetSnapshot: (...args) => base.budgetSnapshot(...args),
        recordSynthetic: (...args) => base.recordSynthetic(...args),
        releaseTrace: (...args) => base.releaseTrace(...args),
        createAgentTools: context => base.createAgentTools({ ...context, actor: "capability" })
          .filter(tool => (config.allowedTools ?? ["web_search", "read_webpage", "get_current_datetime"]).includes(tool.name))
          .map(tool => ({ ...tool, async execute(...args) { const result = await tool.execute(...args); config.onToolOutput?.(tool.name, successfulToolOutput(result)); return result; } })),
      } : undefined;
      const executor = createPiAgentExecutor({ runtime: options.runtime ?? defaultPiRuntime(), getApiKey: (snapshot, provider) => gateway.getApiKey(snapshot, provider), createSearchProvider: createMeteredSearchProvider }, {
        toolActor: "capability", ...(sessions ? { toolSessions: sessions } : {}), ...(config.diagnostic ? { diagnosticSink: config.diagnostic } : {}),
      });
      return { run: (request: PiExecutionRequest, emit: (event: PiExecutionEvent) => void, signal: AbortSignal) => executor.run(request, () => ({ messages: [], basePromptParts: [], finalizationPromptParts: [], sessionId: request.requestId }), emit, signal) };
    },
  };
}
