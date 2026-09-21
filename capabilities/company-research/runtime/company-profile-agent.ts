import { Value } from "typebox/value";
import { CompanyProfileCandidateSchema, type CompanyProfileDiagnostic, type ProfileSchemaIssue, type CompanyProfileResult, type CompanyProfileWorkerRequest, type CompanyProfileWorkerEvent, type ProfileSource, type ProfileSourceRef } from "../contracts/index.js";
import { ReadWebpageOutputSchema, SearchWebOutputSchema } from "@deepfield/retrieval/output-contracts";
import type { CompanyAgentRuntime } from "./ports.js";
import { profileSchemaIssues, safeProfilePath } from "./profile-diagnostic.js";
import {
  buildCompanyProfileRepairPrompt,
  buildCompanyProfileRequestPrompt,
  companyProfileOutputInstructions as outputInstructions,
  companyProfileRepairInstructions,
} from "./company-profile-prompt.js";

const key = (ref: ProfileSourceRef): string => `${ref.kind}:${ref.url}`;
const publicUrl = (url: string): boolean => { try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; } };
class ProfileFailure extends Error {
  constructor(readonly code: "search_unavailable" | "invalid_evidence" | "agent_failed",
    readonly reason: CompanyProfileDiagnostic["code"] = code === "invalid_evidence" ? "schema_invalid" : code,
    readonly phase: CompanyProfileDiagnostic["phase"] = "evidence",
    readonly path?: string, readonly schemaIssues: ProfileSchemaIssue[] = []) { super(code); }
}

/** Only called with successful registry outputs, never model text or progress events. */
export class ProfileEvidenceLedger {
  private readonly sources = new Map<string, ProfileSource>();
  private searched = false;
  counts() { return { searchSourceCount: [...this.sources.values()].filter((source) => source.kind === "search_snippet").length, openedSourceCount: [...this.sources.values()].filter((source) => source.kind === "opened_page").length }; }
  evidence(): ProfileSource[] { return [...this.sources.values()].map((source) => ({ ...source })); }
  requireSearch(): void { if (!this.searched) throw new ProfileFailure("search_unavailable"); }
  record(tool: string, output: unknown): void {
    if (tool === "web_search" && Value.Check(SearchWebOutputSchema, output)) {
      for (const row of output.results) {
        if (!publicUrl(row.url) || !row.snippet.trim()) continue;
        this.searched = true;
        const source: ProfileSource = { url: row.url, kind: "search_snippet", title: row.title.trim() || row.url, excerpt: row.snippet.slice(0, 4000) };
        this.sources.set(key(source), source);
      }
    }
    if (tool === "read_webpage" && Value.Check(ReadWebpageOutputSchema, output) && output.text.trim() && output.characterCount > 0 && publicUrl(output.url)) {
      const source: ProfileSource = { url: output.url, kind: "opened_page", title: output.title.trim() || output.url, excerpt: output.text.slice(0, 4000) };
      this.sources.set(key(source), source);
    }
  }
  validate(value: unknown): CompanyProfileResult {
    this.requireSearch();
    if (!Value.Check(CompanyProfileCandidateSchema, value)) throw new ProfileFailure("invalid_evidence", "schema_invalid", "schema", undefined, profileSchemaIssues(value));
    const referenced = new Set<string>();
    const verify = (refs: ProfileSourceRef[], path: string): void => {
      if (!refs.length) throw new ProfileFailure("invalid_evidence", "source_missing", "evidence", path);
      for (const ref of refs) {
        if (!this.sources.has(key(ref))) throw new ProfileFailure("invalid_evidence", [...this.sources.values()].some((source) => source.url === ref.url) ? "kind_mismatch" : "source_missing", "evidence", path);
        referenced.add(key(ref));
      }
    };
    verify(value.identity.sources, "/identity/sources");
    if (value.identity.disposition === "matched") {
      if (!value.identity.matchedName?.trim() || !Object.keys(value.fields).length) throw new ProfileFailure("invalid_evidence", "identity", "evidence", "/identity");
      for (const [field, fieldValue] of Object.entries(value.fields)) {
        // An explicit unknown/null/empty list is not an evidenced fact.
        if (fieldValue === null || (Array.isArray(fieldValue) && !fieldValue.length)) throw new ProfileFailure("invalid_evidence", "empty_field", "evidence", safeProfilePath(`/fields/${field}`));
        verify(value.fieldEvidence[field] ?? [], safeProfilePath(`/fieldEvidence/${field}`));
      }
      if (Object.keys(value.fieldEvidence).some((field) => !(field in value.fields))) throw new ProfileFailure("invalid_evidence", "source_missing", "evidence", "/fieldEvidence");
    } else if (Object.keys(value.fields).length || Object.keys(value.fieldEvidence).length) {
      throw new ProfileFailure("invalid_evidence", "identity", "evidence", "/identity");
    }
    return { ...value, sources: [...referenced].map((id) => this.sources.get(id)!) };
  }
}

export interface CompanyProfileAgent {
  run(request: CompanyProfileWorkerRequest, emit: (event: CompanyProfileWorkerEvent) => void, signal: AbortSignal): Promise<void>;
}
function parseCandidate(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")); }
  catch { throw new ProfileFailure("invalid_evidence", "json_parse", "json_parse"); }
}

function repairable(error: unknown): error is ProfileFailure & { reason: "json_parse" | "schema_invalid" } {
  return error instanceof ProfileFailure && (error.reason === "json_parse" || error.reason === "schema_invalid");
}

export function createCompanyProfileAgent(options: { runtime: CompanyAgentRuntime }): CompanyProfileAgent {
  const gateway = options.runtime.gateway;
  return { async run(request, emit, signal) {
    const identity = { kind: "company-profile.event" as const, requestId: request.requestId, companyId: request.companyId };
    const ledger = new ProfileEvidenceLedger();
    let model: CompanyProfileDiagnostic["model"];
    let outputChars = 0;
    let searchToolCalls = 0;
    let readToolCalls = 0;
    let formatRepair: CompanyProfileDiagnostic["formatRepair"];
    const diagnostic = (phase: CompanyProfileDiagnostic["phase"], code: CompanyProfileDiagnostic["code"], error?: unknown): void => {
      emit({ ...identity, type: "diagnostic", phase, code, schemaIssues: error instanceof ProfileFailure ? error.schemaIssues : [],
        ...(error instanceof ProfileFailure && error.path !== undefined ? { path: error.path } : {}),
        ...ledger.counts(), searchToolCalls, readToolCalls, outputChars,
        ...(options.runtime.classifyError(error) ? { piError: options.runtime.classifyError(error)! } : {}),
        ...(formatRepair === undefined ? {} : { formatRepair }),
        ...(model === undefined ? {} : { model }) });
    };
    try {
      let text: string | undefined;
      const agent = options.runtime.createAgent({
        diagnostic: value => { const { traceId: _traceId, ...safeModel } = value; model = safeModel; },
        allowedTools: ["web_search", "read_webpage", "get_current_datetime"],
        onToolOutput: (name, output) => { if (name === "web_search") searchToolCalls += 1; if (name === "read_webpage") readToolCalls += 1; ledger.record(name, output); },
      });
      await agent.run({ requestId: request.requestId,
        prompt: buildCompanyProfileRequestPrompt(request),
        contextMessages: [], systemPrompt: `${outputInstructions}\n必须先搜索真实公开信息，最多3次web_search和2次read_webpage；仅用这些工具及get_current_datetime。优先官网/登记资料。`, finalizationSystemPrompt: `${outputInstructions}\n工具已关闭，只依据本次已收集证据输出最终JSON。`,
        llm: request.llm, search: request.search,
        toolAccess: { network: "enabled", maxAgentTurns: 7, maxSearchCalls: 3, maxFetchCalls: 2 },
      }, (event) => { if (event.type === "completed") text = event.text; }, signal);
      if (signal.aborted || text === undefined) throw new ProfileFailure("agent_failed", "agent_failed", "agent");
      outputChars = text.length;
      ledger.requireSearch();
      let result: CompanyProfileResult;
      try {
        result = ledger.validate(parseCandidate(text));
      } catch (firstError) {
        if (!repairable(firstError) || signal.aborted) throw firstError;
        const repairStartedMs = Date.now();
        let repairedText: string;
        try {
          repairedText = await gateway.completeText(request.llm, companyProfileRepairInstructions, buildCompanyProfileRepairPrompt({
            request,
            evidence: ledger.evidence(),
            previousCandidate: text,
            validationFeedback: { code: firstError.reason, schemaIssues: firstError.schemaIssues },
          }), signal);
        } catch {
          formatRepair = { attempted: true, outcome: signal.aborted ? "cancelled" : "failed", durationMs: Math.max(0, Date.now() - repairStartedMs) };
          throw new ProfileFailure("agent_failed", "agent_failed", "agent");
        }
        outputChars += repairedText.length;
        if (signal.aborted) {
          formatRepair = { attempted: true, outcome: "cancelled", durationMs: Math.max(0, Date.now() - repairStartedMs) };
          throw new ProfileFailure("agent_failed", "agent_failed", "agent");
        }
        try {
          result = ledger.validate(parseCandidate(repairedText));
          formatRepair = { attempted: true, outcome: "succeeded", durationMs: Math.max(0, Date.now() - repairStartedMs) };
        } catch (repairError) {
          formatRepair = { attempted: true, outcome: "invalid", durationMs: Math.max(0, Date.now() - repairStartedMs) };
          throw repairError;
        }
      }
      if (signal.aborted) throw new ProfileFailure("agent_failed", "agent_failed", "agent");
      diagnostic("complete", "ok");
      emit({ ...identity, type: "completed", result });
    } catch (error) {
      diagnostic(error instanceof ProfileFailure ? error.phase : "agent", error instanceof ProfileFailure ? error.reason : "agent_failed", error);
      emit({ ...identity, type: "failed", code: error instanceof ProfileFailure ? error.code : "agent_failed" });
    }
  } };
}
