import { Value } from "typebox/value";
import type {
  CapabilityItemId,
  CompanyId,
  CompanyResearchWorkerEvent,
  CompanyResearchWorkerRequest,
  CompanyResearchState,
  ResearchRun,
  ResearchRunId,
  StartCompanyResearchInput,
} from "@deepfield/contracts";
import {
  CompanyResearchWorkerEventSchema,
  DEFAULT_DEEPSEEK_MODEL_ID,
  StartCompanyResearchInputSchema,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { CompanyResearchWorkerPort, RequestIdFactory, SecretReader } from "./ports.js";
import { DEEPSEEK_KEY_NAME } from "./chat-service.js";

const SAFE_FAILED_EVENT = {
  type: "failed",
  code: "research_failed",
  message: "company research failed",
} as const;

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
  run: ResearchRun;
  requestId: string;
  draftText: string;
  startedAt: Date;
  done: Promise<void>;
}

type CompanyResearchRepositories = Omit<Repositories, "companies"> & {
  companies: Pick<Repositories["companies"], "getById">;
};

export class CompanyResearchService {
  private active: ActiveResearch | undefined;
  private readonly listeners = new Set<(event: CompanyResearchWorkerEvent) => void>();
  private readonly now: () => Date;

  constructor(
    private readonly repositories: CompanyResearchRepositories,
    private readonly secrets: SecretReader,
    private readonly worker: CompanyResearchWorkerPort,
    private readonly options: CompanyResearchServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  start(itemId: string, companyId: string, input: StartCompanyResearchInput): ResearchRun {
    if (!Value.Check(StartCompanyResearchInputSchema, input) || input.timeScope.trim().length === 0) {
      throw new CompanyResearchServiceError("invalid company research input");
    }
    if (this.active !== undefined || this.repositories.companyResearchRuns.getRunning()) {
      throw new CompanyResearchServiceError("company research is already running");
    }
    const item = this.repositories.capabilityItems.getById(itemId as CapabilityItemId);
    const company = this.repositories.companies.getById(companyId as CompanyId);
    const membership = this.repositories.itemCompanies
      .listByItem(itemId as CapabilityItemId)
      .find((entry) => entry.companyId === companyId);
    if (!item || !company || !membership) {
      throw new CompanyResearchServiceError("company research target not found");
    }
    const apiKey = this.secrets.get(DEEPSEEK_KEY_NAME);
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new CompanyResearchServiceError("deepseek api key is not configured");
    }

    let run: ResearchRun;
    try {
      run = this.repositories.companyResearchRuns.createRunning(item.id, company.id, input);
    } catch {
      throw new CompanyResearchServiceError("company research could not start");
    }
    const requestId = this.options.requestIdFactory();
    const request: CompanyResearchWorkerRequest = {
      requestId,
      kind: "company-research.run",
      runId: run.id,
      apiKey,
      modelId: DEFAULT_DEEPSEEK_MODEL_ID,
      context: {
        currentDate: formatLocalDate(this.now()),
        companyName: company.name,
        ...(company.legalName !== undefined ? { legalName: company.legalName } : {}),
        ...(company.aliases !== undefined ? { aliases: company.aliases } : {}),
        ...(company.headquarters !== undefined
          ? { headquarters: company.headquarters }
          : {}),
        ...(company.foundedAt !== undefined ? { foundedAt: company.foundedAt } : {}),
        ...(company.officialWebsite !== undefined
          ? { officialWebsite: company.officialWebsite }
          : {}),
        ...(company.stockListings !== undefined
          ? { stockListings: company.stockListings }
          : {}),
        ...(company.businessTags !== undefined
          ? { businessTags: company.businessTags }
          : {}),
        industry: item.industry,
        ...(item.researchScope !== undefined ? { researchScope: item.researchScope } : {}),
        ...(membership.note !== undefined ? { companyNote: membership.note } : {}),
        timeScope: run.timeScope,
        ...(run.customRequirements !== undefined
          ? { customRequirements: run.customRequirements }
          : {}),
      },
    };
    const active: ActiveResearch = {
      run,
      requestId,
      draftText: "",
      startedAt: this.now(),
      done: Promise.resolve(),
    };
    this.active = active;
    active.done = this.consume(active, request);
    return run;
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active;
    if (active === undefined || active.run.id !== runId) {
      throw new CompanyResearchServiceError("company research is not running");
    }
    try {
      this.worker.cancelResearch(active.requestId, active.run.id);
    } catch {
      this.failActive(active);
      return;
    }
    await active.done;
  }

  getState(itemId: string, companyId: string): CompanyResearchState {
    const completed = this.listCompleted(itemId, companyId);
    const active = this.active;
    if (active?.run.itemId !== itemId || active.run.companyId !== companyId) {
      return { completed };
    }
    return {
      active: { run: active.run, draftText: active.draftText },
      completed,
    };
  }

  listCompleted(itemId: string, companyId: string): ResearchRun[] {
    return this.repositories.companyResearchRuns.listCompleted(
      itemId as CapabilityItemId,
      companyId as CompanyId,
    );
  }

  cleanupAbandoned(): number {
    this.active = undefined;
    return this.repositories.companyResearchRuns.deleteAllRunning();
  }

  subscribe(listener: (event: CompanyResearchWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(): boolean {
    return this.active !== undefined || this.repositories.companyResearchRuns.getRunning() !== undefined;
  }

  private async consume(
    active: ActiveResearch,
    request: CompanyResearchWorkerRequest,
  ): Promise<void> {
    let terminal = false;
    try {
      const stream = this.worker.sendResearch(request);
      for await (const event of stream) {
        if (this.active !== active || terminal) return;
        if (
          !Value.Check(CompanyResearchWorkerEventSchema, event) ||
          event.requestId !== request.requestId ||
          event.runId !== request.runId
        ) {
          break;
        }
        if (event.type === "text_delta") {
          active.draftText += event.delta;
          this.emit(event);
          continue;
        }
        if (event.type === "completed") {
          try {
            this.repositories.runInTransaction(() => {
              this.repositories.companyResearchRuns.complete(
                active.run.id as ResearchRunId,
                event.text,
              );
            });
          } catch {
            break;
          }
          terminal = true;
          this.active = undefined;
          this.emit(event);
          return;
        }
        if (event.type === "failed" || event.type === "cancelled") {
          terminal = true;
          this.deleteActive(active);
          this.emit(event);
          return;
        }
        this.emit(event);
      }
    } catch {
      // Converted below to the one safe research failure shape.
    }
    if (!terminal && this.active === active) this.failActive(active);
  }

  private failActive(active: ActiveResearch): void {
    if (this.active !== active) return;
    this.deleteActive(active);
    this.emit({ requestId: active.requestId, runId: active.run.id, ...SAFE_FAILED_EVENT });
  }

  private deleteActive(active: ActiveResearch): void {
    try {
      this.repositories.companyResearchRuns.delete(active.run.id as ResearchRunId);
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private emit(event: CompanyResearchWorkerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A closed renderer cannot interrupt persistence or cleanup.
      }
    }
  }
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
