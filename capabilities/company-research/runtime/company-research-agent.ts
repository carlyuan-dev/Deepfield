import type { PiExecutionRequest } from "@deepfield/capability-sdk";
import type { CompanyResearchModelErrorCategory, CompanyResearchWorkerEvent, CompanyResearchWorkerRequest } from "../contracts/index.js";
import { StructuredResearchValidationError, validateStructuredResearch } from "../application/index.js";
import type { CompanyAgent, CompanyAgentRuntime, ExecutionErrorCode, ModelGateway, ModelCompletionResult } from "./ports.js";
import { buildCompanyResearchPrompt } from "./company-research-prompt.js";
import { buildCompanyResearchStructuringPrompt } from "./company-research-structuring-prompt.js";
import { researchFailure } from "./failure.js";
import { CompanyResearchRawFilter } from "./company-research-raw-filter.js";
import { ResearchEvidenceCollector } from "./company-research-evidence-collector.js";
import { buildStructureRepairPrompt, budgetMessages, checkStructureBudget, BUDGET_VERSION } from "./company-research-context-budget.js";
import { evidenceHash } from "../persistence/research-evidence-data.js";

export interface CompanyResearchAgentOptions {
  runtime: CompanyAgentRuntime;
  gateway?: ModelGateway;
  rawAgent?: CompanyAgent;
}

export interface CompanyResearchAgent {
  run(request: CompanyResearchWorkerRequest, emit: (event: CompanyResearchWorkerEvent) => void, signal: AbortSignal): Promise<void>;
}

type RawFailureCode = "tool_failed" | "model_failed" | "empty_report" | "protocol_leak" | "language_validation_failed" | "incomplete_response" | "evidence_incomplete";

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

function mapPiFailure(code: ExecutionErrorCode): RawFailureCode {
  switch (code) {
    case "invalid_final_empty": return "empty_report";
    case "invalid_final_protocol": return "protocol_leak";
    case "invalid_final_language": return "language_validation_failed";
    case "invalid_final_tool_use": return "incomplete_response";
    case "incomplete_lifecycle": return "incomplete_response";
    case "provider_failed":
    case "stream_failed": return "model_failed";
  }
}

const FAILED_CANDIDATE_LIMIT = 16_384;
async function completeStructure(gateway: ModelGateway, request: Extract<CompanyResearchWorkerRequest, { stage: "structure" }>, system: string, prompt: string, signal: AbortSignal): Promise<ModelCompletionResult> {
  if (request.evidencePolicy === "required_v1" && (!request.evidencePacket || evidenceHash(request.evidencePacket.body) !== request.evidencePacket.hash)) throw new Error("evidence_incomplete: dispatch packet hash");
  const options = { maxTokens: budgetMessages(request, { instructions: system, input: prompt }).O };
  if (gateway.completeTextResult) return gateway.completeTextResult(request.llm, system, prompt, signal, options);
  return { text: await gateway.completeText(request.llm, system, prompt, signal, options), stopReason: "stop" };
}

export function createCompanyResearchAgent(options: CompanyResearchAgentOptions): CompanyResearchAgent {
  const gateway = options.gateway ?? options.runtime.gateway;
  return {
    async run(request, emit, signal) {
      const identity = { requestId: request.requestId, runId: request.runId, stage: request.stage };
      emit({ ...identity, type: "started" });
      if (signal.aborted) { emit({ ...identity, type: "cancelled" }); return; }
      try {
        if (!request.evidencePolicy || request.evidencePolicy === "required_v1" && !request.attemptId) throw new Error("evidence_incomplete");
        const prompt = request.stage === "raw"
          ? buildCompanyResearchPrompt(request.context, request.template)
          : buildCompanyResearchStructuringPrompt(request);
        if (request.stage === "structure") {
          if (request.evidencePolicy === "required_v1" && (!request.attemptId || !request.evidencePacket || evidenceHash(request.evidencePacket.body) !== request.evidencePacket.hash)) throw new Error("evidence_incomplete");
          if (request.evidencePolicy === "required_v1" && !checkStructureBudget(request).allowed) {
            emit({ ...identity, stage: "structure", type: "failed", code: "context_budget_exceeded", message: "company research structuring failed" }); return;
          }
          const startedMs = Date.now();
          let text = "";
          const emitStructureDiagnostic = (
            stopReason: "stop" | "length" | "tool_use" | "error" | "aborted" | "unknown",
            errorCategory?: CompanyResearchModelErrorCategory,
            attempt = 1,
            validationError?: StructuredResearchValidationError,
            attemptStartedMs = startedMs,
            inputChars = prompt.instructions.length + prompt.input.length,
            captureCandidate = false,
          ): void => {
            const finishedMs = Date.now();
            emit({ ...identity, type: "model_diagnostic", traceId: request.requestId, phase: "structuring",
              ...(request.evidencePacket ? { packetHash: evidenceHash(request.evidencePacket.body), packetVersion: request.evidencePacket.packetVersion,
                snapshotHash: request.evidencePacket.snapshotHash, budgetVersion: BUDGET_VERSION } : {}),
              agentTurns: 1, searchCalls: 0, fetchCalls: 0,
              maxModelInputCharsEstimate: inputChars,
              outputChars: text.length, stopReason, attempt,
              ...(errorCategory === undefined ? {} : { errorCategory }),
              ...(validationError === undefined ? {} : { validationIssues: validationError.issues }),
              ...(!captureCandidate && validationError === undefined ? {} : { failedCandidate: text.slice(0, FAILED_CANDIDATE_LIMIT) }),
              startedAt: new Date(attemptStartedMs).toISOString(), finishedAt: new Date(finishedMs).toISOString(),
              durationMs: Math.max(0, finishedMs - attemptStartedMs) });
          };
          let completion: ModelCompletionResult;
          try {
            completion = await completeStructure(gateway, request, prompt.instructions, prompt.input, signal);
            text = completion.text;
          } catch (error) {
            if (signal.aborted) emitStructureDiagnostic("aborted");
            else emitStructureDiagnostic("error", "provider_failed");
            throw error;
          }
          if (completion.stopReason === "length") {
            emitStructureDiagnostic("length", "truncated", 1, undefined, startedMs, prompt.instructions.length + prompt.input.length, true);
            throw new Error("truncated structure completion");
          }
          if (!text.trim()) {
            emitStructureDiagnostic(completion.stopReason, "invalid_final_empty", 1, undefined, startedMs, prompt.instructions.length + prompt.input.length, true);
            throw new Error("invalid structure completion");
          }
          try {
            validateStructuredResearch(text, request.rawReportText, request.template);
            emitStructureDiagnostic(completion.stopReason);
            emit({ ...identity, type: "completed", text });
            return;
          } catch (error) {
            if (!(error instanceof StructuredResearchValidationError)) throw error;
            emitStructureDiagnostic(completion.stopReason, error.category, 1, error);
            if (error.category === "source_mismatch") throw error;
            const repair = buildStructureRepairPrompt(request, text, { category: error.category, issues: error.issues, ...(error.repairHint === undefined ? {} : { repairHint: error.repairHint }) });
            if (request.evidencePolicy === "required_v1" && !budgetMessages(request, repair).allowed) {
              emit({ ...identity, stage: "structure", type: "failed", code: "context_budget_exceeded", message: "company research structuring failed" }); return;
            }
            const repairStartedMs = Date.now();
            const repairInputChars = repair.instructions.length + repair.input.length;
            if (signal.aborted) {
              emitStructureDiagnostic("aborted", undefined, 2, undefined, repairStartedMs, repairInputChars);
              throw new Error("structure repair cancelled");
            }
            let repaired: ModelCompletionResult;
            try {
              repaired = await completeStructure(gateway, request, repair.instructions, repair.input, signal);
              text = repaired.text;
            } catch (repairError) {
              if (signal.aborted) emitStructureDiagnostic("aborted", undefined, 2, undefined, repairStartedMs, repairInputChars);
              else emitStructureDiagnostic("error", "provider_failed", 2, undefined, repairStartedMs, repairInputChars);
              throw repairError;
            }
            if (repaired.stopReason === "length") {
              emitStructureDiagnostic("length", "truncated", 2, undefined, repairStartedMs, repairInputChars, true);
              throw new Error("truncated repair completion");
            }
            if (!text.trim()) {
              emitStructureDiagnostic(repaired.stopReason, "invalid_final_empty", 2, undefined, repairStartedMs, repairInputChars, true);
              throw new Error("invalid repair completion");
            }
            try {
              validateStructuredResearch(text, request.rawReportText, request.template);
            } catch (repairError) {
              if (repairError instanceof StructuredResearchValidationError) {
                emitStructureDiagnostic(repaired.stopReason, repairError.category, 2, repairError, repairStartedMs, repairInputChars);
              }
              throw repairError;
            }
            emitStructureDiagnostic(repaired.stopReason, undefined, 2, undefined, repairStartedMs, repairInputChars);
            emit({ ...identity, type: "completed", text });
          }
          return;
        }
        const collector = request.evidencePolicy === "required_v1" ? new ResearchEvidenceCollector(request.requestId, receipt => {
          if (!request.attemptId) throw new Error("evidence_incomplete");
          emit({ ...identity, stage: "raw", type: "evidence", attemptId: request.attemptId, receipt });
        }) : undefined;
        let terminalText: string | undefined;
        let terminalSeen = false;
        const rawAgent = options.rawAgent ?? options.runtime.createAgent({ ...(collector ? { observeModelRequest: collector.observe } : {}), diagnostic: diagnostic => {
          let errorCategory = diagnostic.errorCategory;
          if (!errorCategory && terminalText !== undefined) {
            try { validateRawReport(terminalText, /\p{Script=Han}/u.test(prompt.input)); }
            catch (error) { if (error instanceof RawResearchFailure && error.code === "language_validation_failed") errorCategory = "invalid_final_language"; }
          }
          emit({ ...identity, type: "model_diagnostic", ...diagnostic, ...(errorCategory ? { errorCategory } : {}) });
        } });
        const previewFilter = new CompanyResearchRawFilter();
        const executionRequest: PiExecutionRequest = {
          requestId: request.requestId, prompt: prompt.input, systemPrompt: prompt.instructions,
          ...(prompt.finalizationInstructions === undefined ? {} : { finalizationSystemPrompt: prompt.finalizationInstructions }),
          contextMessages: [], llm: request.llm, search: request.search, toolAccess: request.toolAccess,
        };
        try {
          await rawAgent.run(executionRequest, (event) => {
            if (event.type === "text_delta") {
              const delta = previewFilter.push(event.delta);
              if (delta) emit({ ...identity, stage: "raw", type: "text_delta", delta });
            } else if (event.type === "tool_activity") {
              emit({
                ...identity,
                stage: "raw",
                type: "tool_activity",
                callKey: event.callKey,
                name: event.name,
                status: event.status,
                ...(event.summary === undefined ? {} : { summary: event.summary }),
                ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
                ...(event.agentTurnIndex === undefined ? {} : { agentTurnIndex: event.agentTurnIndex }),
                ...(event.batchId === undefined ? {} : { batchId: event.batchId }),
                ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
                ...(event.budgetConsumed === undefined ? {} : { budgetConsumed: event.budgetConsumed }),
              });
            } else if (event.type === "completed") {
              terminalSeen = true;
              terminalText = event.text;
              const tail = previewFilter.finish();
              if (tail) emit({ ...identity, stage: "raw", type: "text_delta", delta: tail });
            }
          }, signal);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("evidence_incomplete")) throw new RawResearchFailure("evidence_incomplete");
          if (error instanceof RawResearchFailure) throw error;
          const code = options.runtime.classifyError(error);
          if (code) throw new RawResearchFailure(mapPiFailure(code));
          throw new RawResearchFailure("model_failed");
        }
        if (!terminalSeen || terminalText === undefined) throw new RawResearchFailure("incomplete_response");
        const report = validateRawReport(terminalText, /\p{Script=Han}/u.test(prompt.input));
        if (collector) emit({ ...identity, stage: "raw", type: "evidence_manifest", attemptId: request.attemptId!, manifest: collector.manifest() });
        emit({ ...identity, type: "completed", text: report });
      } catch (error) {
        if (request.stage === "structure" && error !== null && typeof error === "object" && "category" in error && error.category === "context_budget") {
          emit({ ...identity, stage: "structure", type: "failed", code: "context_budget_exceeded", message: "company research structuring failed" }); return;
        }
        if (signal.aborted) emit({ ...identity, type: "cancelled" });
        else if (request.stage === "raw" && error instanceof RawResearchFailure) {
          emit({ ...identity, stage: "raw", type: "failed", code: error.code, message: "company research failed" });
        } else if (error instanceof Error && error.message.startsWith("evidence_incomplete")) {
          if (request.stage === "raw") emit({ ...identity, stage: "raw", type: "failed", code: "evidence_incomplete", message: "company research failed" });
          else emit({ ...identity, stage: "structure", type: "failed", code: "evidence_incomplete", message: "company research structuring failed" });
        } else emit({ ...identity, type: "failed", ...researchFailure(request.stage) });
      }
    },
  };
}
