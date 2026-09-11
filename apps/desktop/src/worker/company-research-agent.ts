import type { AgentWorkerRequest, CompanyResearchWorkerEvent, CompanyResearchWorkerRequest } from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { buildCompanyResearchPrompt } from "./company-research-prompt.js";
import { buildCompanyResearchStructuringPrompt } from "./company-research-structuring-prompt.js";
import { researchFailure } from "./message-loop-types.js";
import { CompanyResearchRawFilter } from "./company-research-raw-filter.js";
import { createPiChatAgent, type PiRuntime, type PiToolSessionProvider } from "./pi-chat-agent.js";
import { PiModelGateway, type ModelGateway } from "../shared/model-gateway.js";

export interface CompanyResearchAgentOptions {
  piRuntime?: PiRuntime;
  toolSessions?: PiToolSessionProvider;
  gateway?: ModelGateway;
  rawAgent?: ChatAgent;
}

export interface CompanyResearchAgent {
  run(request: CompanyResearchWorkerRequest, emit: (event: CompanyResearchWorkerEvent) => void, signal: AbortSignal): Promise<void>;
}

export function createCompanyResearchAgent(options: CompanyResearchAgentOptions = {}): CompanyResearchAgent {
  const gateway = options.gateway ?? new PiModelGateway();
  const rawAgent = options.rawAgent ?? createPiChatAgent(options.piRuntime, [], undefined, {}, options.toolSessions, gateway, undefined, "capability");
  return {
    async run(request, emit, signal) {
      const identity = { requestId: request.requestId, runId: request.runId, stage: request.stage };
      emit({ ...identity, type: "started" });
      if (signal.aborted) { emit({ ...identity, type: "cancelled" }); return; }
      try {
        const prompt = request.stage === "raw"
          ? buildCompanyResearchPrompt(request.context, request.template)
          : buildCompanyResearchStructuringPrompt(request);
        if (request.stage === "structure") {
          const text = await gateway.completeText(request.llm, prompt.instructions, prompt.input, signal);
          if (!text.trim()) throw new Error("empty");
          emit({ ...identity, type: "completed", text });
          return;
        }
        const filter = new CompanyResearchRawFilter();
        let visible = "";
        const chatRequest: AgentWorkerRequest = {
          requestId: request.requestId,
          kind: "chat.prompt",
          prompt: prompt.input,
          context: { conversationId: request.runId, systemPrompt: prompt.instructions, messages: [] },
          options: { webSearch: true },
          llm: request.llm,
          search: request.search,
          toolAccess: request.toolAccess,
        };
        await rawAgent.run(chatRequest, (event) => {
          if (event.type === "text_delta") {
            const delta = filter.push(event.delta); visible += delta;
            if (delta) emit({ ...identity, stage: "raw", type: "text_delta", delta });
          } else if (event.type === "completed") {
            const tail = filter.finish(); visible += tail;
            if (tail) emit({ ...identity, stage: "raw", type: "text_delta", delta: tail });
          } else if (event.type === "failed") throw new Error("agent failed");
        }, signal);
        if (!visible.trim()) throw new Error("empty");
        emit({ ...identity, type: "completed", text: visible });
      } catch {
        if (signal.aborted) emit({ ...identity, type: "cancelled" });
        else emit({ ...identity, type: "failed", ...researchFailure(request.stage) });
      }
    },
  };
}
