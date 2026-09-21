import { Type, type TSchema } from "typebox";
import type { CapabilityRegistrar } from "@deepfield/capability-sdk";
import { AppError, SettingsViewSchema, type SettingsView } from "@deepfield/contracts";
import { createCompanyResearchServices, type CompanyResearchServicesPorts } from "./application/create-services.js";
import * as C from "./contracts/index.js";
import { CapabilityItemSchema, CompanySchema, ItemCompanyViewSchema } from "./contracts/operation-results.js";
import { createCompanyResearchWordExportService, type ExportDependencies } from "./export/company-research-word-export.js";

export interface CompanyResearchMainPorts extends CompanyResearchServicesPorts {
  settings: { get(): Promise<SettingsView> };
  documentSave: Omit<ExportDependencies, "getRun">;
  onConfigurationChanged?(listener: () => void): () => void;
}

/** Owns every business subscription and delays background work until both entries succeed. */
export function activate(registrar: CapabilityRegistrar, ports: CompanyResearchMainPorts): void {
  const services = createCompanyResearchServices(ports, { deferStart: true });
  registrar.defer(services.dispose);
  registrar.onReady(services.start);
  if (ports.onConfigurationChanged) registrar.defer(ports.onConfigurationChanged(() => services.companyProfiles.configurationChanged()));
  const word = createCompanyResearchWordExportService({ ...ports.documentSave, getRun: (...args) => services.companyResearch.getRun(...args) });
  registerCompanyResearchOperations(registrar, { ...services, settings: ports.settings, companyResearchWordExport: word });
}

export type CompanyResearchOperationServices = Pick<ReturnType<typeof createCompanyResearchServices>, "industryResearch" | "companyResearch" | "companyResearchBatch" | "companyProfiles"> & { settings: { get(): Promise<SettingsView> }; companyResearchWordExport: ReturnType<typeof createCompanyResearchWordExportService> };

/** Also used by the temporary statically assembled startup until the package loader is wired. */
export function registerCompanyResearchOperations(registrar: CapabilityRegistrar, services: CompanyResearchOperationServices): void {
  const id = Type.String({ minLength: 1, maxLength: 200 });
  const ids = Type.Array(id, { minItems: 1, maxItems: 1000 });
  const empty = Type.Tuple([]);
  const one = Type.Tuple([id]);
  const two = Type.Tuple([id, id]);
  const optional = (schema: TSchema) => Type.Union([schema, Type.Undefined()]);
  const register = (namespace: string, method: string, input: TSchema, output: TSchema, call?: (...args: any[]) => unknown) => {
    const target = services[namespace as keyof CompanyResearchOperationServices] as unknown as Record<string, (...args: any[]) => unknown>;
    registrar.register(`${namespace}.${method}`, input, output, (args: unknown) => (call ?? ((...values: unknown[]) => target[method]!(...values)))(...args as unknown[]));
  };
  const industry = (method: string, input: TSchema, output: TSchema) => register("industryResearch", method, input, output);
  industry("createItem", Type.Tuple([C.CreateIndustryResearchItemInputSchema]), CapabilityItemSchema);
  industry("updateItem", Type.Tuple([id, C.UpdateIndustryResearchItemInputSchema]), CapabilityItemSchema);
  industry("deleteItem", one, Type.Undefined()); industry("deleteItems", Type.Tuple([ids]), Type.Undefined());
  industry("listItems", empty, Type.Array(CapabilityItemSchema)); industry("getItem", one, optional(CapabilityItemSchema));
  industry("listCompanies", one, Type.Array(ItemCompanyViewSchema));
  industry("updateCompany", Type.Tuple([id, C.CompanyProfileInputSchema]), CompanySchema);
  industry("addCompany", Type.Tuple([id, C.CompanyDraftSchema]), ItemCompanyViewSchema);
  industry("addCompanies", Type.Tuple([id, Type.Array(C.CompanyDraftSchema, { minItems: 1, maxItems: 1000 })]), Type.Array(ItemCompanyViewSchema));
  industry("removeCompany", two, Type.Undefined()); industry("removeCompanies", Type.Tuple([id, ids]), Type.Undefined());
  industry("recognizeCompanies", Type.Tuple([id, Type.String({ minLength: 1 })]), Type.Array(C.CompanyDraftSchema));
  industry("retryCompanyProfile", one, Type.Boolean());
  industry("confirmCompanyProfileIdentity", C.ConfirmCompanyProfileIdentityArgsSchema, Type.Boolean());
  register("industryResearch", "getCompanyProfileProgress", one, C.CompanyProfileProgressSchema, (itemId: string) => {
    if (!services.industryResearch.getItem(itemId as import("@deepfield/contracts").CapabilityItemId)) throw new AppError("RESOURCE.NOT_FOUND");
    return services.companyProfiles.getProgress(itemId as import("@deepfield/contracts").CapabilityItemId);
  });
  for (const [method, input, output] of [
    ["start", C.CompanyResearchStartArgsSchema, C.ResearchRunSchema],
    ["cancel", one, Type.Undefined()], ["getState", two, C.CompanyResearchStateSchema],
    ["listRuns", two, Type.Array(C.ResearchRunSummarySchema)],
    ["getRun", C.CompanyResearchGetRunArgsSchema, optional(C.ResearchRunSchema)],
    ["retryStructuring", C.CompanyResearchRetryStructuringArgsSchema, C.ResearchRunSchema],
    ["retryFailed", C.CompanyResearchRetryFailedArgsSchema, C.ResearchRunSchema],
    ["deleteRun", C.CompanyResearchDeleteRunArgsSchema, Type.Undefined()],
  ] as const) register("companyResearch", method, input, output);
  register("companyResearch", "exportWord", C.CompanyResearchExportArgsSchema, C.CompanyResearchWordExportResultSchema, (...args: Parameters<typeof services.companyResearchWordExport.export>) => services.companyResearchWordExport.export(...args));
  for (const [method, input, output] of [
    ["start", C.CompanyResearchBatchStartArgsSchema, C.CompanyResearchBatchStateSchema],
    ["getState", one, Type.Union([C.CompanyResearchBatchStateSchema, Type.Null()])],
    ["cancel", one, Type.Undefined()], ["resume", one, C.CompanyResearchBatchStateSchema],
  ] as const) register("companyResearchBatch", method, input, output);
  register("settings", "get", empty, SettingsViewSchema);
  for (const [topic, schema, subscribe] of [
    ["companyResearch.subscribe", C.CompanyResearchEventSchema, (listener: (event: any) => void) => services.companyResearch.subscribe(listener)],
    ["companyResearchBatch.subscribe", C.CompanyResearchBatchStateSchema, (listener: (event: any) => void) => services.companyResearchBatch.subscribe(listener)],
    ["industryResearch.subscribeCompanyProfiles", C.CompanyProfileEventSchema, (listener: (event: any) => void) => services.companyProfiles.subscribe(listener)],
    ["industryResearch.subscribeCompanyProfileProgress", C.CompanyProfileProgressSchema, (listener: (event: any) => void) => services.companyProfiles.subscribeProgress(listener)],
  ] as const) { registrar.registerTopic(topic, schema); registrar.defer(subscribe(payload => registrar.emit(topic, payload))); }
}
