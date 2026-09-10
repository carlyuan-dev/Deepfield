# Deepfield 单公司关键调研 MVP v1 工程设计

日期：2026-09-11
状态：产品与工程设计已确认，待实施计划
参考：`docs/single-company-key-research-discussion.md`

## 1. 决策与目标

本切片在现有单公司调研主链上原地演进，交付可供真实用户试用的完整闭环：

```text
选择一个研究方向
→ 首次联网事实调研
→ 持久化只读 Markdown 原始报告
→ 第二次非联网分析与结构化
→ Harness 校验、有限修补与系统 ID 分配
→ 原始/结构化双视图
→ 最小内容单元编辑、增删和恢复
```

现有 Company、Capability Item、Utility Process、Main、IPC、历史运行和全局前台任务互斥均继续复用。该功能仍是 Capability 业务状态，不写入普通 Chat Conversation。

### 1.1 本切片包含

- 单公司、单研究主题、单研究方向的一次完整调研；
- 四个内置模板，每个模板固定五个模块；
- 两次有明确边界的 LLM 调用；
- 原始报告、结构化 AI 基线和用户工作副本；
- 第二阶段失败后的原始报告保留和重试；
- 第二阶段成功锁定；
- 最小内容单元人工核验、事实增删和 AI 基线恢复；
- 旧版自由结构报告的只读兼容。

### 1.2 本切片不包含

- 多公司横评和批量调研；
- 自定义模板、模块注册管理 UI 或动态 Prompt；
- 编辑历史、版本差异、多人协作和审核流；
- 报告导出；
- 自动事实真伪验证、可信度评分或多来源关系图；
- 主 Chat 启动或操纵调研；
- 调研任务跨应用重启自动续跑。

## 2. 现状与关键改变

当前实现的主路径是：

```text
CompanyResearchPanel
→ Desktop API / IPC
→ CompanyResearchService
→ Utility Process CompanyResearchAgent
→ DeepSeek Responses API + web_search
→ 一段 Markdown
→ company_research_runs.report_text
```

当前 `ResearchRun` 只有 `running | completed`，失败或取消会删除运行记录。新设计必须在首次报告形成后建立持久化边界，否则第二阶段失败、取消或应用退出会丢失已经完成且成本较高的联网调研结果。

本切片不另建平行子系统，也不把两个模型调用封装成 Worker 内部不可见的单次黑盒。Application 层拥有状态机，Worker 只执行阶段调用。

## 3. 核心架构

```text
Renderer
  CompanyResearchPanel / start modal / structured editor
        │ typed commands + stage events
        ▼
Preload + Main IPC
        ▼
CompanyResearchService ────── CompanyResearchHarness
        │                           │
        │ state transition           ├─ schema and semantic invariants
        │ transaction                ├─ raw-report URL allowlist
        ▼                           └─ stable ID assignment
CompanyResearchRunRepository
        │
        ├─ runRawResearch() ──► Utility Process ──► DeepSeek + web_search
        └─ runStructuring() ──► Utility Process ──► DeepSeek without tools
```

职责边界：

- Contracts：输入、运行快照、内容模型、命令、Worker 请求与事件 Schema；
- Persistence：运行状态迁移、报告产物、工作副本和旧报告兼容；
- Application：状态机、事务边界、重试和锁定、编辑命令、启动上下文快照；
- Harness：纯函数校验、有限确定性修补、URL 继承检查和稳定 ID 分配；
- Worker：供应商请求、SSE/响应解析、取消和安全失败事件；
- Renderer：状态展示、两种报告视图和受控编辑，不直接写整份 JSON。

## 4. 研究主题与输入语义

产品界面统一使用“研究主题”。为降低本切片的迁移风险，SQLite 现有 `capability_items.industry` 列暂时保留；Contract 和 Application 边界通过映射暴露 `topicName`。现有组件目录名和 Capability 类型不在本切片机械改名。

当前 Capability Item 上已有的 `researchScope` 是父级主题范围。本轮启动输入中的“具体研究范围”是一次运行的聚焦条件，两者不能混为同一个值：

```ts
interface StartCompanyResearchInput {
  direction:
    | "product_and_technology"
    | "market_and_commercialization"
    | "value_chain_and_competition"
    | "operations_and_performance";
  focusScope?: string;
  asOfDate: string; // YYYY-MM-DD，UI 默认为启动当天
}
```

首次 Prompt 同时接收只读的 `topicName`、可选 `topicScope` 和本轮可选 `focusScope`。`focusScope` 优先于一般主题范围，但不会覆盖或修改父级 Capability Item。

公司档案继续使用现有更完整的数据，不退化为只有简称和股票代码。它只用于主体识别和报告页头快照，两次正式调用都不得重新生成公司简介或写回档案。

## 5. 模板注册表

四个方向及二十个模块以一个共享、只读的内置模板注册表为唯一事实来源。每个模板包含：

- `templateId`、`templateVersion`、标题；
- 五个有序模块的 `sectionId`、标题、核心问题、覆盖点和边界；
- 固定状态中文文案。

首次 Prompt 只注入本轮模板的五个模块。第二次 Prompt、Harness 和 Renderer 使用同一注册表，不各自维护模块副本。运行记录保存模板 ID、版本及模块快照；未来注册表升级不会改变历史报告的标题、顺序和语义。

MVP 不建立模板数据库。注册表位于共享领域代码中，导出为不可变的序列化数据，并由契约测试确保每个模板恰有五个唯一模块。

## 6. ResearchRun 状态机

新运行状态：

```text
researching
   ├─ 首次失败/取消 ──► 删除本轮空运行
   └─ 原始报告成功并持久化 ──► structuring
                                  ├─ 成功 ──► completed（锁定）
                                  ├─ 失败 ──► structure_failed
                                  └─ 取消 ──► structure_failed

structure_failed ── 用户重试 ──► structuring
completed ── 不允许再次整理；重新生成必须创建新 ResearchRun
```

阶段转换必须使用带前置状态条件的 Repository 更新，并在事务中同时写入阶段产物：

- `researching → structuring`：写入完整原始 Markdown、首次完成时间和模板快照；
- `structuring → completed`：写入 `generatedContent`、`editableContent`、Harness 版本和完成时间；
- `structuring → structure_failed`：保留原始报告，记录安全的失败类别，不保存供应商原始错误或密钥；
- `structure_failed → structuring`：清空本次整理错误并增加整理尝试计数。

Application 启动恢复规则：

- 遗留 `researching` 没有可用产物，按现有语义删除；
- 遗留 `structuring` 改为 `structure_failed`，原始报告继续可见并可重试；
- `structure_failed`、`completed` 和旧版完成报告保持不变。

全局同时只允许一个 `researching` 或 `structuring` 运行。公司档案后台补全在这两个前台阶段均暂停，终态后恢复。普通 Chat 继续可用。

数据库使用常量表达式的部分唯一索引约束全局活动运行，例如 `UNIQUE(1) WHERE status IN ('researching', 'structuring')`；不能分别按两个状态建立唯一性，否则会错误地允许一个 `researching` 和一个 `structuring` 同时存在。

## 7. 持久化模型与兼容

`company_research_runs` 通过新 migration 重建约束并扩展字段。关键字段为：

```text
id, item_id, company_id
schema_version
status
research_direction
focus_scope
as_of_date
research_context_json
template_id, template_version, template_snapshot_json
harness_version
raw_report_text, raw_completed_at
generated_content_json
editable_content_json
structuring_attempts
last_failure_code
created_at, completed_at
legacy_time_scope, legacy_custom_requirements, legacy_report_text
```

JSON 在写入前必须通过对应 TypeBox Schema；读取时也校验并把损坏数据转换为安全的“报告不可读取”错误，不把任意数据库文本直接渲染为可信结构。

现有成功记录迁移为 `schemaVersion: "legacy-freeform-v1"` 的 `completed` 报告，保留原 `timeScope`、`customRequirements` 和 `reportText`，在历史列表中继续只读展示。现有遗留 `running` 记录按原有异常退出语义清理。迁移不尝试让 LLM 把旧报告补造成新结构。

## 8. 报告内容模型

第二次 LLM 只返回：

```ts
interface LlmStructuredContent {
  coreSummary: string[]; // 1..4
  sections: Array<{
    sectionId: string;
    status: "found" | "partial" | "not_found" | "not_disclosed" | "conflicting";
    summary: string | null;
    facts: Array<{
      text: string;
      timeContext: string | null;
      claimType:
        | "reported_fact"
        | "company_statement"
        | "plan"
        | "estimate"
        | "forecast";
      source: { title: string; url: string };
    }>;
  }>;
}
```

Harness 通过后，系统为核心结论、模块摘要和事实分配稳定 UUID，再形成 `generatedContent`。`editableContent` 从它复制而来，并为最小内容单元附加：

```ts
reviewStatus: "ai_generated" | "human_verified"
```

`generatedContent` 永不被编辑。`editableContent` 中的事实使用判别联合：未经编辑的 AI 事实保留 `timeContext`、`claimType` 和 `source`；一旦用户修改正文，该工作副本只保留稳定 ID、正文、来源基线 ID 和 `human_verified`，避免修改后的正文继续携带可能已经失真的 AI 时间、性质或来源。完整原始字段仍保存在 `generatedContent`。人工新增事实同样只要求正文和系统 ID，不伪造来源、时间或事实性质。

事实删除表现为从 `editableContent` 的可见事实数组移除。恢复时以 `generatedContent` 中相同稳定 ID 的单元为基线重新插入；界面提供已删除 AI 事实列表，使单条恢复仍然可达。恢复后的单元回到 `ai_generated` 并重新显示原来源。

模块发生人工事实增删改后，工作副本记录 `contentModified: true`，Renderer 隐藏该模块原有 AI 状态文案；这不改变模块中其他内容单元各自的 `reviewStatus`。

## 9. Harness 边界与修补

Harness 是确定性的纯逻辑，不联网，也不判断互联网事实真假。

它必须验证：

- JSON 可解析且只有允许字段；
- `coreSummary`、模块、事实和来源的类型与长度；
- 五个 `sectionId` 与模板集合及顺序完全一致；
- 状态与 `summary`、`facts` 数量关系；
- 每条事实恰有一个内联来源；
- URL 是合法 HTTP/HTTPS URL，且逐字存在于首次原始报告提取的 URL 白名单中；
- `not_disclosed`、`conflicting` 等状态满足可确定的结构约束；
- 所有文本经过大小上限控制，防止异常输出无限进入 IPC 和数据库。

系统级修补只处理不改变语义且结果唯一的问题，例如移除单个 Markdown JSON 围栏、截取唯一 JSON 对象、按模板重排已完整存在的模块。它不能补模块、改枚举、改 URL、生成摘要或事实。

系统修补后仍无效时，Application 最多触发一次不联网的格式修复调用。修复输出仍经过同一 Harness；失败则进入 `structure_failed`。完整第二阶段重试由用户触发，次数不硬限制，但成功后立即锁定。

“核心结论或摘要是否引入新事实”无法由简单确定性 Harness 可靠证明。MVP 通过严格 Prompt、最终事实集合约束和人工核验降低风险，不在产品或测试中宣称已经完成语义证明。

## 10. Worker 与模型调用

Worker 契约拆成阶段请求：

- `company-research.raw.run`：使用 DeepSeek Responses API，强制 `web_search`，流式发送原始 Markdown delta；
- `company-research.structure.run`：不提供工具，只接收上下文快照、模板快照、原始报告和输出 Schema；结果在 Worker 内聚合后作为完整候选 JSON 返回，不向 Renderer 流式展示半成品；
- `company-research.structure.repair`：不提供工具，只能在 Application 明确要求时执行一次受限格式修复。

每个事件包含传输 `requestId`、`runId` 和 `stage`，Application 拒绝身份或阶段不匹配的事件。取消由阶段对应的 AbortController 处理。

Prompt 将参考讨论稿中的已确认内容，但工程实现使用模板组装器生成，不复制四份独立长 Prompt。测试检查关键安全边界、工具设置、上下文字段和模块注入，不把整段文案快照作为唯一测试手段。

## 11. Application 命令与 IPC

公开能力按用户意图设计：

```text
start(itemId, companyId, input)
cancel(runId)
retryStructuring(runId)
getState(itemId, companyId)
listRuns(itemId, companyId)
getRun(itemId, companyId, runId)
updateCoreSummary(runId, summaryId, text)
updateSectionSummary(runId, sectionId, text)
updateFact(runId, factId, text)
addFact(runId, sectionId, text)
deleteFact(runId, factId)
restoreContentUnit(runId, unitKind, unitId)
```

编辑接口只接受运行 ID、目标 ID 和用户可编辑正文，不接受来源、状态、模板或整份工作副本。Application 必须确认运行属于 `completed` v1 报告、目标存在且命令合法，再在事务内修改单一工作副本并标记对应 `reviewStatus`。

`getState` 返回当前目标公司的活动运行，以及 `structure_failed`、新版 `completed` 和旧版 `completed` 的历史摘要；`listRuns` 使用相同集合和稳定倒序。完整报告内容只随选中运行读取，避免未来历史数量增加后每次传输全部 JSON。`getRun` 必须校验该运行仍属于传入的 Item—Company 关联，不能只凭全局 `runId` 读取。

## 12. Renderer 交互

### 12.1 启动

启动弹窗显示：

- 研究主题和目标公司：只读；
- 研究方向：四选一，必填；
- 本次具体研究范围：选填，可默认带入上次运行；
- 调研截止日期：日期输入，默认当天且不能晚于当天。

删除原“调研时间范围”和“补充要求”。

### 12.2 运行中与失败

- `researching`：显示“正在联网调研”、耗时、取消按钮和流式 Markdown 草稿；
- `structuring`：原始报告已可查看，显示“正在整理结构化报告”和取消按钮；
- `structure_failed`：原始报告保持可见，显示“整理失败，请重试”；
- 全局其他目标有运行时，开始按钮禁用并显示已有任务占用提示。

### 12.3 完成与编辑

历史选择器展示完成时间、方向和截止日期。新版完成报告提供“结构化报告 / 原始调研报告”切换；旧版报告只显示“旧版原始报告”。

结构化视图固定显示核心结论和五张展开卡片。AI 事实紧跟来源链接；被编辑或新增的单元显示“已人工核验”。编辑采用单元级保存/取消，事实支持新增和删除。已修改单元可恢复，已删除 AI 事实在对应模块的恢复区域中单条恢复。

所有模型文本按文本或安全 Markdown 子集渲染，不执行原始 HTML、脚本或事件属性。外部 URL 仅允许 HTTP/HTTPS。

## 13. 失败、并发与安全

- 首次调用失败、协议错误、空输出或用户取消：删除没有持久产物的本轮记录；已有历史不受影响；
- 原始报告持久化失败：不启动第二阶段；
- 第二阶段调用、解析、Harness、修复或最终事务失败：保留原始报告并进入 `structure_failed`；
- 第二阶段成功写入使用状态前置条件，重复完成事件不能覆盖结果；
- 已完成运行的 `retryStructuring` 必须拒绝；
- 编辑命令使用稳定 ID 和事务更新，过期或不存在的 ID 返回安全冲突错误；
- API Key 只进入 Worker 请求，不写日志、事件、报告或数据库；
- 原始报告中的任何指令都作为不可信资料，第二次 Prompt 明确包裹并拒绝执行；
- URL 白名单由原始 Markdown 实际解析，不接受模型新造或规范化后的 URL。

## 14. 测试策略

按风险分层测试：

1. Contracts/模板：输入 Schema、四模板五模块唯一性、内容联合类型和 IPC 参数；
2. Harness：合法样本、额外字段、模块缺失/乱序、状态组合、URL 注入、确定性修补、修复后复验和 ID 分配；
3. Persistence：旧数据迁移、阶段原子转换、崩溃恢复、JSON 读写、历史顺序和级联删除；
4. Application：双阶段成功、首次失败清理、原始报告后失败保留、重试、成功锁定、取消、重复事件和全局互斥；
5. Worker：首次强制联网、第二次无工具、Prompt 边界、流式解析、非流式 JSON、截断和取消；
6. IPC/Preload：新增命令参数校验、订阅和安全错误映射；
7. Renderer：启动输入、阶段切换、双视图、整理重试、旧报告、最小单元编辑、人工核验、删除和恢复；
8. 回归：全量单元测试、类型检查和桌面构建。

真实联网效果测试不替代自动测试。工程线路通过后，至少对两个不同方向各运行一家公司，检查来源 URL、原子事实粒度、缺失状态和二次整理稳定性。

## 15. 验收标准

- 用户能为当前主题中的一家公司选择唯一方向并启动调研；
- 首次调用只使用截止日期以内的信息并生成固定结构的 Markdown；
- 原始报告落盘后，即使第二阶段失败或应用退出也仍可查看；
- 第二阶段不联网，输出通过 Harness 后才成为结构化报告；
- 非原始报告 URL 无法进入结构化事实；
- 整理失败可重试，成功后同一运行不能再次整理；
- 新运行不会覆盖旧运行或其人工编辑；
- 核心结论、模块摘要和事实可以最小单元编辑；事实可新增、删除和恢复；
- 人工修改只标记对应单元，AI 基线和原始报告不变；
- 旧版自由结构报告仍可读取；
- 全局单活动任务、Chat 可并行和公司档案后台暂停规则继续成立；
- 聚焦测试、全量测试、类型检查和构建全部通过。

## 16. 已选方案与取舍

选择“原地升级现有 ResearchRun 主链”。它比新建平行子系统改动更多，但避免双套 Service、Worker、历史列表和 UI；也比 Worker 内部一次性串起两次调用更容易建立持久化边界、实现第二阶段重试并测试故障窗口。

MVP 有意使用 JSON 报告列而非立刻拆成事实、来源和编辑事件关系表。当前单报告规模小、没有跨报告查询和多人并发，JSON 能更快交付并保持运行快照完整。未来若出现事实级检索、跨报告复用、审计历史或协作需求，再以版本化迁移把内容单元正规化；本切片不提前承担该复杂度。
