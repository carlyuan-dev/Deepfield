import type { BatchResearchEntryInput, CompanyResearchBatchState, CompanyProfileProgress } from "./batch-research.js";
import type {
  CapabilityItem,
  Company,
  CompanyDraft,
  CompanyProfileInput,
  CompanyProfileEvent,
  CompanyProfileIdentityHint,
  CreateIndustryResearchItemInput,
  ItemCompanyView,
  UpdateIndustryResearchItemInput,
} from "./capability-items.js";
import type {
  CompanyResearchState,
  CompanyResearchEvent,
  ResearchRun,
  ResearchRunSummary,
  StartCompanyResearchInput,
} from "./research.js";
import type { SettingsView } from "../../../packages/contracts/src/settings.js";

import type { CompanyResearchWordExportSelection, CompanyResearchWordExportResult } from "./ipc.js";

export interface CompanyResearchApi {
  industryResearch: {
    getCompanyProfileProgress(itemId: string): Promise<CompanyProfileProgress>;
    subscribeCompanyProfileProgress(listener: (state: CompanyProfileProgress) => void): () => void;
    createItem(input: CreateIndustryResearchItemInput): Promise<CapabilityItem>;
    updateItem(itemId: string, input: UpdateIndustryResearchItemInput): Promise<CapabilityItem>;
    deleteItem(itemId: string): Promise<void>;
    deleteItems(itemIds: string[]): Promise<void>;
    listItems(): Promise<CapabilityItem[]>;
    getItem(itemId: string): Promise<CapabilityItem | undefined>;
    listCompanies(itemId: string): Promise<ItemCompanyView[]>;
    updateCompany(companyId: string, input: CompanyProfileInput): Promise<Company>;
    addCompany(itemId: string, draft: CompanyDraft): Promise<ItemCompanyView>;
    addCompanies(itemId: string, drafts: CompanyDraft[]): Promise<ItemCompanyView[]>;
    removeCompany(itemId: string, companyId: string): Promise<void>;
    removeCompanies(itemId: string, companyIds: string[]): Promise<void>;
    recognizeCompanies(itemId: string, text: string): Promise<CompanyDraft[]>;
    retryCompanyProfile(companyId: string): Promise<boolean>;
    confirmCompanyProfileIdentity(companyId: string, hint: CompanyProfileIdentityHint): Promise<boolean>;
    subscribeCompanyProfiles(listener: (event: CompanyProfileEvent) => void): () => void;
  };
  companyResearch: {
    start(
      itemId: string,
      companyId: string,
      input: StartCompanyResearchInput,
    ): Promise<CompanyResearchBatchState | ResearchRun>;
    cancel(runId: string): Promise<void>;
    getState(itemId: string, companyId: string): Promise<CompanyResearchState>;
    listRuns(itemId: string, companyId: string): Promise<ResearchRunSummary[]>;
    getRun(itemId: string, companyId: string, runId: string): Promise<ResearchRun | undefined>;
    exportWord(itemId: string, companyId: string, runId: string, selection: CompanyResearchWordExportSelection): Promise<CompanyResearchWordExportResult>;
    retryStructuring(itemId: string, companyId: string, runId: string): Promise<CompanyResearchBatchState | ResearchRun>;
    retryFailed(
      itemId: string,
      companyId: string,
      runId: string,
      input: StartCompanyResearchInput,
    ): Promise<CompanyResearchBatchState | ResearchRun>;
    deleteRun(itemId: string, companyId: string, runId: string): Promise<void>;
    subscribe(listener: (event: CompanyResearchEvent) => void): () => void;
  };
  companyResearchBatch: {
    start(itemId: string, entries: BatchResearchEntryInput[]): Promise<CompanyResearchBatchState>;
    getState(itemId: string): Promise<CompanyResearchBatchState | null>;
    cancel(batchId: string): Promise<void>;
    cancelEntry(entryId: string): Promise<void>;
    resume(batchId: string): Promise<CompanyResearchBatchState>;
    subscribe(listener: (state: CompanyResearchBatchState) => void): () => void;
  };
  settings: { get(): Promise<SettingsView>; };
}
