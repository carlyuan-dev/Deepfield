# 调研证据留存与日期溯源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留实际发送给模型的检索依据，让首次结构化、自动格式修复和人工二轮重试使用同一份可验证的持久化证据包。

**Architecture:** 通用执行层提供可选请求观察接口，Capability 转换成带关联信息的 Worker 证据事件；Application 验证完整清单，以一个事务保存原报告、冻结快照、固定证据包与阶段状态。先完成本地端到端闭环，再增加原始日期与来源展示。

**Tech Stack:** TypeScript、Pi Agent / Pi AI 0.84.3、TypeBox、Node SQLite、Vitest、React；复用现有网关、Worker、事务和报告组件。

**Spec:** `/Users/carl/Project/Deepfield/docs/superpowers/specs/2026-10-09-research-evidence-provenance-design.md`（2026-10-09 已确认）。

**Status:** 2026-10-09 用户授权开始实施；2026-10-12 实现进入版本收口，实际验证见 [0.1.1 收口记录](../../releases/2026-10-12-v0.1.1.md)。以下原始任务清单保留供追溯，不作为测试通过证据。

## Global Constraints

- 不增加研究流程的模型调用次数；不增加模型自审、自动日期剔除、通用知识库或事实到精确引文映射。
- `required_v1` 用于新运行及重新联网 attempt；迁移前旧运行显式 `legacy_optional`，不能由缺记录推断。
- 归档：每 raw attempt 最多 200 条保存文本、总计 512 KiB UTF-8、单条 12 KiB；元数据 1 MiB。超限仍保留完整省略清单，否则 `evidence_incomplete`。
- 日期原文最大 2 KiB；包单片段最多 2,000 Unicode 字符、正文最多 24,000 Unicode 字符。UTF-8 和字符限制分别执行。
- 预算：`E = 文本 UTF-8 字节总数 + 256 × 消息数 + 2048`；`O = min(8192,max(1024,floor(C/8)))`；`S = max(4096,ceil(C×0.1))`；要求 `E+O+S≤C`。这是保守估算，不是精确 Token 计数。
- 同时预算首次结构化与修复请求；修复候选最终文本最多 16 KiB、反馈最终文本最多 8 KiB，包括 JSON 转义后的增长；显式传递输出上限 O。
- 只有首次组包可缩片段；持久化后不缩包、不换算法。预算不足保留原报告与包，拒绝发送。
- 原报告、快照冻结、包或组包失败结果、阶段切换原子提交；取消删除该运行，其他已完成报告不受影响。
- 结构化 JSON 与 Word 格式保持兼容；旧报告不增加开发历史提示；真实归档裁剪显示“检索依据部分留存”。
- 本地固定材料验收不使用任何真实凭证或付费 API；保留工作区已有实验改动，不自动提交、合并、推送或打包。

## Review Focus

- Pi 的协议转换或收尾裁剪改变文本：以实际 adapter 发送正文为验证依据，不能只断言观察回调被调用（任务 1）。
- 相同工具结果多次进入请求、请求发出但响应失败、prepared 未发送：保留每次投影及状态，完整清单不混算（任务 1、2）。
- 写库中断、旧 attempt 迟到、同 ID 内容不同、取消和冻结竞争：不得半提交、污染或复活运行（任务 2、4）。
- 配置缩小、算法升级、修复候选转义膨胀：包正文不变；预算不足不得发出无证据请求（任务 3、4）。
- 日期合法但意义未知、非法原文、归档只存部分中文文本：日期不猜测，裁剪可辨认，链接仍可复制（任务 5、6）。

## 文件与接口分工

路径均相对仓库根；执行时不得把 Capability 的业务类型导入通用执行层。

|范围|文件与职责|
|---|---|
|通用观察契约|新增 `packages/capability-sdk/src/model-observation.ts`；经 `index.ts` 导出仅含通用请求/投影/裁剪类型|
|实际请求观察|`apps/desktop/src/shared/model-gateway.ts`、`worker/agent/pi-runtime.ts`、`pi-default-runtime.ts`、`pi-agent-executor.ts`、`worker/capabilities/agent-runtime.ts`；传递 observer，捕获转换后的实际消息文本|
|来源关联|`packages/retrieval/src/search-tool.ts`、`apps/desktop/src/worker/tools/pi-tool-adapter.ts`；保留程序生成的结果与文本范围关联及格式化裁剪描述，成功输出与显示文本不混用|
|Capability 契约|新增 `capabilities/company-research/contracts/research-evidence.ts`；修改 `research.ts`、`contracts/index.ts`、`runtime/ports.ts`、`host-ports.ts`，扩展严格请求/事件/API Schema|
|持久化|新增 `packages/persistence/src/company-research-evidence-repository.ts`；修改 `migrations.ts`、`types.ts`、`repositories.ts`、`index.ts` 与 `company-research-run-repository.ts`。复用现有迁移注册，不顺带重构数据库归属|
|组包和预算|新增 `capabilities/company-research/runtime/company-research-evidence-packet.ts`、`company-research-context-budget.ts`；修改普通/修复 Prompt 与 `company-research-agent.ts`|
|应用闭环|`application/company-research-service.ts`、`create-services.ts`、`worker.ts`、`worker-client.ts`、`main.ts`；接收事件、冻结、读取固定包、暴露来源查询|
|原始日期|`packages/retrieval/src/search-provider.ts`、`providers/doubao.ts`、`providers/tavily.ts`，经过工具及证据契约传递|
|来源界面|新增 `ui/ResearchEvidenceDetails.tsx`；修改 `CompanyResearchPanel.tsx`、`capability.css`、`contracts/api.ts`、`contracts/ipc.ts`，复用现有链接悬停复制|

为避免多任务各自发明接口，任务 1 先交付如下类型，随后按契约消费：

- `ModelRequestObservation`：`modelRequestId`、`requestId`、`phase: ordinary|synthesis`、`state: prepared|dispatched|failed`、`projections: EvidenceProjection[]`。ID 由程序生成，不能采用来源文字提供的 ID。
- `EvidenceProjection`：`projectionId`、`toolCallId`、`messageIndex`、`origin`、实际投影文本、`visibleBytes/visibleHash`、来源定位与模型裁剪元数据。文本范围以转换后文本为准；范围无法对应标 `unmapped`，不猜测。
- `ResearchEvidenceEvent`：运行 `requestId/runId/attemptId`、单调 `sequence`、有界归档行或省略记录。完成时另发 `ResearchEvidenceManifest`，包含末序号、各状态数量、可见/保存/省略数量与字节及清单 hash。
- `FrozenEvidencePacket`：`body/hash/packetVersion/algorithmVersion/parameters/snapshotHash` 与选中 ID、截取范围、省略原因。参数必须有界且可序列化；包 hash 对正文 UTF-8 求 SHA-256。

## Task 1：先证明请求观察的真实性

**Files:** 上表通用观察、实际请求观察及来源关联文件；新增 `apps/desktop/src/worker/agent/pi-model-observation.test.ts`，扩展 `model-gateway.test.ts`。

**Interfaces:** `createAgent` 接受可选 `observeModelRequest: (event: ModelRequestObservation) => void`；网关 session/stream 将同一 observer 传至请求发送边界。不在 Chat 的 `PiExecutionEvent` 联合里添加调研专属事件。工具返回程序侧 origin 描述，executor 维护到 synthesis 的变换映射。

- [ ] 使用现有 Pi runtime 与本地 fetch fixture 写失败用例：两个来源（含中文长文本），普通工具轮后触发真实 16,000 字符收尾路径；断言被 fetch 捕获的 OpenAI 和 Anthropic 正文中证据文本，与观察投影逐字一致，字节/hash 对应。
- [ ] 加入请求未发送、发送后响应失败、相同来源重复入上下文、收尾追加来源定位四种断言；状态和每请求投影不能覆盖或合并错。
- [ ] 在 Pi AI 当前支持的自定义 fetch/发送钩子处观察序列化请求。executor 的 streamFn 只能提供阶段/origin，不能冒充协议转换后的最终观察点；使用既有网关捕获 fetch 模式，不 monkey-patch 全局 fetch。
- [ ] 观察不能把 API Key、请求头、完整正文写入通用日志。仅投影文本进入显式启用的 Capability observer；普通 Chat 未启用时行为保持原样。
- [ ] 运行 `npm run test -- apps/desktop/src/worker/agent/pi-model-observation.test.ts apps/desktop/src/shared/model-gateway.test.ts apps/desktop/src/worker/agent/pi-agent-executor.test.ts`。确认原失败断言通过；主 Agent 检查实际发送正文证据，再进入任务 2。

## Task 2：端到端最小闭环与原子冻结

**Files:** 上表 Capability 契约、持久化、应用闭环文件；新增 `capabilities/company-research/runtime/company-research-evidence.integration.test.ts` 与 `packages/persistence/src/company-research-evidence-repository.test.ts`。

**Interfaces:** 新 repository 提供 `append(runId,attemptId,event): void`、`readStaging(runId,attemptId): EvidenceSnapshot`、`freeze(runId,attemptId,manifest): FrozenSnapshot`、`getFrozen(runId,attemptId): FrozenSnapshot|undefined`、`savePacketOnce(runId,attemptId,packet): void`、`getPacket(runId,attemptId): FrozenEvidencePacket|undefined`、`deleteByRunId(runId): void`。`freeze/savePacketOnce` 参与宿主现有 `runInTransaction`，不得自行独立提交。

`CompanyResearchService` 用 `completeRawWithEvidence` 事务路径替代新运行的旧 `completeRaw` 路径；结构化请求新增显式 evidencePolicy、attemptId、已保存 packet。先消费任务 3 的组包/预算函数；任务 2 和 3 是同一个交付门槛，不能把只接好存储的中间状态交给用户。

- [ ] 首先搭建红色纵向测试：真实 executor、Capability `activate`、Worker registry 与 client 的实际 Schema 验证、内存 SQLite、Application 服务、捕获二轮网关请求。仅模型和搜索传输用固定 fixture，不用直接伪造 evidence 事件绕过链路。
- [ ] 完成有界事件/清单与附属表迁移；旧行显式迁移为 legacy_optional，新创建/重新联网为 required_v1。原始 attempt ID 持久化，二轮 request ID 改变但 attempt ID 不变。
- [ ] 归档执行 200 条/512 KiB/12 KiB/1 MiB 限制；每次最终投影留 receipt，文本超限仍记录省略；去重只复用 blob，不删除请求关联。零条必须带完整零清单。
- [ ] 以单事务保存原报告、快照冻结、包或首次预算失败、阶段；核验末序号/快照 hash/attempt/status。先算包可放在事务外，事务内必须重验快照 hash。写失败停止二轮。
- [ ] 纵向断言：fetch 原始文本 → Worker 合法事件 → savedText/visibleHash → frozenSnapshot → 数据库 packet → 实际二轮 prompt/hash 均对应。归档截断时只从 savedText 组包，不能偷偷取内存中的完整文本。
- [ ] 运行 `npm run test -- capabilities/company-research/runtime/company-research-evidence.integration.test.ts packages/persistence/src/company-research-evidence-repository.test.ts capabilities/company-research/application/company-research-service.test.ts`；主 Agent 审查捕获文本及事务断言，与任务 3 一同验收。

## Task 3：固定组包、完整预算与三条结构化路径

**Files:** 上表组包/预算、普通与修复 Prompt、网关；新增同名 `.test.ts`，扩展 `company-research-agent.test.ts`。

**Interfaces:** `buildEvidencePacket(snapshot: FrozenSnapshot, rawReport: string, context: PacketBuildContext): PacketBuildResult` 返回 `ready(packet)` 或 `budget_exceeded(details)`；`PacketBuildContext` 包含原研究上下文、模板、outputSchema 与本次 LLM 配置。`checkStructureBudget(request: StructureRequest, mode: ordinary|repair): BudgetResult` 返回允许/拒绝、E/O/S/C 和版本。预算/包内部仅依赖传入数据，不读当前全局设置。

- [ ] 写任务 2 所需纯函数与失败断言：来源按原报告顺序＋稳定采集序号；普通轮投影优先；严格来源白名单；24,000/2,000 字符上限和多字节预算分别成立。
- [ ] 共用实际普通/修复消息构造函数完成预算，涵盖全部指令、模板、Schema、raw、packet、分隔内容和最坏修复预留；显式输出 O。候选/反馈在最终插入文本（包括转义）上限内有界，不能裁 raw 或固定 packet。
- [ ] 实现唯一执行顺序：基础超限拒绝 → 首次顺序组包且最多缩最后片段 → 有候选但非空一条放不下拒绝 → 冻结后只准入或拒绝。无匹配材料空包需理由；首次预算失败未建包与已有包丢失分别处理。
- [ ] 首次、自动格式修复、人工重试均读取持久化 body，发送前重算 hash，并在诊断记录 packetHash/packetVersion/snapshotHash/budgetVersion；仅格式修复新增候选/反馈。服务商 context limit 回到稳定预算错误，不启动无证据重发。
- [ ] 集成 fixture 强制第一份 JSON 无效触发已有有限修复，再触发人工二轮重试；三次实际模型请求中的 packet 完全一致，搜索/抓取计数不增加。更改算法版本仍复用旧包；配置缩小拒绝发送，恢复容量后仍用旧包。
- [ ] 运行 `npm run test -- capabilities/company-research/runtime/company-research-evidence-packet.test.ts capabilities/company-research/runtime/company-research-context-budget.test.ts capabilities/company-research/runtime/company-research-agent.test.ts capabilities/company-research/runtime/company-research-evidence.integration.test.ts`。任务 2、3 整体通过后才扩展日期和界面。

## Task 4：中断、取消、删除及失败语义

**Files:** repository、Application service、Worker client、错误契约及 `ui/research-error-presentation.ts`；复用对应 `.test.ts`。

**Interfaces:** 新增稳定 `evidence_incomplete` 与 `context_budget_exceeded` 失败码，串通持久化、Worker/Application 状态、重试策略和现有错误描述。取消/删除沿用已有接口，事务清理本 run 的附属证据；恢复继续沿用现有“中断转失败、人工重试”策略。

- [ ] 对原报告写入、冻结、包保存、阶段更新逐步注入事务失败，断言没有半提交；提交前/后中断分别断言 researching staging 与已冻结结构化状态按设计恢复，不自动新增调用。
- [ ] 验证缺序号/清单/hash、required_v1 缺材料、旧 attempt 迟到、相同 ID 同 hash 幂等、相同 ID 不同 hash 拒绝、冻结后追加拒绝。
- [ ] 验证取消与冻结竞争不得复活删除 run；删除报告及公司/主题现有删除入口清理附属数据，不影响其他报告。批量队列在预算/完整性错误时按既有失败结算继续，保留已完成结果。
- [ ] 错误描述使用现有入口与重试机制：预算不足提示选择足够上下文的 LLM 配置；缺失证据保留原报告并提供重新联网入口，不伪装成旧报告。
- [ ] 运行 `npm run test -- packages/persistence/src/company-research-evidence-repository.test.ts packages/persistence/src/company-research-run-repository.test.ts capabilities/company-research/application/company-research-service.test.ts capabilities/company-research/application/company-research-batch-service.test.ts`。

## Task 5：Provider 原始日期贯穿链路

**Files:** 上表原始日期、工具、证据契约；扩展 `search-tool.test.ts`、`providers/doubao.test.ts` 和纵向 fixture；新增 `packages/retrieval/src/providers/tavily.test.ts`（当前没有该独立测试文件）。

**Interfaces:** `NormalizedSearchResult.sourceDate` 可选，仅由白名单 Provider 字段生成；保留 provider/fieldName/rawValue/normalizedValue/precision/nature/evidenceSource/status 和过长原文长度/hash。日期未支持的 Provider 标 unknown，不凭 date 倒推 rawValue。

- [ ] 豆包 fixture 以完整带时间/时区 PublishTime 开始；证明在 slice 前留存，最终经 Provider → 工具 → Worker → SQLite 查询仍有完整原文及字段出处。Tavily published_date 同样验证。
- [ ] 覆盖 missing、unparseable、非字符串、2 KiB 超限与合法但语义未知；规范 date 仍满足旧契约。非法原始日期不伪造有效 date，也不因新增可选 provenance 破坏有效搜索结果；不改变其他必填字段/危险 URL 的严格验证。
- [ ] 日期 metadata 与发送文本内容分别核验，不能因为保存 metadata 就声称模型收到该日期。现有工具字节限制、模型裁剪、归档裁剪照常记录。
- [ ] 运行 `npm run test -- packages/retrieval/src/search-tool.test.ts packages/retrieval/src/providers/doubao.test.ts packages/retrieval/src/providers/tavily.test.ts capabilities/company-research/runtime/company-research-evidence.integration.test.ts`，使用本地 fetch fixture，不运行 live 配置。

## Task 6：检索依据界面与最终交付验证

**Files:** 上表来源界面/API 文件、`ResearchEvidenceDetails.test.tsx`、`CompanyResearchPanel.test.tsx`；必要时扩展主入口/查询测试。

**Interfaces:** 新操作 `companyResearch.getEvidence(itemId,companyId,runId)` 返回只读 `ResearchEvidenceView`，含完整性、计数/字节、省略原因、各来源 savedText/日期/类型/裁剪情况。服务验证目标归属；不向 Renderer 返回模型配置密钥或 prepared 的整份请求。

- [ ] 在报告来源旁添加可展开“检索依据”，同 URL 多片段可查看，复用链接组件悬停复制。真实归档裁剪显示“检索依据部分留存”和已存/可见数及原因；片段截断、模型侧裁剪、日期未知分别说明。
- [ ] 用组件固定 fixture 验证完整/部分留存、旧报告无入口提示、版本切换不残留上一份依据、日期出处和原链接复制。无需新增截图平台或大量视觉测试。
- [ ] 跑受影响定向测试后执行项目 `npm run check` 与 `npm run build`。检查通用执行层没有反向导入 Capability，Capability 缺席时宿主构建仍可用；复用现有架构检查设施。
- [ ] 最小手测：新调研完成后查看来源依据 → 结构化失败只重试二轮 → 切换报告版本 → 取消另一任务 → 打开旧报告并导出 Word。模型/搜索链路本地测试已经覆盖，真实 API 手测由用户进行。
- [ ] 交付记录写明本地 fixture、版本/环境、通过命令、包/hash 关联和未验证事项；只报告证据一致性与功能行为，不宣称报告事实质量提高。用户未要求前不发布、提交或打包。

## 执行顺序与子 Agent 派发

顺序为任务 1 → 任务 2 与 3 的共同闭环 → 任务 4 → 任务 5 → 任务 6。任务 2/3 共用契约和服务文件，由同一个开发 Agent 连续完成，主 Agent 先审关键路径后继续。其他任务按阶段派发，避免同时写相同文件；本阶段不提前启动子 Agent。

每次交付返回简洁 YAML：`status`、`changed_files`、`verified_commands`、`key_path_evidence`、`remaining_limits`。主 Agent 阅读实际 diff 和测试输出，关键路径对照捕获请求正文与数据库 hash；不把子 Agent 的“完成”当验收结论。

设计/计划之外的行为变更先列出差异；若无法在实际 adapter 边界准确观察投影，停止该任务并报告证据，不能降低为 formatOutput 观察后宣称已满足契约。
