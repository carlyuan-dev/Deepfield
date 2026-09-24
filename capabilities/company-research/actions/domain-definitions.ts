import { Type } from "typebox";
import { CompanyDraftSchema, CompanyProfileInputSchema, CompanyProfileIdentityHintSchema, CreateIndustryResearchItemInputSchema, UpdateIndustryResearchItemInputSchema, StartCompanyResearchInputSchema, CompanyResearchWordExportSelectionSchema } from "../contracts/index.js";
import { id, ids, page, paginated, simpleResult, TargetSchema, RunTargetSchema, BatchInputSchema, ResearchParametersSchema, PreparedResearchSchema, type ActionSpec } from "./definitions.js";
const ProfilePatchSchema = Type.Object({
  ...Type.Partial(CompanyProfileInputSchema).properties,
  legalName: Type.Optional(Type.Union([CompanyProfileInputSchema.properties.legalName, Type.Null()])),
  headquarters: Type.Optional(Type.Union([CompanyProfileInputSchema.properties.headquarters, Type.Null()])),
  foundedAt: Type.Optional(Type.Union([CompanyProfileInputSchema.properties.foundedAt, Type.Null()])),
  businessTags: Type.Optional(Type.Union([CompanyProfileInputSchema.properties.businessTags, Type.Null()])),
  // Explicitly reset to unknown; null remains the distinct confirmed-no-website value.
  officialWebsite: Type.Optional(Type.Union([CompanyProfileInputSchema.properties.officialWebsite, Type.Object({ state: Type.Literal("unknown") }, { additionalProperties: false })])),
}, { additionalProperties: false });

export const topicActions = (): ActionSpec[] => [
  { id: "topics.list", title: "列出研究主题", description: "分页查看已有研究主题。", input: Type.Object(page, { additionalProperties: false }), output: paginated },
  { id: "topics.create", title: "新建研究主题", description: "创建一个行业研究主题。", input: CreateIndustryResearchItemInputSchema, output: simpleResult, effect: "write", confirmation: true, taskAuthorization: { mode: "scope", dynamicFields: [], resourceFields: [], outputBindings: ["data.item.id"] } },
  { id: "topics.update", title: "编辑研究主题", description: "修改主题名称、研究范围和备注。", input: Type.Object({ itemId: id, changes: UpdateIndustryResearchItemInputSchema }, { additionalProperties: false }), output: simpleResult, effect: "write", confirmation: true },
  { id: "topics.delete", title: "删除研究主题", description: "删除指定主题及其主题关联资料。", input: Type.Object({ itemIds: ids }, { additionalProperties: false }), output: simpleResult, effect: "destructive", confirmation: true, taskAuthorization: { mode: "scope", dynamicFields: [], resourceFields: [], outputBindings: [] } },
];
export const companyActions = (): ActionSpec[] => [
  { id: "companies.list", title: "列出主题公司", description: "分页查看指定主题中的公司及资料状态。", input: Type.Object({ itemId: id, ...page }, { additionalProperties: false }), output: paginated },
  { id: "companies.get", title: "查看公司详情", description: "查看公司基本资料，按需分页读取别名、上市信息、业务标签及主题备注。", input: Type.Object({ ...TargetSchema.properties, section: Type.Optional(Type.Union([Type.Literal("aliases"), Type.Literal("stockListings"), Type.Literal("businessTags"), Type.Literal("note")])), ...page }, { additionalProperties: false }), output: simpleResult },
  { id: "companies.add", title: "添加公司", description: "把公司加入主题，新公司会自动尝试资料补全。", input: Type.Object({ itemId: id, companies: Type.Array(CompanyDraftSchema, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), output: simpleResult, effect: "write", paid: true, confirmation: true, taskAuthorization: { mode: "scope", dynamicFields: ["companies"], resourceFields: ["itemId"], outputBindings: [], fieldLabels: { companies: "执行中发现的公司（每次最多 100 家）", itemId: "研究主题" }, resourceDescription: "新公司可能自动调用模型和搜索补全资料" } },
  { id: "companies.recognize", title: "识别公司文本", description: "从文本识别候选公司；确认导入前不会加入主题。", input: Type.Object({ itemId: id, text: Type.String({ minLength: 1, maxLength: 12000 }) }, { additionalProperties: false }), output: simpleResult, paid: true, confirmation: true, taskAuthorization: { mode: "scope", dynamicFields: ["text"], resourceFields: ["itemId"], outputBindings: [], fieldLabels: { text: "执行中取得的待识别文本", itemId: "研究主题" }, resourceDescription: "识别调用模型；如同时授权导入，后续新公司可能自动补全资料" } },
  { id: "companies.update", title: "编辑公司共享资料", description: "按字段修改共享资料；其他主题中的同一公司也会看到修改。", input: Type.Object({ itemId: id, companyId: id, expectedRevision: id, profile: ProfilePatchSchema }, { additionalProperties: false }), output: simpleResult, effect: "write", confirmation: true },
  { id: "companies.remove", title: "从主题移除公司", description: "移除当前主题与公司的关联；共享公司可能仍在其他主题。", input: Type.Object({ itemId: id, companyIds: ids }, { additionalProperties: false }), output: simpleResult, effect: "destructive", confirmation: true, taskAuthorization: { mode: "scope", dynamicFields: [], resourceFields: [], outputBindings: [] } },
  { id: "companies.retryProfile", title: "更新公司信息", description: "请求更新公司基本资料；更新不影响已有调研。", input: TargetSchema, output: simpleResult, effect: "write", paid: true, confirmation: true },
  { id: "companies.confirmIdentity", title: "确认公司主体", description: "确认公司名称及可选官网后继续资料补全。", input: Type.Object({ itemId: id, companyId: id, identity: CompanyProfileIdentityHintSchema }, { additionalProperties: false }), output: simpleResult, effect: "write", paid: true, confirmation: true },
];
export const researchActions = (): ActionSpec[] => [
  { id: "research.prepare", title: "准备调研草稿", description: "检查主题与公司并保存可编辑调研草稿。", input: ResearchParametersSchema, output: PreparedResearchSchema, effect: "write" },
  { id: "research.submit", title: "提交公司调研", description: "按已确认的草稿参数加入调研队列。", input: PreparedResearchSchema, output: Type.Object({}, { additionalProperties: false }), effect: "write", paid: true, confirmation: true, mode: "task" },
  { id: "research.submitBatch", title: "批量提交公司调研", description: "按每家公司的独立参数提交一组调研。", input: BatchInputSchema, output: Type.Object({}, { additionalProperties: false }), effect: "write", paid: true, confirmation: true, mode: "task" },
  { id: "research.retryFailed", title: "重试失败调研", description: "按指定参数重试失败的调研；可能重新搜索。", input: Type.Object({ ...RunTargetSchema.properties, input: StartCompanyResearchInputSchema }, { additionalProperties: false }), output: Type.Object({}, { additionalProperties: false }), effect: "write", paid: true, confirmation: true, mode: "task" },
  { id: "research.retryStructuring", title: "重试报告结构化", description: "只重新整理已有原始报告，不重新搜索。", input: RunTargetSchema, output: Type.Object({}, { additionalProperties: false }), effect: "write", paid: true, confirmation: true, mode: "task" },
  { id: "queue.get", title: "查看调研队列", description: "分页查看当前全局调研队列的进度和条目状态。", input: Type.Object({ itemId: id, ...page }, { additionalProperties: false }), output: simpleResult },
  { id: "queue.cancel", title: "取消整个调研队列", description: "取消当前全局队列中所有未完成的调研。", input: Type.Object({ itemId: id, batchId: id }, { additionalProperties: false }), output: simpleResult, effect: "destructive", confirmation: true },
  { id: "queue.resume", title: "恢复调研队列", description: "继续已暂停的全局调研队列。", input: Type.Object({ itemId: id, batchId: id }, { additionalProperties: false }), output: simpleResult, effect: "write", paid: true, confirmation: true },
  { id: "queue.cancelEntry", title: "取消单条调研", description: "只取消指定队列条目。", input: Type.Object({ itemId: id, entryId: id }, { additionalProperties: false }), output: simpleResult, effect: "destructive", confirmation: true },
];
export const reportActions = (): ActionSpec[] => [
  { id: "reports.list", title: "列出公司报告", description: "分页查看公司报告及可打开的版本。", input: Type.Object({ ...TargetSchema.properties, ...page }, { additionalProperties: false }), output: paginated },
  { id: "reports.get", title: "查看报告版本", description: "读取指定报告版本的摘要与内容引用。", input: RunTargetSchema, output: simpleResult },
  { id: "reports.delete", title: "删除公司报告", description: "删除指定的一份公司调研报告。", input: RunTargetSchema, output: simpleResult, effect: "destructive", confirmation: true },
  { id: "reports.exportWord", title: "导出 Word 报告", description: "选择原始或结构化内容，经系统保存对话框导出 Word。", input: Type.Object({ ...RunTargetSchema.properties, selection: CompanyResearchWordExportSelectionSchema }, { additionalProperties: false }), output: simpleResult, effect: "write", confirmation: true },
];
