import { Value } from "typebox/value";
import { Type } from "typebox";
import { AppError, type CapabilityItemId } from "@deepfield/contracts";
import type { CapabilityRegistrar, CompiledActionDeclaration, DraftRef, ViewRef } from "@deepfield/capability-sdk";
import type { CompanyResearchOperationServices } from "../main.js";
import { CAPABILITY_ID, protocolError, revision, type PreparedResearch } from "./drafts.js";
import { artifactRef } from "./task-artifact-adapter.js";
import { createActionDefinitions, PreparedResearchSchema, DraftUpdateSchema, viewDeclarations } from "./definitions.js";
import type { ResearchSubmission } from "./handlers.js";
import { createBusinessActions } from "./business-actions.js";
import { companyForms, createCompanyFormProvider } from "./form-bindings.js";

function paginate(items: unknown[], input: { limit?: number; cursor?: string }, binding: unknown) {
  let offset = 0; const key = revision(binding);
  if (input.cursor) {
    try { const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); if (decoded.key !== key || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > items.length) throw new Error(); offset = decoded.offset; }
    catch { throw new AppError("INPUT.INVALID"); }
  }
  const selected: unknown[] = []; let bytes = 0;
  while (offset < items.length && selected.length < (input.limit ?? 10)) {
    const item = items[offset]; const length = Buffer.byteLength(JSON.stringify(item));
    if (bytes + length > 24000 && selected.length) break;
    if (length > 24000) throw new AppError("INPUT.INVALID");
    selected.push(item); bytes += length; offset++;
  }
  return { items: selected, ...(offset < items.length ? { nextCursor: Buffer.from(JSON.stringify({ key, offset })).toString("base64url") } : {}) };
}
export function registerResearchProtocol(registrar: CapabilityRegistrar, services: CompanyResearchOperationServices, submission: ResearchSubmission, declarations: CompiledActionDeclaration[]): void {
  if (!registrar.registerAction || !registrar.registerTaskProvider || !registrar.registerArtifactProvider || !registrar.registerViewProvider) throw new Error("incompatible_host_services");
  const requireTarget = (itemId: string, companyId: string) => {
    if (!services.industryResearch.listCompanies(itemId as CapabilityItemId).some(company => company.id === companyId)) throw protocolError("not_found");
  };
  const forms = createCompanyFormProvider(submission.drafts, (actionId, input) => {
    const copy = business.present(actionId, input);
    return `${copy.title}\n${copy.fields.map(field => `${field.label}：${field.value}`).join("\n")}`;
  });
  const business = createBusinessActions(services, forms.retainRecognition);
  registrar.registerFormProvider?.(companyForms, forms);
  const presentResult = (id: string, input: any, value: unknown) => {
    const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
    try { return business.resultPresentation(id, input, typeof data.summary === "string" ? data.summary : typeof data.message === "string" ? data.message : "操作已完成。", data); }
    catch { return undefined; }
  };
  const presentAccepted = (id: string, input: any) => {
    try { const pending = business.operation(id, input); return pending ? { ...pending, text: id === "research.submitBatch" ? "批量调研已加入队列，实际进度将在这里更新。" : "公司调研已加入队列，实际进度将在这里更新。" } : undefined; }
    catch { return undefined; }
  };
  const withPresentation = <T extends object>(outcome: T, presentation: ReturnType<typeof presentResult>): T & { presentation?: NonNullable<typeof presentation> } => presentation ? { ...outcome, presentation } : outcome;
  const definitions = createActionDefinitions(async (id, input, context) => {
    if (id === "research.prepare") { const data = submission.drafts.prepare(input); return withPresentation({ status: "completed", data, viewRefs: [{ capabilityId: CAPABILITY_ID, viewId: "research-draft", input: { draftId: data.draftRef.draftId, revision: data.draftRef.revision } }] }, presentResult(id, input, data)); }
    if (id === "research.submit") { const task = await submission.submit(input, context.invocationId); return withPresentation({ status: "accepted", taskRef: task.taskRef, taskStatus: task.status }, presentAccepted(id, input)); }
    if (id === "research.submitBatch") { const task = await submission.submitBatch(input.itemId, input.entries, context.invocationId); return withPresentation({ status: "accepted", taskRef: task.taskRef, taskStatus: task.status }, presentAccepted(id, input)); }
    if (id === "research.retryFailed" || id === "research.retryStructuring") {
      requireTarget(input.itemId, input.companyId);
      const run = services.companyResearch.getRun(input.itemId, input.companyId, input.runId);
      if (!run || run.schemaVersion !== "company-research-report-v1") throw protocolError("not_found");
      const retryInput = id === "research.retryFailed" ? input.input : { direction: run.direction, asOfDate: run.asOfDate, ...(run.focusScope ? { focusScope: run.focusScope } : {}) };
      const task = await submission.submitBatch(input.itemId, [{ companyId: input.companyId, input: retryInput }], context.invocationId, { runId: input.runId, structureOnly: id === "research.retryStructuring" });
      return withPresentation({ status: "accepted", taskRef: task.taskRef, taskStatus: task.status }, presentAccepted(id, input));
    }
    if (id === "topics.list") return { status: "completed", data: paginate(services.industryResearch.listItems().map(({ id, industry, researchScope }) => ({ id, industry, researchScope })), input, [id]), viewRefs: [{ capabilityId: CAPABILITY_ID, viewId: "topics", input: {} }] };
    if (id === "companies.list") return { status: "completed", data: paginate(services.industryResearch.listCompanies(input.itemId).map(({ id, name, profileStatus, profileIssue, reportSummary, note }) => ({ id, name, profileStatus, profileIssue, reportSummary, note })), input, [id, input.itemId]), viewRefs: [{ capabilityId: CAPABILITY_ID, viewId: "companies", input: { itemId: input.itemId } }] };
    if (id === "queue.get") {
      const state = services.companyResearchBatch.getState(input.itemId);
      if (!state) return { status: "completed", data: { message: "当前没有调研队列。", summary: "当前没有调研队列。", item: null } };
      const page = paginate(state.entries.map(entry => ({ entryId: entry.entryId, itemId: entry.itemId, companyId: entry.companyId, companyName: business.company(entry.itemId ?? state.itemId, entry.companyId).name, status: entry.status, stage: entry.stage, runId: entry.runId, issue: entry.issue })), input, [id, state.batchId, state.total]);
      const message = `当前全局调研队列：${state.status}，共 ${state.total} 条，完成 ${state.succeeded} 条，失败 ${state.failed} 条。`;
      return { status: "completed", data: { message, summary: message, item: { batchId: state.batchId, status: state.status, total: state.total, processed: state.processed, succeeded: state.succeeded, failed: state.failed }, ...page } };
    }
    const direct = await business.handle(id, input);
    if (direct) return withPresentation(direct, presentResult(id, input, direct.data));
    if (id !== "reports.list") throw protocolError("not_found");
    requireTarget(input.itemId, input.companyId);
    const reports = services.companyResearch.listRuns(input.itemId, input.companyId).map(summary => {
      const run = services.companyResearch.getRun(input.itemId, input.companyId, summary.id)!;
      return { ...summary, artifactRef: artifactRef(run), viewRef: { capabilityId: CAPABILITY_ID, viewId: "report", input: { itemId: run.itemId, companyId: run.companyId, runId: run.id, revision: artifactRef(run).revision } } };
    });
    const page = paginate(reports, input, [id, input.itemId, input.companyId]);
    return { status: "completed", data: page, viewRefs: (page.items as typeof reports).map(report => report.viewRef) };
  }, business.present, business.operation);
  for (const definition of definitions) {
    const declaration = declarations.find(item => item.id === definition.id);
    if (!declaration) throw new Error("missing_action_declaration");
    registrar.registerAction({ definition, declaration });
  }
  const adapter = submission.adapter;
  registrar.registerTaskProvider({ permissions: { read: ["read"], cancel: ["cancel"] }, get: async ref => adapter.snapshot(ref.taskId), cancel: ref => adapter.cancel(ref.taskId), findByInvocation: async id => adapter.find(id), subscribe: listener => adapter.subscribe(listener) });
  registrar.registerArtifactProvider({ permissions: { read: ["read"] }, read: async (ref, request) => adapter.read(ref, request) });
  registrar.registerViewProvider({ resolve: async (target: ViewRef | DraftRef) => {
    try {
      if (target.capabilityId !== CAPABILITY_ID) return { status: "not_found" };
      let view: ViewRef = "draftId" in target ? { capabilityId: CAPABILITY_ID, viewId: "research-draft", input: { draftId: target.draftId, revision: target.revision } } : target;
      if ("draftId" in target) { try { view = (await forms.read(target)).view; } catch { /* Legacy research draft. */ } }
      if (view.viewId === "topic-preview") return { status: "not_found" };
      const declaration = viewDeclarations.find(item => item.id === view.viewId);
      if (!declaration) return { status: "unsupported" };
      if (!Value.Check(declaration.inputSchema, view.input)) return { status: "not_found" };
      const input = view.input as Record<string, string>;
      if (view.viewId === "research-draft") submission.drafts.get({ capabilityId: CAPABILITY_ID, draftId: input.draftId!, revision: input.revision! });
      else if (view.viewId === "form") {
        const form = await forms.read({ capabilityId: CAPABILITY_ID, draftId: input.draftId!, revision: input.revision! });
        if (form.parentView) view = form.parentView;
      }
      else if (view.viewId !== "topics") {
        if (view.viewId === "companies") {
          if (!services.industryResearch.getItem(input.itemId as CapabilityItemId)) return { status: "not_found" };
        } else requireTarget(input.itemId!, input.companyId!);
        if (view.viewId === "report") {
          const run = services.companyResearch.getRun(input.itemId!, input.companyId!, input.runId!);
          if (!run) return { status: "not_found" };
          if (artifactRef(run).revision !== input.revision) return { status: "blocked", message: "报告内容已更新，请重新读取报告引用。" };
        }
      }
      return { status: "resolved", view };
    } catch (error) { return (error as { code?: string }).code === "revision_changed" ? { status: "blocked", message: "草稿已修改，请刷新草稿。" } : { status: "not_found" }; }
  } });
  // Private UI operations return finite conflict results, preserving human form text
  // through the old IPC AppError mapper without broadening that shared mechanism.
  const draftResult = Type.Object({ ok: Type.Boolean(), prepared: Type.Optional(PreparedResearchSchema), code: Type.Optional(Type.String()) }, { additionalProperties: false });
  const safe = async (work: () => PreparedResearch) => { try { return { ok: true, prepared: work() }; } catch (error) { const code = (error as { code?: string }).code; if (code && ["revision_changed", "not_found", "expired"].includes(code)) return { ok: false, code }; throw error; } };
  const refSchema = PreparedResearchSchema.properties.draftRef;
  registrar.register("researchDraft.get", Type.Tuple([refSchema]), draftResult, ([ref]) => safe(() => { const { draftRef, parameters } = submission.drafts.get(ref); return { draftRef, parameters }; }));
  registrar.register("researchDraft.invalidate", Type.Tuple([refSchema]), draftResult, ([ref]) => safe(() => submission.drafts.invalidate(ref)));
  registrar.register("researchDraft.update", Type.Tuple([DraftUpdateSchema]), draftResult, ([input]) => safe(() => submission.drafts.update(input.draftRef, input.parameters)));
  registrar.register("researchDraft.submit", Type.Tuple([PreparedResearchSchema]), Type.Object({ ok: Type.Boolean(), code: Type.Optional(Type.String()) }, { additionalProperties: false }), async ([input]) => {
    try { await submission.submit(input, `ui:${crypto.randomUUID()}`); return { ok: true }; }
    catch (error) { const code = (error as { code?: string }).code; if (code && ["revision_changed", "not_found", "expired"].includes(code)) return { ok: false, code }; throw error; }
  });
}
