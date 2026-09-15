# 公司调研失败历史、Markdown 与版本删除设计

日期：2026-09-16

## 目标

把每次非取消调研都作为可追踪的报告版本保存；让失败版本可以携带原始输入重新尝试；让原始报告获得与 Chat 一致的 Markdown 阅读体验；允许用户删除选中的终态版本。

## 产品语义

### 报告版本

公司调研版本包含五种状态：

- `researching`：正在联网调研，仅作为全局活动任务存在。
- `structuring`：原始报告已保存，正在结构化，仅作为全局活动任务存在。
- `research_failed`：原始调研未完成的终态版本，必须保存当次实际提交的研究方向、关注范围、截止日期和白名单失败代码。
- `structure_failed`：原始报告已保存、结构化失败的终态版本。
- `completed`：原始报告与结构化报告均已完成的终态版本。

用户主动取消 `researching` 或 `structuring` 时，删除本次活动版本，不产生失败历史；若该活动来自失败版本重试，也删除这个正在被复用的版本。应用启动时发现遗留的 `researching` 版本，转换为 `research_failed/incomplete_response`；遗留的 `structuring` 版本继续转换为 `structure_failed`。

### 新的调研与重新尝试

- 没有历史版本时，右上角显示“开始调研”。
- 选中成功版本或旧版报告时，右上角只显示“新的调研”。
- 选中 `research_failed` 或 `structure_failed` 时，右上角按顺序显示“重新尝试”“新的调研”。
- “新的调研”维持当前行为：打开普通调研表单，并以最近的新格式终态版本作为便利性初值；用户仍可修改所有字段。
- “重新尝试”打开表单，以当前选中失败版本的研究方向、关注范围、截止日期预填；用户可修改。
- “重新尝试”复用当前选中的失败版本，不新增列表条目；只有“新的调研”创建新版本。
- 重试提交后先完成输入与配置预检，再原地保存本次实际提交的研究方向、关注范围、截止日期，并刷新研究上下文、模板快照与本次开始时间。预检失败时保留原失败版本不变。
- `research_failed` 的重新尝试将当前版本原子转换为 `researching`，清除旧失败信息和旧产物，重置阶段尝试次数，启动完整联网调研。
- `structure_failed` 的重新尝试如果三个规范化输入均未改变，则将当前版本原子转换为 `structuring`，保留已保存的原始报告，只重跑结构化；任一输入改变则将当前版本转换为 `researching`，清除旧原始报告、结构化内容与失败信息，重新执行完整联网调研。
- 成功后当前失败条目直接成为成功版本；再次失败时仍是同一条目，但保存最新提交的字段。因此反复重试不会堆积失败条目，下次重试预填的是用户最近一次提交的值。

版本选择器对两类失败状态统一追加 `（失败待重试）`。失败版本正文区域显示安全、可操作的失败说明；`structure_failed` 仍可查看其原始报告，`research_failed` 没有伪造或残缺的正式报告正文。

## Markdown 呈现

原始调研报告、生成中的原始报告预览、结构化失败保留的原始报告和旧版原始报告，统一复用 Chat 的 `MarkdownMessage` 渲染边界：

- Markdown 标题、列表、表格、引用、代码与强调不再显示字面符号。
- 链接复用 Chat 已有的安全打开、悬浮明文 URL 和复制 URL 行为。
- 流式未闭合 Markdown 沿用 Chat 已有的容错渲染。
- 结构化报告继续使用 `StructuredResearchReport`，不经过 Markdown 二次处理。
- 用户或 Provider 文本仍不能注入原始 HTML；沿用 `react-markdown` 当前安全策略。

报告容器保留现有宽度、滚动和排版规则；如 Chat 的消息气泡样式不适用于报告，仅复用 Markdown 内容组件与链接行为，不复用气泡外壳。

## 删除行为

报告版本选择器旁显示“删除此报告”。按钮仅对当前选中的终态版本可用，活动调研期间禁用。删除前显示包含版本日期与状态的二次确认。

确认后删除：

- 选中版本的 run、原始正文、结构化内容与快照；
- 该 run 的模型诊断；
- 通过诊断 trace 关联的工具执行审计。

删除不影响同公司其他版本。删除后选择排序中的下一条最新版本；若无剩余版本，进入“还没有调研报告”状态。旧版 `legacy-freeform-v1` 也允许删除。后端必须再次校验 item/company/run 归属与终态状态，不能只依赖 Renderer。

## 数据模型与迁移

新增数据库迁移重建 `company_research_runs` 的状态与失败代码约束：

- `status` 增加 `research_failed`。
- `last_failure_code` 允许 `structuring_failed` 以及原始调研白名单失败代码：`tool_failed`、`model_failed`、`empty_report`、`protocol_leak`、`language_validation_failed`、`incomplete_response`、`protocol_error`、`storage_failed`。

`research_failed` 必须满足：无原始报告、无结构化内容、无完成时间、`structuringAttempts=0`、有原始调研失败代码。`structure_failed` 保持：有原始报告、至少一次结构化尝试、失败代码为 `structure_failed`。`completed` 的既有约束不变。

迁移保留所有现有行与索引。既有 `researching` 行不在迁移期间猜测失败；仍由启动恢复逻辑按上述语义处理。

## 应用与接口边界

### Repository

`CompanyResearchRunRepository` 增加：

- `failResearching(runId, failureCode)`：原子转换为 `research_failed`。
- `retryResearching(runId, input, researchContext, templateSnapshot, startedAt)`：把 `research_failed` 或输入已变化的 `structure_failed` 原子转换为 `researching`，保存最新输入并清空旧产物和失败状态。
- `retryStructuring(runId, startedAt)`：把输入未变化的 `structure_failed` 原子转换为 `structuring`，保留原始报告并清空失败状态。
- `deleteTerminal(itemId, companyId, runId)`：只删除归属匹配的终态版本。

诊断与工具审计 Repository 增加按 run/trace 的定向删除方法。Service 在同一事务内先取得 trace，再清理工具审计、诊断和 run，避免可见孤儿。

### Service

- 原始阶段失败：尽力持久化为 `research_failed`，再发出 `state_changed`。若连数据库写入本身失败，不能声称已经保留；保留安全 `storage_failed` UI 错误，并由启动恢复处理遗留活动行。
- 取消：继续走显式删除，不转换失败。
- 新增“重试失败版本”编排：先校验选中版本、提交输入与所需 LLM/Search 配置；再按是否为未修改的 `structure_failed` 决定原地重跑结构化或原地重跑完整调研。结构化重试只要求 LLM 可用，完整调研要求 LLM 与 Search 均可用。
- 新增删除终态版本编排；全局存在活动调研时拒绝删除，避免状态竞态。
- 所有失败消息继续使用白名单映射，不向 Renderer 透传 Provider 响应、密钥、路径或完整异常。

### IPC 与 Renderer

Desktop API 新增 `retryFailed(itemId, companyId, runId, input)` 与 `deleteRun(itemId, companyId, runId)`，使用现有 TypeBox 校验、可信适配器和固定参数数量约束。

Renderer 的 hook 负责：

- 加载选中失败版本详情；
- 以该详情打开重试表单；
- 提交后继续选中同一个 run，并以服务端返回的最新状态替换本地详情；
- 删除后从服务端刷新并稳定选择下一版本；
- 忽略旧目标或旧异步请求的迟到结果。

Panel 只根据选中版本状态决定按钮、失败标签、正文与禁用态，不自行推断失败原因。

## 测试与验收

采用 TDD，至少覆盖：

1. 数据库迁移保留既有成功/结构化失败报告，并接受、校验、列出新的 `research_failed`。
2. 原始模型、工具、协议、语言和不完整响应失败均留下带正确输入的历史；取消不留历史；启动恢复留下失败历史。
3. 重试表单预填选中失败版本；修改后同一失败版本保存最新值；再次重试读取最新值；反复失败不增加版本数量。
4. 未修改的结构化失败使用同一 run ID 原地重跑且不联网；修改输入后仍使用同一 run ID 走完整联网并清除旧产物；“新的调研”才增加版本数量。
5. 成功、失败、空状态的按钮文案与顺序；失败版本标签为 `（失败待重试）`。
6. 保存报告、流式报告、结构化失败原始报告和旧版报告均按 Chat Markdown 语义渲染，链接复制组件复用。
7. 删除成功、失败、结构化失败和旧版报告；归属错误、活动版本和全局运行期间拒绝删除；删除后选择正确版本。
8. IPC schema、arity、trusted adapter、preload 与 Renderer 类型契约完整。
9. 完整测试、typecheck、production build 和 macOS arm64 打包通过后再交付手测。

## 非目标

- 不保存或展示失败时的残缺模型正文。
- 不增加自动重试、失败次数上限或后台队列。
- 不修改搜索/抓取预算、LLM 输出预算或报告模板字段。
- 不改变 Chat 的消息生命周期。
- 不新增跨报告版本的父子关系或复杂审计 UI；版本历史本身即为用户可见记录。
