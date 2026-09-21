import type { CapabilityItemId } from "@deepfield/contracts";
import { createResourceScope } from "@deepfield/capability-sdk";
import type {
  CompanyProfileCompleter, CompanyRecognizer, CompanyResearchWorkerPort,
  IndustryResearchServiceRepositories, CompanyResearchServiceRepositories,
  CompanyResearchBatchServiceRepositories, ProfileRepository, RuntimeProfileResolver,
  RequestIdFactory,
} from "../host-ports.js";
import { CompanyResearchService } from "./company-research-service.js";
import { CompanyResearchBatchService } from "./company-research-batch-service.js";
import { CompanyProfileEnrichmentService } from "./company-profile-enrichment-service.js";
import { IndustryResearchService } from "./industry-research-service.js";

export interface CompanyResearchServicesPorts {
  repositories: IndustryResearchServiceRepositories & CompanyResearchServiceRepositories
    & CompanyResearchBatchServiceRepositories & { companies: ProfileRepository };
  profiles: RuntimeProfileResolver;
  worker: CompanyResearchWorkerPort;
  companyRecognizer: CompanyRecognizer;
  companyCompleter: CompanyProfileCompleter;
  requestIdFactory: RequestIdFactory;
}

/** Owns business startup and subscriptions; disposal preserves persisted work for recovery. */
export function createCompanyResearchServices(ports: CompanyResearchServicesPorts, options: { deferStart?: boolean } = {}) {
  const scope = createResourceScope();
  try {
    const repositories = ports.repositories;
    const companyResearch = new CompanyResearchService(repositories, ports.profiles, ports.worker, {
      requestIdFactory: ports.requestIdFactory,
    });
    scope.defer(() => companyResearch.dispose());
    let companyResearchBatch: CompanyResearchBatchService | undefined;
    const companyProfiles = new CompanyProfileEnrichmentService(repositories.companies, ports.companyCompleter, {
      isForegroundBusy: () => companyResearch.isRunning() || !!companyResearchBatch?.isReserved(),
      getTopicCompanyIds: itemId => repositories.itemCompanies.listByItem(itemId as CapabilityItemId).map(entry => entry.companyId),
      getTopicIds: () => repositories.capabilityItems.list().map(item => item.id),
      getResearchTopics: companyId => repositories.capabilityItems.list()
        .filter(item => repositories.itemCompanies.listByItem(item.id).some(membership => membership.companyId === companyId))
        .map(item => item.industry),
    });
    scope.defer(() => companyProfiles.dispose());
    const industryResearch = new IndustryResearchService(repositories, ports.companyRecognizer, companyProfiles);
    companyResearchBatch = new CompanyResearchBatchService(repositories, companyResearch, companyProfiles);
    const batch = companyResearchBatch;
    scope.defer(() => batch.dispose());
    scope.defer(companyResearch.subscribe(event => {
      if (event.type === "state_changed" && !companyResearch.isRunning()) companyProfiles.resume();
    }));
    let started = false;
    let disposed = false;
    const start = () => {
      if (disposed || started) return;
      started = true;
      batch.recover();
      companyProfiles.start();
    };
    if (!options.deferStart) start();
    return { industryResearch, companyResearch, companyResearchBatch, companyProfiles, start, dispose: () => {
      disposed = true;
      // Invalidate both async owners synchronously, before resource-scope awaits.
      batch.dispose();
      companyResearch.dispose();
      return scope.dispose();
    } };
  } catch (error) {
    void scope.dispose();
    throw error;
  }
}
