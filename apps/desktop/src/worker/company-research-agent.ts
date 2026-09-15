import type { AgentWorkerRequest, CompanyResearchWorkerEvent, CompanyResearchWorkerRequest } from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { buildCompanyResearchPrompt } from "./company-research-prompt.js";
import { buildCompanyResearchStructuringPrompt } from "./company-research-structuring-prompt.js";
import { researchFailure } from "./message-loop-types.js";
import { CompanyResearchRawFilter } from "./company-research-raw-filter.js";
import { createPiChatAgent, PiChatAgentError, type PiRuntime, type PiToolSessionProvider } from "./pi-chat-agent.js";
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

function mapPiFailure(error: PiChatAgentError): RawFailureCode {
  switch (error.code) {
    case "invalid_final_empty": return "empty_report";
    case "invalid_final_protocol": return "protocol_leak";
    case "invalid_final_language": return "language_validation_failed";
    case "invalid_final_tool_use": return "incomplete_response";
    case "incomplete_lifecycle": return "incomplete_response";
    case "provider_failed":
    case "stream_failed": return "model_failed";
  }
}

export function createCompanyResearchAgent(options: CompanyResearchAgentOptions = {}): CompanyResearchAgent {
  const gateway = options.gateway ?? new PiModelGateway();
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
          const startedMs = Date.now();
          let text = "";
          const emitStructureDiagnostic = (
            stopReason: "stop" | "error" | "aborted",
            errorCategory?: PiChatAgentError["code"],
          ): void => {
            const finishedMs = Date.now();
            emit({ ...identity, type: "model_diagnostic", traceId: request.requestId, phase: "structuring",
              agentTurns: 1, searchCalls: 0, fetchCalls: 0,
              maxModelInputCharsEstimate: prompt.instructions.length + prompt.input.length,
              outputChars: text.length, stopReason,
              ...(errorCategory === undefined ? {} : { errorCategory }),
              startedAt: new Date(startedMs).toISOString(), finishedAt: new Date(finishedMs).toISOString(),
              durationMs: Math.max(0, finishedMs - startedMs) });
          };
          try {
            text = await gateway.completeText(request.llm, prompt.instructions, prompt.input, signal);
          } catch (error) {
            if (signal.aborted) emitStructureDiagnostic("aborted");
            else emitStructureDiagnostic("error", "provider_failed");
            throw error;
          }
          if (!text.trim()) {
            emitStructureDiagnostic("stop", "invalid_final_empty");
            throw new Error("invalid structure completion");
          }
          emitStructureDiagnostic("stop");
          emit({ ...identity, type: "completed", text });
          return;
        }
        const rawAgent = options.rawAgent ?? createPiChatAgent(
          options.piRuntime, [], undefined, {}, options.toolSessions, gateway, undefined, "capability",
          (diagnostic) => emit({ ...identity, type: "model_diagnostic", ...diagnostic }),
        );
        const previewFilter = new CompanyResearchRawFilter();
        let terminalText: string | undefined;
        let terminalSeen = false;
        const chatRequest: AgentWorkerRequest = {
          requestId: request.requestId,
          kind: "chat.prompt",
          prompt: prompt.input,
          context: {
            conversationId: request.runId,
            systemPrompt: prompt.instructions,
            ...(prompt.finalizationInstructions === undefined ? {} : {
              finalizationSystemPrompt: prompt.finalizationInstructions,
            }),
            messages: [],
          },
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
              const { requestId: _requestId, ...activity } = event;
              emit({ ...identity, stage: "raw", ...activity });
            } else if (event.type === "completed") {
              terminalSeen = true;
              terminalText = event.text;
              const tail = previewFilter.finish();
              if (tail) emit({ ...identity, stage: "raw", type: "text_delta", delta: tail });
            } else if (event.type === "failed") {
              terminalSeen = true;
              throw new RawResearchFailure("model_failed");
            }
          }, signal);
        } catch (error) {
          if (error instanceof RawResearchFailure) throw error;
          if (error instanceof PiChatAgentError) throw new RawResearchFailure(mapPiFailure(error));
          throw new RawResearchFailure("model_failed");
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
