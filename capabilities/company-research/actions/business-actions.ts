import { AppError, type CapabilityItemId } from "@deepfield/contracts";
import type { ArtifactRef, ViewRef, OperationPresentation } from "@deepfield/capability-sdk";
import type { CompanyResearchOperationServices } from "../main.js";
import type { InputPresentation } from "./definitions.js";
import { artifactRef } from "./task-artifact-adapter.js";
import { CAPABILITY_ID, protocolError, revision } from "./drafts.js";
import { getCompanyResearchTemplate, type ResearchDirection } from "../contracts/index.js";

export function createBusinessActions(services: CompanyResearchOperationServices, retainRecognition?: (itemId: string, text: string, candidates: unknown[]) => string | undefined) {
  const industry = services.industryResearch;
  const research = services.companyResearch;
  const batch = services.companyResearchBatch;
  const topic = (itemId: string) => {
    const item = industry.getItem(itemId as CapabilityItemId);
    if (!item) throw protocolError("not_found");
    return item;
  };
  const company = (itemId: string, companyId: string) => {
    const found = industry.listCompanies(itemId as CapabilityItemId).find(candidate => candidate.id === companyId);
    if (!found) throw protocolError("not_found");
    return found;
  };
  const run = (input: { itemId: string; companyId: string; runId: string }) => {
    company(input.itemId, input.companyId);
    const found = research.getRun(input.itemId, input.companyId, input.runId);
    if (!found) throw protocolError("not_found");
    return found;
  };
  const reportLabel = (input: { itemId: string; companyId: string; runId: string }) => {
    const found = run(input);
    return `${company(input.itemId, input.companyId).name} · ${found.schemaVersion === "company-research-report-v1" ? found.template.title : "历史报告"} · ${found.createdAt.slice(0, 10)}`;
  };
  const target = (viewId: string, input: Record<string, unknown>): ViewRef => ({ capabilityId: CAPABILITY_ID, viewId, input });
  const joinNamed = (values: string[]) => values.map((value, index) => `${index + 1}. ${value}`).join("\n");
  const shortName = (value: string) => value.length <= 80 ? value : `${value.slice(0, 80)}…`;
  const field = (label: string, value: string) => ({ label, value });
  const pageValues = (values: unknown[], input: { cursor?: string; limit?: number }, binding: unknown) => {
    let offset = 0; const key = revision(binding);
    if (input.cursor) {
      try { const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); if (parsed.key !== key || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > values.length) throw new Error(); offset = parsed.offset; }
      catch { throw new AppError("INPUT.INVALID"); }
    }
    const items: unknown[] = []; let bytes = 0;
    while (offset < values.length && items.length < (input.limit ?? 10)) {
      const value = values[offset]; const size = Buffer.byteLength(JSON.stringify(value));
      if (bytes + size > 24000 && items.length) break;
      if (size > 24000) throw new AppError("INPUT.INVALID");
      items.push(value); bytes += size; offset++;
    }
    return { items, ...(offset < values.length ? { nextCursor: Buffer.from(JSON.stringify({ key, offset })).toString("base64url") } : {}) };
  };
  const directionName = (value: string) => getCompanyResearchTemplate(value as ResearchDirection).title;
  const profileLabels: Record<string, string> = { name: "公司名称", legalName: "法定名称", aliases: "别名", headquarters: "总部", foundedAt: "成立时间", officialWebsite: "官方网站", stockListings: "上市信息", businessTags: "业务标签" };
  const profileFields = (profile: Record<string, unknown>) => Object.entries(profileLabels).map(([key, label]) => {
    const value = profile[key];
    return field(label, value === undefined ? "未填写" : value === null ? "无/清空" : Array.isArray(value) ? value.length ? value.map(entry => typeof entry === "object" ? Object.values(entry).join("：") : String(entry)).join("、") : "无/清空" : String(value));
  });
  const currentProfile = (itemId: string, companyId: string) => {
    const found = company(itemId, companyId);
    return Object.fromEntries(Object.keys(profileLabels).flatMap(key => key in found ? [[key, found[key as keyof typeof found]]] : [])) as Record<string, unknown>;
  };
  const mergedProfile = (input: { itemId: string; companyId: string; expectedRevision: string; profile: Record<string, unknown> }) => {
    const current = currentProfile(input.itemId, input.companyId);
    if (revision(current) !== input.expectedRevision) throw protocolError("revision_changed");
    const merged = { ...current };
    for (const [key, value] of Object.entries(input.profile)) {
      if (key === "officialWebsite" && value && typeof value === "object" && "state" in value && value.state === "unknown") delete merged[key];
      else if (value === null && key !== "officialWebsite") delete merged[key];
      else merged[key] = value;
    }
    return merged;
  };
  const boundedFields = (title: string, fields: Array<{ label: string; value: string }>): InputPresentation => {
    const expanded: typeof fields = [];
    for (const entry of fields) {
      if (entry.value.length <= 4000) { expanded.push(entry); continue; }
      for (let index = 0; index < entry.value.length; index += 4000) expanded.push(field(`${entry.label} ${Math.floor(index / 4000) + 1}`, entry.value.slice(index, index + 4000)));
    }
    if (expanded.length > 12) throw new AppError("INPUT.INVALID");
    return { title, fields: expanded };
  };
  const researchFields = (itemId: string, companyId: string, parameters: { direction: string; asOfDate: string; focusScope?: string }) => [
    field("研究主题", topic(itemId).industry), field("公司", company(itemId, companyId).name), field("研究方向", directionName(parameters.direction)),
    field("截止日期", parameters.asOfDate), field("重点范围", parameters.focusScope || "未指定"),
  ];
  const operation = (id: string, input: any): OperationPresentation | undefined => {
    if (id === "topics.create") return { text: `准备新建研究主题“${shortName(input.industry)}”。请在表单中核对并确认。`, target: target("topics", {}), autoOpen: true };
    if (id === "topics.update") return { text: `准备更新研究主题“${shortName(topic(input.itemId).industry)}”。`, linkLabel: "查看当前主题", target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "topics.delete") return { text: `准备删除 ${input.itemIds.length} 个研究主题。`, linkLabel: "查看研究主题", target: target("topics", {}), autoOpen: true };
    if (id === "companies.add") return { text: `准备向“${shortName(topic(input.itemId).industry)}”添加 ${input.companies.length} 家公司；新公司可能自动补全资料。`, linkLabel: "查看主题公司", target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "companies.recognize") return { text: `准备从文本识别“${shortName(topic(input.itemId).industry)}”的候选公司，识别后不会自动导入。`, target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "companies.update") return { text: `准备编辑“${shortName(company(input.itemId, input.companyId).name)}”的共享资料。`, linkLabel: "查看公司", target: target("company", { itemId: input.itemId, companyId: input.companyId }), autoOpen: true };
    if (id === "companies.remove") return { text: `准备从“${shortName(topic(input.itemId).industry)}”移除 ${input.companyIds.length} 家公司。`, linkLabel: "查看主题公司", target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "companies.retryProfile" || id === "companies.confirmIdentity") return { text: `准备继续处理“${shortName(company(input.itemId, input.companyId).name)}”的资料补全。`, linkLabel: "查看公司", target: target("company", { itemId: input.itemId, companyId: input.companyId }), autoOpen: true };
    if (id === "research.submit") { const p = input.parameters; return { text: `准备提交“${shortName(company(p.itemId, p.companyId).name)}”的${directionName(p.direction)}调研，截止 ${p.asOfDate}。`, linkLabel: "查看公司调研", target: target("company", { itemId: p.itemId, companyId: p.companyId }), autoOpen: true }; }
    if (id === "research.submitBatch") return { text: `准备向“${shortName(topic(input.itemId).industry)}”提交 ${input.entries.length} 家公司的调研。`, linkLabel: "查看调研队列", target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "research.retryFailed" || id === "research.retryStructuring") return { text: `准备重试“${shortName(company(input.itemId, input.companyId).name)}”的${id === "research.retryStructuring" ? "报告结构化" : "失败调研"}。`, linkLabel: "查看公司调研", target: target("company", { itemId: input.itemId, companyId: input.companyId }), autoOpen: true };
    if (id === "queue.cancel" || id === "queue.cancelEntry" || id === "queue.resume") return { text: id === "queue.resume" ? "准备恢复全局调研队列。" : id === "queue.cancel" ? "准备取消全局调研队列中未完成的条目。" : "准备取消指定的单条调研。", target: input.itemId ? target("companies", { itemId: input.itemId }) : target("topics", {}), autoOpen: true };
    if (id === "reports.delete") return { text: `准备删除“${shortName(reportLabel(input))}”。`, linkLabel: "查看公司", target: target("company", { itemId: input.itemId, companyId: input.companyId }), autoOpen: true };
    if (id === "reports.exportWord") { const ref = artifactRef(run(input)); return { text: `准备导出“${shortName(reportLabel(input))}”的 Word 文档；保存位置由系统对话框选择。`, linkLabel: "查看报告", target: target("report", { itemId: input.itemId, companyId: input.companyId, runId: input.runId, revision: ref.revision }), autoOpen: true }; }
    return undefined;
  };
  const resultPresentation = (id: string, input: any, text: string, data: Record<string, unknown>): OperationPresentation | undefined => {
    if (id === "topics.create") return { text, linkLabel: "查看新主题", target: data.viewRef as ViewRef, autoOpen: true };
    if (id === "topics.update") return { text, linkLabel: "查看主题", target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "topics.delete") return { text, linkLabel: "查看研究主题", target: target("topics", {}), autoOpen: true };
    if (id === "companies.add" || id === "companies.remove") return { text, linkLabel: "查看主题公司", target: target("companies", { itemId: input.itemId }), autoOpen: true };
    if (id === "companies.update" || id === "companies.retryProfile" || id === "companies.confirmIdentity") return { text, linkLabel: "查看公司", target: target("company", { itemId: input.itemId, companyId: input.companyId }), autoOpen: true };
    if (id === "research.prepare") { const prepared = data as { draftRef?: { draftId: string; revision: string } }; return prepared.draftRef ? { text: "调研草稿已准备，可检查参数后提交。", linkLabel: "查看调研草稿", target: target("research-draft", { draftId: prepared.draftRef.draftId, revision: prepared.draftRef.revision }) } : undefined; }
    if (id === "reports.delete") return { text, linkLabel: "查看公司", target: target("company", { itemId: input.itemId, companyId: input.companyId }), autoOpen: true };
    if (id === "reports.exportWord") return { text };
    if (id === "companies.recognize") return { text };
    if (["queue.cancel", "queue.cancelEntry", "queue.resume"].includes(id)) return { text, target: input.itemId ? target("companies", { itemId: input.itemId }) : target("topics", {}), autoOpen: true };
    return undefined;
  };
  const present = (id: string, input: any): InputPresentation => {
    if (id === "topics.create") return boundedFields("新建研究主题", [field("主题", input.industry), field("研究范围", input.researchScope || "未指定"), field("备注", input.notes || "无")]);
    if (id === "topics.update") return boundedFields("编辑研究主题", [field("当前主题", topic(input.itemId).industry), field("新主题", input.changes.industry), field("研究范围", input.changes.researchScope || "未指定"), field("备注", input.changes.notes || "无")]);
    if (id === "topics.delete") return boundedFields("删除研究主题及其关联资料", [field("影响主题", joinNamed(input.itemIds.map((value: string) => topic(value).industry)))]);
    if (id === "companies.add") return boundedFields("添加公司并自动补全新公司资料", [field("研究主题", input.itemId ? topic(input.itemId).industry : "本次任务前一步新建的主题"), field("添加公司", input.companies ? joinNamed(input.companies.map((value: { name: string; note?: string }) => `${value.name}${value.note ? `（${value.note}）` : ""}`)) : "本任务执行中发现的公司，每次最多 100 家"), field("资源消耗", "新公司可能自动调用模型和搜索补全资料")]);
    if (id === "companies.recognize") return boundedFields("识别候选公司", [field("研究主题", input.itemId ? topic(input.itemId).industry : "本次任务前一步新建的主题"), field("待识别文本", input.text ?? "本任务执行中取得的文本"), field("资源消耗", "识别将调用模型；候选公司尚不会加入主题")]);
    if (id === "companies.update") return boundedFields("编辑公司共享资料", [field("研究主题", topic(input.itemId).industry), field("公司", company(input.itemId, input.companyId).name), field("影响范围", "公司共享资料，其他主题中的同一公司也会看到修改"), ...profileFields(mergedProfile(input))]);
    if (id === "companies.remove") return boundedFields("从当前主题移除公司", [field("研究主题", topic(input.itemId).industry), field("移除公司", joinNamed(input.companyIds.map((value: string) => company(input.itemId, value).name))), field("影响范围", "移除当前主题关联；共享公司可能仍在其他主题")]);
    if (id === "companies.retryProfile") return boundedFields("重试公司资料补全", [field("研究主题", topic(input.itemId).industry), field("公司", company(input.itemId, input.companyId).name), field("资源消耗", "可能调用模型和搜索")]);
    if (id === "companies.confirmIdentity") return boundedFields("确认公司主体并继续补全", [field("研究主题", topic(input.itemId).industry), field("公司", company(input.itemId, input.companyId).name), field("确认名称", input.identity.name), field("官方网站", input.identity.officialWebsite || "未指定"), field("资源消耗", "确认后可能继续调用模型和搜索")]);
    if (id === "research.prepare") return boundedFields("准备调研草稿", researchFields(input.itemId, input.companyId, input));
    if (id === "research.submit") return boundedFields("提交公司调研", researchFields(input.parameters.itemId, input.parameters.companyId, input.parameters));
    if (id === "research.submitBatch") return boundedFields("批量提交公司调研", [field("研究主题", topic(input.itemId).industry), field("逐公司参数", joinNamed(input.entries.map((entry: any) => `${company(input.itemId, entry.companyId).name}；方向：${directionName(entry.input.direction)}；截止：${entry.input.asOfDate}；重点：${entry.input.focusScope || "未指定"}`)))]);
    if (id === "research.retryFailed") return boundedFields("重试失败调研", [...researchFields(input.itemId, input.companyId, input.input), field("原报告", reportLabel(input)), field("资源消耗", "可能重新搜索并调用模型")]);
    if (id === "research.retryStructuring") return boundedFields("只重试报告结构化", [field("研究主题", topic(input.itemId).industry), field("报告", reportLabel(input)), field("资源消耗", "只调用模型整理已有原始报告")]);
    if (id === "queue.cancel" || id === "queue.resume" || id === "queue.cancelEntry") {
      const state = batch.getState(input.itemId); if (!state || state.batchId !== (input.batchId ?? state.batchId)) throw protocolError("not_found");
      const entries = id === "queue.cancelEntry" ? state.entries.filter(entry => entry.entryId === input.entryId) : state.entries.filter(entry => entry.status === "pending" || entry.status === "running");
      if (id === "queue.cancelEntry" && entries.length !== 1) throw protocolError("not_found");
      const preview = entries.slice(0, 10).map(entry => company(entry.itemId ?? state.itemId, entry.companyId).name);
      return boundedFields(id === "queue.resume" ? "恢复全局调研队列" : id === "queue.cancel" ? "取消整个全局调研队列" : "取消单条调研", [field("影响条目", `全部 ${entries.length} 条${entries.length > preview.length ? `；以下仅列前 ${preview.length} 条` : ""}`), field("影响公司", joinNamed(preview)), field("影响范围", id === "queue.cancel" ? "整个全局队列中未完成的条目，可能包含其他主题" : id === "queue.resume" ? "恢复全局队列后可能继续消耗资源" : "只取消这一条调研")]);
    }
    if (id === "reports.delete" || id === "reports.exportWord") return boundedFields(id === "reports.delete" ? "删除公司报告" : "导出 Word 报告", [field("研究主题", topic(input.itemId).industry), field("报告", reportLabel(input)), ...(id === "reports.exportWord" ? [field("导出内容", [input.selection.raw && "原始报告", input.selection.structured && "结构化报告"].filter(Boolean).join("、") || "未选择"), field("保存位置", "稍后由系统保存对话框选择")] : [])]);
    return { title: id, fields: [] };
  };
  const completed = (summary: string, extra: Record<string, unknown> & { viewRef?: ViewRef; artifactRef?: ArtifactRef } = {}) => ({ status: "completed" as const, data: { message: summary, summary, ...extra },
    ...(extra.viewRef ? { viewRefs: [extra.viewRef] } : {}), ...(extra.artifactRef ? { artifactRefs: [extra.artifactRef] } : {}) });
  const handle = async (id: string, input: any) => {
    if (id === "topics.create") { const item = industry.createItem(input); return completed(`已新建研究主题“${item.industry}”。`, { item, viewRef: { capabilityId: CAPABILITY_ID, viewId: "companies", input: { itemId: item.id } } }); }
    if (id === "topics.update") { const item = industry.updateItem(input.itemId, input.changes); return completed(`已更新研究主题“${item.industry}”。`, { item }); }
    if (id === "topics.delete") { for (const value of input.itemIds) topic(value); industry.deleteItems(input.itemIds); return completed(`已删除 ${input.itemIds.length} 个研究主题。`); }
    if (id === "companies.get") {
      const found = company(input.itemId, input.companyId);
      const viewRef = { capabilityId: CAPABILITY_ID, viewId: "company", input: { itemId: input.itemId, companyId: input.companyId } };
      if (input.section) {
        const values = input.section === "note" ? (found.note ?? "").match(/[\s\S]{1,4000}/g) ?? [] : found[input.section as "aliases" | "stockListings" | "businessTags"] ?? [];
        return completed(`“${found.name}”的${{ aliases: "别名", stockListings: "上市信息", businessTags: "业务标签", note: "主题备注" }[input.section as "aliases" | "stockListings" | "businessTags" | "note"]}。`, { ...pageValues(values, input, [input.itemId, input.companyId, input.section, values]), viewRef });
      }
      const item = { id: found.id, itemId: found.itemId, name: found.name, legalName: found.legalName, headquarters: found.headquarters, foundedAt: found.foundedAt,
        officialWebsite: found.officialWebsite, profileStatus: found.profileStatus, profileIssue: found.profileIssue, profileIdentityHint: found.profileIdentityHint,
        reportSummary: found.reportSummary, aliasesCount: found.aliases?.length ?? 0, stockListingsCount: found.stockListings?.length ?? 0,
        businessTagsCount: found.businessTags?.length ?? 0, noteLength: found.note?.length ?? 0, profileRevision: revision(currentProfile(input.itemId, input.companyId)) };
      return completed(`公司“${found.name}”的共享资料；别名、上市信息、业务标签和备注可按需分页读取。`, { item, viewRef });
    }
    if (id === "companies.add") { const added = industry.addCompanies(input.itemId, input.companies); return completed(`已向“${shortName(topic(input.itemId).industry)}”加入 ${added.length} 家公司；新公司资料补全可能继续运行。`, { items: added.slice(0, 20).map(item => ({ id: item.id, name: item.name, profileStatus: item.profileStatus })), item: { totalAdded: added.length, returned: Math.min(added.length, 20), truncated: added.length > 20, remainingVia: "companies.list" } }); }
    if (id === "companies.recognize") { const candidates = await industry.recognizeCompanies(input.itemId, input.text); const receiptId = retainRecognition?.(input.itemId, input.text, candidates); return completed(`识别到 ${candidates.length} 家候选公司，尚未导入。`, { items: candidates.slice(0, 20), item: { totalCandidates: candidates.length, returned: Math.min(candidates.length, 20), truncated: candidates.length > 20, ...(receiptId ? { recognitionReceiptId: receiptId } : {}), remainingRecovery: candidates.length > 20 ? "请把原文本分段后分别识别" : null } }); }
    if (id === "companies.update") { const updated = industry.updateCompany(input.companyId, mergedProfile(input)); return completed(`已更新“${updated.name}”的共享资料。`, { item: { id: updated.id, name: updated.name, profileStatus: updated.profileStatus } }); }
    if (id === "companies.remove") { for (const value of input.companyIds) company(input.itemId, value); industry.removeCompanies(input.itemId, input.companyIds); return completed(`已从“${shortName(topic(input.itemId).industry)}”移除 ${input.companyIds.length} 家公司；其他主题中的共享资料不受此主题移除操作影响。`); }
    if (id === "companies.retryProfile") { const name = company(input.itemId, input.companyId).name; const accepted = industry.retryCompanyProfile(input.companyId); return completed(accepted ? `已排队更新“${name}”的信息。` : `“${name}”目前正在更新信息。`, { accepted }); }
    if (id === "companies.confirmIdentity") { const name = company(input.itemId, input.companyId).name; const accepted = industry.confirmCompanyProfileIdentity(input.companyId, input.identity); return completed(accepted ? `已确认“${name}”的主体，资料补全将继续。` : `“${name}”的主体确认未被接受。`, { accepted }); }
    if (id === "queue.cancel" || id === "queue.resume" || id === "queue.cancelEntry") {
      present(id, input);
      if (id === "queue.cancel") { await batch.cancel(input.batchId); return completed("已取消当前全局调研队列中尚未完成的条目。"); }
      if (id === "queue.resume") { const state = batch.resume(input.batchId); return completed(`已恢复全局调研队列，共 ${state.total} 条。`, { item: { batchId: state.batchId, status: state.status, total: state.total } }); }
      await batch.cancelEntry(input.entryId); return completed("已取消指定的单条调研。");
    }
    if (id === "reports.get") { const report = run(input); const ref = artifactRef(report); const viewRef = { capabilityId: CAPABILITY_ID, viewId: "report", input: { itemId: input.itemId, companyId: input.companyId, runId: input.runId, revision: ref.revision } }; return completed(`已找到报告“${reportLabel(input)}”。`, { item: { id: report.id, status: report.status, schemaVersion: report.schemaVersion, createdAt: report.createdAt, completedAt: report.completedAt }, artifactRef: ref, viewRef }); }
    if (id === "reports.delete") { const label = reportLabel(input); research.deleteRun(input.itemId, input.companyId, input.runId); return completed(`已删除报告“${label}”。`); }
    if (id === "reports.exportWord") { const label = reportLabel(input); const result = await services.companyResearchWordExport.export(input.itemId, input.companyId, input.runId, input.selection); return completed(result.status === "saved" ? `已导出报告“${label}”的 Word 文档。` : `已取消报告“${label}”的 Word 导出，未保存文件。`, { status: result.status }); }
    return undefined;
  };
  return { topic, company, run, present, operation, resultPresentation, handle };
}
