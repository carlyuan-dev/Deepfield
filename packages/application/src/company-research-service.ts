import { Value } from "typebox/value";
import {
  CompanyResearchWorkerEventSchema,
  StartCompanyResearchInputSchema,
  STRUCTURED_RESEARCH_OUTPUT_SCHEMA,
  getCompanyResearchTemplate,
  type CapabilityItemId,
  type CompanyId,
  type CompanyResearchContext,
  type CompanyResearchEvent,
  type CompanyResearchStage,
  type CompanyResearchState,
  type CompanyResearchWorkerRequest,
  type KeyResearchRun,
  type ResearchRun,
  type ResearchRunId,
  type ResearchRunSummary,
  type StartCompanyResearchInput,
  type LlmRuntimeSnapshot,
  type SearchRuntimeSnapshot,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { CompanyResearchWorkerPort, RequestIdFactory, RuntimeProfileResolver } from "./ports.js";
import { validateStructuredResearch } from "./company-research-harness.js";

export class CompanyResearchServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyResearchServiceError";
  }
}

export interface CompanyResearchServiceOptions {
  requestIdFactory: RequestIdFactory;
  now?: () => Date;
}

interface ActiveResearch {
  run: KeyResearchRun;
  requestId: string;
  stage: CompanyResearchStage;
  rawDraftText: string;
  dispatched: boolean;
  cancelRequested: boolean;
  done: Promise<void>;
  llm: LlmRuntimeSnapshot;
  search?: SearchRuntimeSnapshot;
  latestActivity?: Extract<CompanyResearchEvent, { type: "tool_activity" }>;
}

type ResearchFailureOutcome = Exclude<NonNullable<Extract<CompanyResearchEvent, { type: "state_changed" }>['outcome']>, "cancelled">;
type ResearchOutcome = ResearchFailureOutcome | "cancelled";

class ResearchConsumeFailure extends Error {
  constructor(readonly outcome: ResearchFailureOutcome) { super(outcome); }
}

export const RAW_RESEARCH_POLICY = { network: "enabled", maxAgentTurns: 12, maxSearchCalls: 8, maxFetchCalls: 8 } as const;
export const STRUCTURE_RESEARCH_POLICY = { network: "disabled", maxAgentTurns: 1, maxSearchCalls: 0, maxFetchCalls: 0 } as const;

type CompanyResearchRepositories = Omit<Repositories, "companies"> & {
  companies: Pick<Repositories["companies"], "getById">;
};

export class CompanyResearchService {
  private active: ActiveResearch | undefined;
  private starting = false;
  private readonly listeners = new Set<(event: CompanyResearchEvent) => void>();
  private readonly now: () => Date;

  constructor(
    private readonly repositories: CompanyResearchRepositories,
    private readonly profiles: RuntimeProfileResolver,
    private readonly worker: CompanyResearchWorkerPort,
    private readonly options: CompanyResearchServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async start(itemId: string, companyId: string, input: StartCompanyResearchInput): Promise<KeyResearchRun> {
    const today = formatLocalDate(this.now());
    if (!Value.Check(StartCompanyResearchInputSchema, input) || !isRealDate(input.asOfDate) || input.asOfDate > today) {
      throw new CompanyResearchServiceError("invalid company research input");
    }
    this.requireAvailable();
    const { item, company, membership } = this.requireTarget(itemId, companyId);
    this.starting = true;
    try {
      let llm: LlmRuntimeSnapshot; let search: SearchRuntimeSnapshot;
      try { [llm, search] = await Promise.all([this.profiles.resolveActiveLlm(), this.profiles.resolveActiveSearch()]); }
      catch { throw new CompanyResearchServiceError("请先配置并启用 LLM 与 Search Profile"); }
      const focusScope = input.focusScope?.trim();
      const normalized: StartCompanyResearchInput = {
        direction: input.direction, asOfDate: input.asOfDate,
        ...(focusScope ? { focusScope } : {}),
      };
      const context: CompanyResearchContext = {
        ...normalized,
        currentDate: today,
        companyName: company.name,
        ...(company.legalName !== undefined ? { legalName: company.legalName } : {}),
        ...(company.aliases !== undefined ? { aliases: company.aliases } : {}),
        ...(company.headquarters !== undefined ? { headquarters: company.headquarters } : {}),
        ...(company.foundedAt !== undefined ? { foundedAt: company.foundedAt } : {}),
        ...(company.officialWebsite !== undefined ? { officialWebsite: company.officialWebsite } : {}),
        ...(company.stockListings !== undefined ? { stockListings: company.stockListings } : {}),
        ...(company.businessTags !== undefined ? { businessTags: company.businessTags } : {}),
        topicName: item.industry,
        ...(item.researchScope !== undefined ? { topicScope: item.researchScope } : {}),
        ...(membership.note !== undefined ? { companyNote: membership.note } : {}),
      };
      try {
        const requestId = this.options.requestIdFactory();
        const run = this.repositories.runInTransaction(() => this.repositories.companyResearchRuns.createResearching(
          item.id, company.id, normalized, context, getCompanyResearchTemplate(input.direction),
        ));
        this.launch(run, requestId, llm, search);
        return structuredClone(run);
      } catch {
        throw new CompanyResearchServiceError("company research could not start");
      }
    } finally {
      this.starting = false;
    }
  }

  async retryStructuring(itemId: string, companyId: string, runId: string): Promise<KeyResearchRun> {
    this.requireAvailable();
    const saved = this.getRun(itemId, companyId, runId);
    if (saved?.schemaVersion !== "company-research-report-v1" || saved.status !== "structure_failed") {
      throw new CompanyResearchServiceError("company research cannot be restructured");
    }
    let llm: LlmRuntimeSnapshot;
    try { llm = await this.profiles.resolveActiveLlm(); }
    catch { throw new CompanyResearchServiceError("请先配置并启用 LLM Profile"); }
    try {
      const requestId = this.options.requestIdFactory();
      const run = this.repositories.runInTransaction(() => this.repositories.companyResearchRuns.retryStructuring(saved.id));
      this.launch(run, requestId, llm);
      return structuredClone(run);
    } catch {
      throw new CompanyResearchServiceError("company research could not retry structuring");
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active;
    if (active === undefined || active.run.id !== runId) {
      throw new CompanyResearchServiceError("company research is not running");
    }
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      // Start listeners and raw-persistence listeners can cancel before dispatch.
      if (!active.dispatched) {
        this.failActive(active, "cancelled");
      } else {
        try {
          this.worker.cancelResearch(active.requestId, active.run.id, active.stage);
        } catch {
          this.failActive(active, "cancelled");
          return;
        }
      }
    }
    await active.done;
  }

  getState(itemId: string, companyId: string): CompanyResearchState {
    this.requireTarget(itemId, companyId);
    return this.read(() => {
      const active = this.repositories.companyResearchRuns.getActive();
      const reserved = this.active;
      const state: CompanyResearchState = {
        runs: this.repositories.companyResearchRuns.listRuns(itemId as CapabilityItemId, companyId as CompanyId),
        // Target deletion can cascade the row away while its Worker is still
        // running. Public occupancy must describe the same reservation as isRunning.
        globalActiveRun: reserved ? {
          runId: reserved.run.id, itemId: reserved.run.itemId, companyId: reserved.run.companyId, stage: reserved.stage,
        } : active ? {
          runId: active.id, itemId: active.itemId, companyId: active.companyId,
          stage: active.status === "researching" ? "raw" : "structure",
        } : null,
      };
      if (active?.itemId === itemId && active.companyId === companyId) {
        const latest = this.active?.run.id === active.id ? this.active.latestActivity : undefined;
        state.active = {
          run: active,
          draftText: this.active?.run.id === active.id ? this.active.rawDraftText : "",
          ...(latest === undefined ? {} : { latestActivity: {
            callKey: latest.callKey, name: latest.name, status: latest.status,
            ...(latest.summary === undefined ? {} : { summary: latest.summary }),
            ...(latest.errorCode === undefined ? {} : { errorCode: latest.errorCode }),
          } }),
        };
      }
      return state;
    });
  }

  listRuns(itemId: string, companyId: string): ResearchRunSummary[] {
    this.requireTarget(itemId, companyId);
    return this.read(() => this.repositories.companyResearchRuns.listRuns(itemId as CapabilityItemId, companyId as CompanyId));
  }

  getRun(itemId: string, companyId: string, runId: string): ResearchRun | undefined {
    this.requireTarget(itemId, companyId);
    return this.read(() => this.repositories.companyResearchRuns.getByIdForTarget(
      itemId as CapabilityItemId, companyId as CompanyId, runId as ResearchRunId,
    ));
  }

  cleanupAbandoned(): { deletedResearching: number; failedStructuring: number } {
    if (this.active) throw new CompanyResearchServiceError("company research is already running");
    return this.read(() => this.repositories.companyResearchRuns.recoverAbandoned());
  }

  subscribe(listener: (event: CompanyResearchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(): boolean {
    return this.starting || this.active !== undefined || this.read(() => this.repositories.companyResearchRuns.getActive()) !== undefined;
  }

  private requireAvailable(): void {
    if (this.isRunning()) throw new CompanyResearchServiceError("company research is already running");
  }

  private requireTarget(itemId: string, companyId: string) {
    return this.read(() => {
      const item = this.repositories.capabilityItems.getById(itemId as CapabilityItemId);
      const company = this.repositories.companies.getById(companyId as CompanyId);
      const membership = this.repositories.itemCompanies.listByItem(itemId as CapabilityItemId)
        .find((entry) => entry.companyId === companyId);
      if (!item || !company || !membership) throw new CompanyResearchServiceError("company research target not found");
      return { item, company, membership };
    });
  }

  private read<T>(work: () => T): T {
    try { return work(); } catch (error) {
      if (error instanceof CompanyResearchServiceError) throw error;
      throw new CompanyResearchServiceError("company research report could not be read");
    }
  }

  private launch(run: KeyResearchRun, requestId: string, llm: LlmRuntimeSnapshot, search?: SearchRuntimeSnapshot): void {
    const active: ActiveResearch = {
      run: structuredClone(run), requestId, stage: run.status === "researching" ? "raw" : "structure",
      rawDraftText: "", dispatched: false, cancelRequested: false, done: Promise.resolve(),
      llm: structuredClone(llm), ...(search === undefined ? {} : { search: structuredClone(search) }),
    };
    this.active = active;
    // Install done before notifying listeners, so synchronous cancellation is safe.
    active.done = Promise.resolve().then(() => this.consume(active));
    this.stateChanged(active.run);
  }

  private request(active: ActiveResearch): CompanyResearchWorkerRequest {
    const common = {
      requestId: active.requestId, runId: active.run.id, llm: structuredClone(active.llm),
      context: structuredClone(active.run.researchContext), template: structuredClone(active.run.template),
    };
    if (active.stage === "raw") return { ...common, kind: "company-research.raw.run", stage: "raw", search: structuredClone(active.search!), toolAccess: RAW_RESEARCH_POLICY };
    return {
      ...common, kind: "company-research.structure.run", stage: "structure",
      rawReportText: active.run.rawReportText!, outputSchema: STRUCTURED_RESEARCH_OUTPUT_SCHEMA, toolAccess: STRUCTURE_RESEARCH_POLICY,
    };
  }

  private async consume(active: ActiveResearch): Promise<void> {
    let failureOutcome: ResearchOutcome | undefined;
    try {
      while (this.active === active) {
        const request = this.request(active);
        active.dispatched = true;
        let rawCompleted = false;
        for await (const event of this.worker.sendResearch(request)) {
          if (this.active !== active) return;
          if (active.cancelRequested) { this.failActive(active, "cancelled"); return; }
          // Foreign/late identities cannot terminate or mutate the current stage.
          if (event !== null && typeof event === "object" && (
            event.requestId !== request.requestId || event.runId !== request.runId || event.stage !== request.stage
          )) continue;
          if (!Value.Check(CompanyResearchWorkerEventSchema, event)) throw new ResearchConsumeFailure("protocol_error");
          if (event.type === "started") continue;
          if (event.type === "text_delta") {
            if (active.rawDraftText.length + event.delta.length > 1_000_000) throw new ResearchConsumeFailure("protocol_error");
            active.rawDraftText += event.delta;
            this.emit(event);
          } else if (event.type === "tool_activity") {
            active.latestActivity = structuredClone(event);
            this.emit(event);
          } else if (event.type === "completed") {
            if (active.stage === "raw") {
              try {
                active.run = this.repositories.runInTransaction(() => this.repositories.companyResearchRuns.completeRaw(active.run.id, event.text));
              } catch { throw new ResearchConsumeFailure("storage_failed"); }
              active.stage = "structure";
              active.dispatched = false;
              active.rawDraftText = "";
              delete active.latestActivity;
              rawCompleted = true;
              this.stateChanged(active.run);
              // A listener may cancel at the durable boundary. Keep the reservation
              // across it and generate a distinct transport identity only afterward.
              if (this.active === active) active.requestId = this.options.requestIdFactory();
              break;
            }
            const content = validateStructuredResearch(event.text, active.run.rawReportText!, active.run.template);
            try {
              active.run = this.repositories.runInTransaction(() => this.repositories.companyResearchRuns.completeStructured(active.run.id, content));
            } catch { throw new ResearchConsumeFailure("storage_failed"); }
            this.active = undefined;
            this.stateChanged(active.run);
            return;
          } else {
            this.failActive(active, event.type === "cancelled" ? "cancelled" : event.code as ResearchFailureOutcome);
            return;
          }
        }
        if (!rawCompleted) break;
      }
    } catch (error) {
      // No provider/candidate/storage exception crosses the application boundary.
      failureOutcome = error instanceof ResearchConsumeFailure
        ? error.outcome
        : active.stage === "raw" ? "protocol_error" : "research_failed";
    }
    this.failActive(active, active.cancelRequested ? "cancelled" : failureOutcome ?? (active.stage === "raw" ? "incomplete_response" : "research_failed"));
  }

  private failActive(active: ActiveResearch, outcome: ResearchOutcome): void {
    if (this.active !== active) return;
    let persisted = false;
    let deletedRaw = false;
    let targetGone = false;
    try {
      this.repositories.runInTransaction(() => {
        const { id, itemId, companyId } = active.run;
        // A removed target has already durably deleted the run. There is no
        // transition left to perform, but releasing its reservation still notifies
        // other targets and wakes the profile queue.
        if (!this.repositories.companyResearchRuns.getByIdForTarget(itemId, companyId, id)) { targetGone = true; return; }
        if (active.stage === "raw") {
          this.repositories.companyResearchRuns.deleteResearching(id);
          deletedRaw = true;
        } else this.repositories.companyResearchRuns.failStructuring(id);
      });
      persisted = true;
    } catch {
      // If storage is unavailable, startup recovery owns the abandoned row.
      // getActive continues to reserve it; never announce an uncommitted transition.
    } finally {
      this.active = undefined;
    }
    if (persisted) this.stateChanged(active.run, targetGone || (!deletedRaw && outcome !== "storage_failed") ? undefined : outcome);
  }

  private stateChanged(run: KeyResearchRun, outcome?: ResearchOutcome): void {
    this.emit({
      type: "state_changed", itemId: run.itemId, companyId: run.companyId, runId: run.id,
      ...(outcome === undefined ? {} : { outcome }),
    });
  }

  private emit(event: CompanyResearchEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(structuredClone(event)); } catch {
        // Renderer lifecycle or reentrant listeners cannot interrupt orchestration.
      }
    }
  }
}

function formatLocalDate(value: Date): string {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}
