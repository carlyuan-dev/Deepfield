import { Value } from "typebox/value";
import { createHash } from "node:crypto";
import { CompanyProfileCandidateSchema, type CompanyProfileDiagnostic, type ProfileSchemaIssue, type CompanyProfileResult, type CompanyProfileWorkerRequest, type CompanyProfileWorkerEvent, type ProfileSource, type ProfileSourceRef } from "../contracts/index.js";
import { ReadWebpageOutputSchema, SearchWebOutputSchema } from "@deepfield/retrieval/output-contracts";
import type { CompanyAgentRuntime } from "./ports.js";
import { profileSchemaIssues, safeProfilePath } from "./profile-diagnostic.js";
import { CompanyProfileModelCandidateSchema, type ProfileCatalogSource } from "./company-profile-model.js";
import {
  buildCompanyProfileRepairPrompt,
  buildCompanyProfileRequestPrompt,
  companyProfileOutputInstructions as outputInstructions,
  companyProfileRepairInstructions,
} from "./company-profile-prompt.js";

const key = (ref: ProfileSourceRef): string => `${ref.kind}:${ref.url}`;
const publicUrl = (url: string): boolean => { try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; } };
type EvidenceDetail = NonNullable<CompanyProfileDiagnostic["evidenceDetail"]>;
const diagnosticUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    if (!publicUrl(raw)) return "https://invalid.invalid/";
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString().slice(0, 500);
  } catch { return "https://invalid.invalid/"; }
};
const diagnosticRef = (ref: ProfileSourceRef) => ({ url: diagnosticUrl(ref.url), urlFingerprint: createHash("sha256").update(ref.url).digest("hex").slice(0, 16), kind: ref.kind });
class ProfileFailure extends Error {
  constructor(readonly code: "search_unavailable" | "invalid_evidence" | "agent_failed",
    readonly reason: CompanyProfileDiagnostic["code"] = code === "invalid_evidence" ? "schema_invalid" : code,
    readonly phase: CompanyProfileDiagnostic["phase"] = "evidence",
    readonly path?: string, readonly schemaIssues: ProfileSchemaIssue[] = [], readonly detail?: EvidenceDetail) { super(code); }
}

/** Only called with successful registry outputs, never model text or progress events. */
export class ProfileEvidenceLedger {
  private readonly sources = new Map<string, ProfileSource>();
  private readonly ids = new Map<string, string>();
  private searched = false;
  counts() { return { searchSourceCount: [...this.sources.values()].filter((source) => source.kind === "search_snippet").length, openedSourceCount: [...this.sources.values()].filter((source) => source.kind === "opened_page").length }; }
  evidence(): ProfileCatalogSource[] { return [...this.sources.entries()].map(([sourceKey, source]) => ({ ...source, evidenceId: this.ids.get(sourceKey)! })); }
  private add(source: ProfileSource): ProfileCatalogSource {
    const sourceKey = key(source);
    if (!this.ids.has(sourceKey)) this.ids.set(sourceKey, `e${this.ids.size + 1}`);
    this.sources.set(sourceKey, source);
    return { ...source, evidenceId: this.ids.get(sourceKey)! };
  }
  requireSearch(): void { if (!this.searched) throw new ProfileFailure("search_unavailable"); }
  record(tool: string, output: unknown): ProfileCatalogSource[] {
    const recorded: ProfileCatalogSource[] = [];
    if (tool === "web_search" && Value.Check(SearchWebOutputSchema, output)) {
      for (const row of output.results) {
        if (!publicUrl(row.url) || !row.snippet.trim()) continue;
        this.searched = true;
        const source: ProfileSource = { url: row.url, kind: "search_snippet", title: row.title.trim() || row.url, excerpt: row.snippet.slice(0, 4000) };
        recorded.push(this.add(source));
      }
    }
    if (tool === "read_webpage" && Value.Check(ReadWebpageOutputSchema, output) && output.text.trim() && output.characterCount > 0 && publicUrl(output.url)) {
      const source: ProfileSource = { url: output.url, kind: "opened_page", title: output.title.trim() || output.url, excerpt: output.text.slice(0, 4000) };
      recorded.push(this.add(source));
    }
    return recorded;
  }
  validate(value: unknown): CompanyProfileResult {
    this.requireSearch();
    if (!Value.Check(CompanyProfileModelCandidateSchema, value)) {
      const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
      const identity = record?.identity && typeof record.identity === "object" ? record.identity as Record<string, unknown> : undefined;
      const emptyIdentity = Array.isArray(identity?.sources) && identity.sources.length === 0 ? "/identity/sources" : undefined;
      const fieldEvidence = record?.fieldEvidence && typeof record.fieldEvidence === "object" ? record.fieldEvidence as Record<string, unknown> : undefined;
      const emptyField = Object.entries(fieldEvidence ?? {}).find(([, refs]) => Array.isArray(refs) && refs.length === 0)?.[0];
      const emptyPath = emptyIdentity ?? (emptyField ? safeProfilePath(`/fieldEvidence/${emptyField}`) : undefined);
      const detail = emptyPath ? this.detail("empty_refs", emptyPath) : undefined;
      throw new ProfileFailure("invalid_evidence", "schema_invalid", "schema", undefined, profileSchemaIssues(value, CompanyProfileModelCandidateSchema), detail);
    }
    const catalog = new Map(this.evidence().map(source => [source.evidenceId, source]));
    const resolve = (refs: typeof value.identity.sources, path: string): ProfileSourceRef[] => refs.map(ref => {
      if (!("evidenceId" in ref)) return ref;
      const source = catalog.get(ref.evidenceId);
      if (!source) throw new ProfileFailure("invalid_evidence", "source_missing", "evidence", path, [], this.detail("url_absent", path));
      return { url: source.url, kind: source.kind };
    });
    const identitySources = resolve(value.identity.sources, "/identity/sources");
    const normalized = {
      identity: value.identity.disposition === "matched"
        ? value.identity.subjectType === "company"
          ? { disposition: "matched" as const, matchedName: value.identity.matchedName, reason: value.identity.reason, sources: identitySources }
          : { disposition: "unresolved" as const, reason: `目前仅确认品牌或产品，尚未核实负责相关业务的公司主体。${value.identity.reason}`.slice(0, 4000), sources: identitySources }
        : { ...value.identity, sources: identitySources },
      fields: value.identity.disposition === "matched" && value.identity.subjectType !== "company" ? {} : value.fields,
      fieldEvidence: value.identity.disposition === "matched" && value.identity.subjectType !== "company" ? {} : Object.fromEntries(Object.entries(value.fieldEvidence).map(([field, refs]) => [field, resolve(refs!, safeProfilePath(`/fieldEvidence/${field}`))])),
    };
    if (!Value.Check(CompanyProfileCandidateSchema, normalized)) throw new ProfileFailure("invalid_evidence", "schema_invalid", "schema");
    return this.validateResolved(normalized);
  }
  private validateResolved(value: import("typebox").Static<typeof CompanyProfileCandidateSchema>): CompanyProfileResult {
    const referenced = new Set<string>();
    const verify = (refs: ProfileSourceRef[], path: string): void => {
      if (!refs.length) throw new ProfileFailure("invalid_evidence", "source_missing", "evidence", path, [], this.detail("empty_refs", path));
      for (const ref of refs) {
        if (!this.sources.has(key(ref))) {
          const mismatch = [...this.sources.values()].some((source) => source.url === ref.url);
          throw new ProfileFailure("invalid_evidence", mismatch ? "kind_mismatch" : "source_missing", "evidence", path, [], this.detail(mismatch ? "kind_mismatch" : "url_absent", path, ref));
        }
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
  private detail(reason: EvidenceDetail["reason"], path: string, modelRef?: ProfileSourceRef): EvidenceDetail {
    const allCandidates = [...this.sources.values()].filter((source) => reason !== "kind_mismatch" || source.url === modelRef?.url);
    const candidates = allCandidates.slice(0, 40);
    return { reason, path, ...(modelRef ? { modelRef: diagnosticRef(modelRef) } : {}),
      actualSources: candidates.map(diagnosticRef), totalSourceCount: allCandidates.length, truncated: allCandidates.length > candidates.length };
  }
}

export interface CompanyProfileAgent {
  run(request: CompanyProfileWorkerRequest, emit: (event: CompanyProfileWorkerEvent) => void, signal: AbortSignal): Promise<void>;
}
function parseCandidate(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")); }
  catch { throw new ProfileFailure("invalid_evidence", "json_parse", "json_parse"); }
}

function repairable(error: unknown): error is ProfileFailure {
  return error instanceof ProfileFailure && ["json_parse", "schema_invalid", "source_missing", "kind_mismatch"].includes(error.reason);
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
        ...(error instanceof ProfileFailure && error.detail !== undefined ? { evidenceDetail: error.detail } : {}),
        ...ledger.counts(), searchToolCalls, readToolCalls, outputChars,
        ...(options.runtime.classifyError(error) ? { piError: options.runtime.classifyError(error)! } : {}),
        ...(formatRepair === undefined ? {} : { formatRepair }),
        ...(model === undefined ? {} : { model }) });
    };
    try {
      let text: string | undefined;
      let toolEvidence: ProfileCatalogSource[] = [];
      const agent = options.runtime.createAgent({
        diagnostic: value => { const { traceId: _traceId, ...safeModel } = value; model = safeModel; },
        allowedTools: ["web_search", "read_webpage", "get_current_datetime"],
        onToolOutput: (name, output) => { if (name === "web_search") searchToolCalls += 1; if (name === "read_webpage") readToolCalls += 1; toolEvidence = ledger.record(name, output); },
        toolOutputContext: () => toolEvidence.length
          ? JSON.stringify({ collectedEvidence: toolEvidence.map(({ evidenceId, url, kind }) => ({ evidenceId, url, kind })) }) : undefined,
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
            validationFeedback: { code: firstError.reason, schemaIssues: firstError.schemaIssues, ...(firstError.path ? { path: firstError.path } : {}) },
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
