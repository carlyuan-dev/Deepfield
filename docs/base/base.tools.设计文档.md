# Base.Tools 设计文档

Tools 提供工具定义、参数与结果校验、注册、授权检查、执行、并发、重试、预算和审计端口。调用方提供工具集合、授权、额度、时钟与审计接收者；执行器按这些限制运行。

## 公开入口与装配

`@deepfield/base/tools` 是浏览器安全入口，提供 JSON／调用／结果／事件 Schema、工具定义与上下文类型、预算与审计契约、固定错误码和脱敏错误。安全入口不加载 Node、Search 运行时或 Pi。Schema 中的 `ToolFailure` 保持传输契约；`ClassifiedToolFailure` 是固定错误码的内部分类类型。

`@deepfield/base/tools/runtime` 提供 `ToolRegistry`、`ToolSet`、`ToolPolicy`、`ToolRunner`、`ToolBudgetLedger`、`TraceBudgetPool` 与可注入测试设施。`@deepfield/base/tools/web` 提供搜索、读取、抓取、解析与链接检查工具定义，使用 Base.Search 的服务与资源作用域。运行时核心不依赖 web 工具。

Worker 负责注册清单、工具授权选择、额度值、SearchSessionRegistry 与结束 trace 时的资源释放。`ToolAccessPolicy` 的联网／Agent 轮次策略与 Worker `ToolRunRequest` 留在 contracts。会话、HITL、Capability 工具由上层实现。Pi 适配器仍在 Worker，负责模型文本投影与可信结果 WeakMap，供上层证据处理使用。

## 执行、审计与取消

`ToolRunner.execute(call, context, signal, onEvent)` 校验输入与可信授权快照，预留预算及并发槽位，调用审计 start 后执行工具。`ToolDefinition.execute(input, context, signal, onProgress)` 接收该次调用的上下文和取消信号。注册后的定义与授权快照保持隔离，执行器不能修改调用方授权。

Runner 的总执行 deadline 在审计 start 之后开始，覆盖实际执行与重试退避。审计 start 失败时工具不得执行；finish 失败时结果为 `audit_failed`。审计端口 `start`／`finish` 只接收安全摘要；可选 `recordSynthetic` 记录上层决定不派发的终态调用。

Runner 准入拒绝、预取消及执行结果中的 attempts 至少为 1。上层 skipped／reused 合成记录使用 attempts 0、budgetConsumed false。此工具调用计数不同于 Search Usage 在真实 dispatch 边界记录的请求 attempt；Tools 不重复记录网络 Usage。

## 预算与 trace 生命周期

`ToolBudgetLedger` 通过 reserve／commit／release／complete 管理预留、消费和完成。每个逻辑工具调用最多 commit 一次，重试不重复扣工具额度。带 `commitOn: external_dispatch` 的工具在真实外部派发前调用 `markBudgetConsumed`，派发前失败释放未消费预留。总额度和各类别额度独立约束，类别耗尽不消耗其他类别可用额度；是否从模型工具清单撤下该类别仍由上层策略决定。

`TraceBudgetPool` 按 trace 保持账本。容量满时拒绝新 trace，不淘汰仍未释放的账本；`releaseTrace` 在存在活动 token 时返回 false，避免执行中重置预算。调用方确认 trace 结束后释放账本并协调 Search 资源与会话的释放。

## web 适配与可信数据

web 适配把 Search 错误映射到固定工具错误，将 traceId、projectId、可信 ToolSet fingerprint 绑定为 ResourceStore 作用域。缺失 fingerprint 时拒绝执行。Search 核心只认识资源作用域，不认识 ToolSet。

Provider／安全 HTTP 的 30 秒超时、web_search／read_webpage 的 40 秒工具总超时、解析工具 30 秒超时保持现值；web 工具 maxRetries 为 0。搜索的模型文本可以截断，但结构化可信 output 保持完整，Pi 适配器独立保存并供上层消费，不能把截断文本当作完整证据。

## 兼容与验证

`packages/tool-platform`、`contracts/tools` 的中立契约和 retrieval web 工具入口单向转出 Base；只有一份实现和 Schema 身份。旧入口供现存消费者与回归设施使用，在消费者全部迁移后可删除。Worker 的 TraceBudgetPool 旧导出同样保持类身份。

验证复用 Runner 准入、预算、取消、并发、重试、审计、输出与脱敏测试，Worker 运行时／Pi 适配集成，以及 retrieval 的 web 工具回归。Base 传递导入检查约束依赖方向，浏览器 bundle 验证安全契约隔离；真实 Provider 和桌面旅程按影响另行验收。
