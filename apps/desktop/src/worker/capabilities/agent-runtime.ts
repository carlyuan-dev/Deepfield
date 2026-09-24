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
    createAgent(config: { diagnostic?: (value: import("../agent/pi-runtime.js").PiRunDiagnostic) => void; allowedTools?: readonly string[]; onToolOutput?: (name: string, output: unknown) => void; toolOutputContext?: (name: string, output: unknown) => string | undefined }) {
      const base = options.toolSessions;
      const sessions: PiToolSessionProvider | undefined = base ? {
        bindSearchProvider: (...args) => base.bindSearchProvider(...args),
        budgetSnapshot: (...args) => base.budgetSnapshot(...args),
        recordSynthetic: (...args) => base.recordSynthetic(...args),
        releaseTrace: (...args) => base.releaseTrace(...args),
        createAgentTools: context => base.createAgentTools({ ...context, actor: "capability" })
          .filter(tool => (config.allowedTools ?? ["web_search", "read_webpage", "get_current_datetime"]).includes(tool.name))
          .map(tool => ({ ...tool, async execute(...args) {
            const result = await tool.execute(...args);
            const output = successfulToolOutput(result);
            config.onToolOutput?.(tool.name, output);
            if (output !== undefined) {
              try {
                const context = config.toolOutputContext?.(tool.name, output);
                // Retrieval admission and source projection parse this JSON too.
                // Preserve its fields and the original registry result/details.
                const part = result.content.length === 1 ? result.content[0] : undefined;
                if (context && context.length <= 64_000 && part?.type === "text") {
                  const payload: unknown = JSON.parse(part.text);
                  if (typeof payload === "object" && payload !== null && !Array.isArray(payload) && !("capabilityContext" in payload)) {
                    // Put the small catalog before page text so bounded synthesis
                    // retains the references even when long page bodies are cut.
                    return { ...result, content: [{ type: "text" as const, text: JSON.stringify({ capabilityContext: context, ...payload }) }] };
                  }
                }
              } catch { /* Optional presentation must never invalidate successful tool execution. */ }
            }
            return result;
          } })),
      } : undefined;
      const executor = createPiAgentExecutor({ runtime: options.runtime ?? defaultPiRuntime(), getApiKey: (snapshot, provider) => gateway.getApiKey(snapshot, provider), createSearchProvider: createMeteredSearchProvider }, {
        toolActor: "capability", ...(sessions ? { toolSessions: sessions } : {}), ...(config.diagnostic ? { diagnosticSink: config.diagnostic } : {}),
      });
      return { run: (request: PiExecutionRequest, emit: (event: PiExecutionEvent) => void, signal: AbortSignal) => executor.run(request, () => ({ messages: [], basePromptParts: [], finalizationPromptParts: [], sessionId: request.requestId }), emit, signal) };
    },
  };
}
