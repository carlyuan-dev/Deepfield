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

type RawFailureCode = "tool_failed" | "model_failed" | "empty_report" | "protocol_leak" | "language_validation_failed" | "incomplete_response";

class RawResearchFailure extends Error {
  constructor(readonly code: RawFailureCode) { super(code); }
}

function filteredReport(text: string): string {
  const filter = new CompanyResearchRawFilter();
  return filter.push(text) + filter.finish();
}

function validateRawReport(text: string, expectsChinese: boolean): string {
  if (text.includes("<｜｜DSML｜｜") || text.includes("<|DSML|>")) throw new RawResearchFailure("protocol_leak");
  const filtered = filteredReport(text);
  if (!filtered.trim()) throw new RawResearchFailure("empty_report");
  if (expectsChinese && !/\p{Script=Han}/u.test(filtered)) throw new RawResearchFailure("language_validation_failed");
  return filtered;
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
        const previewFilter = new CompanyResearchRawFilter();
        let terminalText: string | undefined;
        let terminalSeen = false;
        let failedToolSeen = false;
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
        try {
          await rawAgent.run(chatRequest, (event) => {
            if (event.type === "text_delta") {
              const delta = previewFilter.push(event.delta);
              if (delta) emit({ ...identity, stage: "raw", type: "text_delta", delta });
            } else if (event.type === "tool_activity") {
              if (event.status === "failed") failedToolSeen = true;
              const { requestId: _requestId, ...activity } = event;
              emit({ ...identity, stage: "raw", ...activity });
            } else if (event.type === "completed") {
              terminalSeen = true;
              terminalText = event.text;
              const tail = previewFilter.finish();
              if (tail) emit({ ...identity, stage: "raw", type: "text_delta", delta: tail });
            } else if (event.type === "failed") {
              terminalSeen = true;
              throw new RawResearchFailure(failedToolSeen ? "tool_failed" : "model_failed");
            }
          }, signal);
        } catch (error) {
          if (error instanceof RawResearchFailure) throw error;
          throw new RawResearchFailure(failedToolSeen ? "tool_failed" : "model_failed");
        }
        if (!terminalSeen || terminalText === undefined) throw new RawResearchFailure("incomplete_response");
        const report = validateRawReport(terminalText, /\p{Script=Han}/u.test(prompt.input));
        emit({ ...identity, type: "completed", text: report });
      } catch (error) {
        if (signal.aborted) emit({ ...identity, type: "cancelled" });
        else if (request.stage === "raw" && error instanceof RawResearchFailure) {
          emit({ ...identity, stage: "raw", type: "failed", code: error.code, message: "company research failed" });
        } else emit({ ...identity, type: "failed", ...researchFailure(request.stage) });
      }
    },
  };
}
