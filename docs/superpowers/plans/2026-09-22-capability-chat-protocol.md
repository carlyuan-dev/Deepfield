# Capability 通用交互第三批实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。沿用用户约定：子 Agent 实现，主 Agent 规划、逐项复核和交付；前两阶段已通过用户验收。2026-09-23 第三阶段 Task 6–7 已实现并通过最终复核、定向测试与构建，等待用户手测验收。

**Goal:** 让 Chat 通过领域无关协议发现、调用已启用的 Capability，并联动页面、跟踪任务、读取结果。

**Architecture:** 在现有 SDK、启动快照、注册表和 Pi 工具执行机制上增量扩展。公共协议不认识公司、报告或联网；公司调研只是首个真实业务适配。用非调研模板验证可扩展性，不另写 Agent Loop 或任务调度器。

**Tech Stack:** TypeScript、TypeBox、React、现有 Electron IPC、SQLite、Vitest、已安装 Pi Agent；不新增框架。

**Spec:** `docs/capabilities/capability.protocol.设计文档.md`（2026-09-22 用户批准，含领域无关补充）。

## Global Constraints

- 只在 develop 开发；现有评测脚本、材料和 package.json 的评测改动不纳入本批、不覆盖。提交、合并与推送另按用户授权。
- 启动快照固定，设置勾选下次启动生效；不热加载，不把历史说明当授权。
- v2 manifest/host API 承载本协议，旧 v1 UI 继续可用但不自动开放给 Chat。
- 公共层不得出现 companyId、研究方向、两轮、Search 必需、报告章节必需等业务约束。
- 不设置业务类别枚举或场景准入名单。文档中的调研、填表、流程、查询都是示例；新增未知业务应通过包自身动作/Schema/说明接入，不能要求修改 Chat 的业务分支。
- 页面、Worker、草稿、后台任务、持久产物和 LLM/Search 均可选；只读与消耗独立描述。
- 付费调研一次参数确认；后台完成不抢页面，只有用户要求“完成后分析”才触发后续模型分析。
- 输出大小有上限，截断必须显式；不泄露 Key，不使用模型自报权限/确认。
- 回执终态保留 30 天，活动任务保留；过期写重试拒绝，不重复付费执行；报告按业务规则保留。
- 定向测试、类型检查、必要构建后打包给用户手测，不跑真实 API、全仓大套件或自动启动 Electron。
- 应用运行时不覆盖安装包；Capability 安装暂存放扫描目录之外，保留回滚备份、不改用户数据。

## Review Focus

1. 无 UI/Worker/LLM 的查询包能用，不能被公司包必填字段或初始化逻辑挡住（Task 1、2、7）。
2. 入队成功但响应丢失，或队列已清理：核对同一次调用，不再次付费执行（Task 4、5）。
3. 用户编辑表单或有未保存页面时，Chat 的旧草稿/导航不能覆盖人工输入（Task 3、5）。
4. 停用、包版本/说明变化、会话压缩后，旧可见文本不恢复权限或被误当作最新说明（Task 2、6）。
5. 报告重试更新内容、原始成功而结构化失败、另一会话正在生成：引用与通知必须真实且不串会话（Task 5、6）。

## 实施切片与依赖

1. Task 1–2：协议与网关，先用无业务探针证明通用调用。
2. Task 3–5：UI 交接、任务适配、公司调研双入口，复用现有业务。
3. Task 6–7：Chat/Pi 接线、端到端最小闭环、指南/模板与交付。

Task 1 完成后，Task 2、3 的新增模块可并行；Task 4 接口冻结后 Task 5 接入。Task 6 的 Pi/Chat 阅读与实现可在接口冻结后并行，但总装配文件由指定单一所有者修改。每个切片可检查，但第 7 项完成前不宣称 Chat 调用全链路已交付。

下列文件与导出名称为拟建模块，现有文件必须先阅读；实现若发现结构不匹配，主协调者更新计划再分派，不为了照搬文件名而复制现有逻辑。

## Task 1：领域无关 SDK 与契约构建

**Files:** 修改 `packages/capability-sdk/src/{manifest,host,ui,index}.ts`；新增该目录的 `actions.ts`、`interaction.ts`、`actions.test.ts`；新增 `scripts/capabilities/build-actions.ts`，接入现有 `scripts/capabilities/build.ts`。

**Interfaces:** 定义并导出如下边界，其 Schema 与 TS 类型来自同一来源：

```ts
type ActionEffects = { data: 'read' | 'write' | 'destructive'; consumesResources: boolean };
type TaskRef = { capabilityId: string; taskId: string };
type ArtifactRef = { capabilityId: string; artifactId: string; revision: string };
type DraftRef = { capabilityId: string; draftId: string; revision: string };
type ViewRef = { capabilityId: string; viewId: string; input: Record<string, unknown> };
type TaskStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
type ReadSlice = { format: string; data: unknown; revision: string; truncated: boolean; nextCursor?: string };
```

`defineAction` 接收设计文档第 5 节元数据、Schema 和 handler；`compileActionCatalog` 只导出数据及契约/文档摘要。`ActionResult` 实现第 7 节四种信封。可选 provider 接口提供 task get/cancel、artifact read、view open；未注册不能被静默当作成功。

- [x] 写 SDK 最小红灯用例：合法 v1 保持通过，v2 main-only 只读 action 合法；相同操作仅修改文档摘要即变化；缺说明、重复 ID 拒绝；声明 additionalProperties=false 的输入拒绝额外字段（遵循作者 Schema，不全局改写）。
- [x] 执行 `npx vitest run packages/capability-sdk/src/manifest.test.ts packages/capability-sdk/src/actions.test.ts`，确认新增断言失败后实现。
- [x] 从同一 action 定义生成声明和运行时注册元数据；v2 Worker/UI 可选，v1 校验保持原规则。输出 Schema 只校验 completed.data；accepted/confirmation/error 由公共信封校验。包返回 ActionOutcome，宿主补充可信调用标识形成 ActionResult。
- [x] 读操作可声明 consumesResources=true，测试不误判为写操作；产物格式不强制 Markdown/章节/URL。
- [x] 重跑同组测试与 `npm run typecheck`，独立复核通过，公共类型没有业务字段，接口冻结。

## Task 2：启动目录、动作网关与可信确认

**Files:** 新增 `apps/desktop/src/main/capabilities/{action-catalog,action-gateway,action-confirmations}.ts` 及对应 `.test.ts`；修改现有 `registry.ts`、`runtime.ts`、`package-paths.ts`。阶段一只接可信宿主端口；IPC/preload 确认桥随 Task 3/6 的真实 UI/Chat 身份关联接入，不提前开放调用者自报权限的 RPC。

**Interfaces:** `ActionGateway.describe(call, trustedContext)` 和 `invoke(call, trustedContext)`；call 包含 capabilityId/actionId/contractDigest/input，trustedContext 由宿主创建，包含来源、会话关联、权限、invocationId 与确认凭据。public action 注册与现有 private operation 分开索引。

- [x] 红灯用例：修改 preferences 不改变当前目录；v1 内部 operation 不在目录；手造 confirmed 字段不能执行 handler；无包不产生工具目录。
- [x] 执行 gateway、catalog、confirmations、runtime、ipc 五份定向用例，38 项通过。
- [x] 只从启动 ready 快照创建目录；加载时验证声明与注册一致。缓存包内校验后的说明，摘要不符返回 contract_changed，不读取任意路径。
- [x] invoke 顺序：就绪 → 公开动作 → 当前契约 → 输入 Schema → 权限/真实确认 → handler → 输出 Schema。错误沿用 AppError 安全结构，不输出原始异常。
- [x] 创建确认项时绑定规范化参数与摘要；可信宿主确认只批准该项，参数变化必须失效。依据动作声明与宿主策略确认，破坏性操作及消耗资源的后台任务默认确认；只读计费不一律弹窗。需要确认的动作无有效确认不得执行，预留 UI 已确认提交以避免重复弹窗。
- [x] 定向用例、typecheck、独立复核通过；主进程身份来源不能从 LLM 参数覆盖。

第一阶段交付核验（2026-09-22）：最终主协调者复验 SDK／网关／生命周期共 7 文件、69 项定向测试通过（1.13 秒）；类型检查、生产构建与 scoped diff check 通过。已使用本地 Electron 打包至 `release/mac-arm64/Deepfield.app`，校验 3 个 ASAR 入口与能力包 6 个文件在打包副本／安装副本中均与输出一致。安装程序包已保留回滚副本，未改数据库或配置、未启动 Electron、未调用真实 API、未提交合并推送。

阶段一新增宿主端口为 `runtime.actionCatalog/actionGateway/actionConfirmations`；生产公司调研继续使用 v1 私有 UI 通路。确认授权仅内存单次消费，不承诺持久回执。首次启动未 ready 的包不会在同次运行的 Worker 恢复时新增到已冻结目录；下次完整启动重新确定目录。真实 Chat/UI 联动与任务产物协议仍按 Task3–7 推进。

## Task 3：语义导航与草稿交接

**Files:** 新增 `apps/desktop/src/main/capabilities/view-navigation.ts`、`apps/desktop/src/renderer/capabilities/interaction-state.ts` 和对应测试；修改 `CapabilityHost.tsx`、`ui-runtime.ts`、SDK `ui.ts`、通用桥；`App.tsx` 仅增加通用导航接线。

**Interfaces:** 包提供 `open(ViewRef | DraftRef)` 返回 `opened | blocked | unsupported | not_found`；宿主 navigation requestId 关联 UI ack。draft 内容由包拥有，宿主仅转发引用；无需通用表单渲染器。

- [x] 红灯用例：无 UI 包返回 unsupported；仅发请求未收到 ack 不能返回 opened；未保存页面返回 blocked 并保留内容；后台完成不改变当前页面。
- [x] 执行 `npx vitest run apps/desktop/src/renderer/capabilities/CapabilityHost.test.tsx apps/desktop/src/renderer/capabilities/interaction-state.test.ts`。
- [x] 注册 v2 view 参数 Schema 与包解析器，主机不识别 company/report 页面。校验目标、ready 和参数后发送导航；超时返回明确失败，不无限等待。
- [x] 请求打开提供可点击入口；草稿引用与 revision 原样交接，不隐式提交。实际包内 revision 冲突处理在 Task 5、任务卡在 Task 6 接入。
- [x] 重跑上述测试与 typecheck；复核导航、预填、提交不会混为同一步。补充异步准备、超时／取消与自动回退期间新输入保护，独立审查通过。

Task 3 接线约定：包主进程 `ViewProvider.resolve` 只解析校验，UI `navigation.register` 提供同步 `canLeave` 与 `open`，可见状态必须通过受控 `commit` 修改；真实落屏后才 ack opened。`canLeave` 读取最新本地 dirty 状态，commit 与自动回退都重新检查，防止异步准备期间覆盖新输入。

## Task 4：任务/产物公共通路与调用持久性

**Files:** 新增 `apps/desktop/src/main/capabilities/task-artifact-gateway.ts` 与测试；新增 `packages/persistence/src/capability-invocation-repository.ts` 与测试，修改 migrations 和仓储装配；包内任务回执适配放 Task 5，不将业务状态塞进宿主表。

**Interfaces:** `TaskProvider.get(TaskRef)`、`cancel(TaskRef)`；`ArtifactProvider.read(ArtifactRef, { cursor?, section? })` 返回 ReadSlice；`InvocationRepository` 保存调用标识、参数摘要、期限及业务关联，不保存密钥。宿主生成的调用 token 可验证有效期，模型不可自行延长。

- [x] 红灯用例：非报告 JSON 产物可读；旧 revision 拒绝；回执存在但调用响应丢失时查询返回原任务；终态清理不删除产物；过期 token 不能作为新调用执行。
- [x] 执行 `npx vitest run apps/desktop/src/main/capabilities/task-artifact-gateway.test.ts packages/persistence/src/capability-invocation-repository.test.ts`。
- [x] provider 的 ready/权限检查与动作网关共用；实现响应上限 64 KiB（UTF-8 JSON），单次说明也受此上限约束。过大结果要求分页，不能静默裁剪。cursor 由包生成与验证，不作为路径执行。
- [x] 宿主保存传输调用关联，包负责业务提交与 task 回执的原子性。状态未知返回需核对，不让宿主自动重放写操作。活动调用保留，终态 30 天清理；遗留 Chat 引用查询返回 expired/not_found，不触发执行。
- [x] 输出 task 状态、阶段、产物和错误采用公共信封；取消只定位明确 task，不扩大为整队列取消。
- [x] 重跑上述用例与 typecheck；代码审查确认没有第二套执行调度器。

Task 4 接线约定：生产 main 注入 SQLite invocation 仓储；宿主 `actionGateway.issue` 签发绑定输入／身份的调用标识，invoke/query 只核验已签发标识，pending 只查询不重放。包 `findByInvocation` 仅恢复已提交任务。Task/artifact provider 显式声明读取／取消权限；终态保留按有效 finishedAt 起算30天，缺失／非法／未来时间采用观测时间兜底。Task 6 完成事件接线应同步尚未被查询任务的终态；本阶段没有另建轮询调度器。

## Task 5：公司调研适配与双入口贯通

**Files:** 新增 `capabilities/company-research/actions/{definitions,handlers,drafts,task-artifact-adapter}.ts`、对应定向测试及 `docs/actions/*.md`；修改 `main.ts`、`capability.json`、application 的现有队列服务及窄持久端口、ui 的 `CompanyResearchModal.tsx` 与 `IndustryResearchCapability.tsx`。实际字段沿用现有 StartCompanyResearchInput，不改动成功报告语义。

**Interfaces:** 公布 `topics.list`、`companies.list`、`reports.list`、`research.prepare`、`research.submit`；准备返回 DraftRef，提交返回 accepted/TaskRef。公开 views 为主题列表、公司、报告和调研草稿；页面仅包内解析。

- [x] 红灯用例：UI 与 action 同参数提交使用同一服务；draft revision 过期不入队；同 invocationId 重试只入队一次；两轮中第二轮失败仍可读取第一轮。
- [x] 执行 `npx vitest run capabilities/company-research/actions capabilities/company-research/application/company-research-batch-service.test.ts`。
- [x] 动作 handler 使用现有身份、配置和队列校验；topic/company ID 必须真实匹配。prepare 不创建研究 run、不调用模型；submit 在一次确认后调用现有队列入口。
- [x] 增加包内最小任务回执与草稿存储，复用当前 SQLite 窄适配；先确认当前队列持久化事务边界，再把 invocationId/任务映射与入队放进同一原子提交。不允许只在内存去重。
- [x] 队列结束清理后查询回执；主动取消不保留未完成报告但保留 cancelled 状态；可恢复的退出中断映射 paused 并附警告，不自动继续付费。
- [x] 报告读取提供原始/结构化内容和证据，revision 基于内容变更；只读结果不修改报告。不同行业/公司术语不外泄到公共 SDK。
- [x] 把相关 UI 写入口适配同一 prepare/submit 业务路径，保留既有单个/批量队列行为和手测字段；报告引用打开具体版本。
- [x] 重跑上述测试及 `CompanyResearchPanel.test.tsx` 的受影响用例、typecheck；主协调者确认现有 UI 无强制绕路或重复确认。

第二阶段交付核验（2026-09-22）：公司包升级2.0.0／协议2，5个公开动作与4个页面目标由真实构建校验。Task3、Task4、Task5及整阶段独立审查通过；收尾修复了异步导航输入保护、终态保留起算时间、报告切页前revision复核及用户重试／删除后的引用约束释放。主协调者最终复验19项关键用例、typecheck、diff-check、生产build通过，打包至 `release/mac-arm64/Deepfield.app`；7个ASAR应用文件及11个能力包文件与本次输出一致，已安装公司程序同步并保留旧版备份。未启动应用、未调用真实API、未改用户数据库／配置／Key、未提交合并推送。界面兼容手测待用户确认，Chat工具／会话联动仍为Task6。

第二阶段用户验收（2026-09-23）：用户明确确认“第二阶段验收无误”。包含荣耀结构化 JSON 修复；此前交付记录中的“待手测”已完成。此次验收不包含提交、合并、推送或第三阶段实现。

## Task 6：Chat 渐进发现、Pi 工具与会话通知

**Files:** 新增 `apps/desktop/src/worker/tools/pi-capability-tools.ts` 与测试；新增 `packages/application/src/chat/capability-context.ts`、`capability-task-links.ts` 与测试；修改 worker/chat 的上下文接线、tool-runtime、主进程 Worker 双向传输与 Chat 持久化端口。renderer `ChatView.tsx` 复用现有工具活动展示，增加通用任务/确认卡组件。

**Interfaces:** 五个公共工具与设计一致；工具仅封装上述网关，不 import company-research。Chat context 存会话、包版本、actionId、contractDigest 和实际说明内容；task link 存 TaskRef、会话 ID、用户是否要求后续分析及完成事件消费标识。

- [x] 阅读锁定版本 Pi 的 AgentTool、execute、工具事件和当前项目适配；使用原生执行机制，不添加外层 Agent Loop。
- [x] 定向覆盖：无包无工具、会话隔离、说明恢复、旧摘要拒绝、后台完成不串会话，以及异步跳页失效撤销。
- [x] 工具、上下文与任务关联定向测试通过。
- [x] 注入精简目录，describe 后保存已核验内容，invoke 仍检查当前就绪和摘要；本轮搜索开关只影响直接搜索工具，不擦除历史 Capability 数据。
- [x] Worker→main 请求带宿主可核对的会话/调用关联，不让包访问全局 Chat；requestId 路由按现有消息协议扩展，收到回执/错误后解除等待。
- [x] accepted 显示任务卡，切换会话从快照恢复；stop 当前 Chat 仅停止当前请求，不暗中取消后台任务。后续上下文恢复有界任务引用与待核对调用。
- [x] 用户明确“完成后分析”时存续办关联；完成事件去重，当前会话忙时排到空闲后，新用户输入优先。恢复遇到正在生成或中断的分析不自动重放；未要求则只更新任务状态。
- [x] 任务结果按需读取，有 revision/来源才引用；prompt 不把业务结果当指令。工具错误原因回传模型，不能隐藏成成功。
- [x] 定向测试与 typecheck 通过，LLM/Search 仍经统一 Usage 路径，任务不无限轮询。跨工具调用、跨轮次重试可核对原回执；过期的安全关联与不确定调用分开清理。

## Task 7：非调研模板、开发指南和交付

**Files:** 新增 `examples/capabilities/record-lookup/`（清单、入口、操作定义、说明、构建命令）、`tests/capabilities/chat-protocol.test.ts`；新增 `docs/capabilities/capability.开发指南.md`，更新总览、协议状态与文档地图。

**Interfaces:** 模板 action `records.find` 接收 query/limit，返回 `{ items: [{ id, text }], truncated }`，不含 Worker、UI、数据库、LLM 或 Search；使用固定示例数据，明确不是实际工单库产品。将记录查询产物适配作为可选示例，不强迫简单结果持久化。

- [x] 写探针断言，避免公司业务已加载造成假通过：

```ts
const input = { query: '交付', limit: 1 };
const expected = { items: [{ id: 'sample-1', text: '交付时间待客户确认' }], truncated: false };
// 通过真实 v2 加载器与动作网关执行 records.find，比较 completed.data 与 expected。
// 单独只安装该模板，断言目录没有 company-research，且不创建公司业务实例。
```

- [x] 在隔离目录执行模板 build/加载/describe/invoke，删除目录后核心 Chat 可运行；不扫描或删除用户真实包。
- [x] 执行 `npx vitest run tests/capabilities/chat-protocol.test.ts`，覆盖确认→队列→报告读取的 fake 公司闭环，以及独立 records.find 闭环。
- [x] 开发指南提供可复制命令、真实 SDK 导出、领域无关最小包、可选模块、更新规则和最小验收清单；不把设计中的未实现内容写成可运行教程。
- [x] 同步实际完成状态；主协调者最终 4 文件 / 18 项定向测试、`npm run typecheck`、`git diff --check`、`npm run build` 通过。不重复运行无关测试。
- [x] 应用退出后用本地 Electron 目录打包，更新独立安装能力包，校验 7 个 ASAR 文件及 11 个能力文件与本次构建一致。保留用户数据与旧能力包备份，不自动启动 Electron。
- [x] 提供[第三阶段手测清单](../../manual-tests/2026-09-23-chat-capability.md)：查询已有公司/报告、预填并人工修改、确认启动、等待/切换会话、取消、读取分析、停用重启。
- [ ] 用户确认第三阶段验收通过。

## 自审与交接

- 协议第 1–5、11–12 节：Task 1–2、7；第 6–7 节：Task 2、6；第 8 节：Task 3、5；第 9–10 节：Task 4–6；第 13 节：Task 5、7。
- 通用性通过独立 records.find 模板检验，不开发三个新业务产品来证明抽象。
- UI/Worker 可选、只读计费、JSON 产物、等待人工输入是协议支持面；不因此增加统一流程引擎、表单设计器、向量数据库或权限管理后台。
- 计划审阅通过后沿用子 Agent 实现、主 Agent 复核；依赖未冻结的任务不并行修改同一装配文件。
- 第一阶段 Task 1–2 已通过用户验收；2026-09-23 第二阶段 Task 3–5 已通过用户验收，本轮未授权合并/推送。Chat 工具与完整确认页面在 Task 6 接入，避免把后续交互提前暴露为可用功能。
