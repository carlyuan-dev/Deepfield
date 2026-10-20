# Base.Agent 设计文档

版本：0.1 · 更新日期：2026-10-20

状态：通用 Pi 执行核已实现，Chat 与 Capability 的实际执行路径已接入；自动验证完成，最终用户体验待验收。

## 1. 职责与入口

Base.Agent 基于 Pi 0.84.3 执行模型与工具循环。提供有界轮次、工具收缩、取消、生命周期、阶段事件与最终答案校验。普通调用无需 Chat 或调研策略即可执行。

| 入口 | 内容 |
| --- | --- |
| `@deepfield/base/agent` | `PiAgentRequest`、`PiExecutionEvent`、上下文文本/来源契约、只读 `AgentHandoff`、`PiAgentError`；可用于浏览器 |
| `@deepfield/base/agent/runtime` | `PiSession`、`PiRuntime`、`PiAgentHandle`、`createPiAgentRun`、`createPiAgentExecutor` 与消息工具；仅可信执行端 |

安全请求包含 requestId、prompt、systemPrompt 和 maxAgentTurns。运行端的 `PiAgentExecutionRequest` 再提供 session、tools、可选 messages、getApiKey 与 handoff。模型会话由调用方绑定已解析快照，Agent 不读取 active Profile。模型网关在实际请求边界记录 Usage，Agent 不重复计量。

`createPiAgentExecutor().run(request, emit, signal)` 是普通使用入口。默认 messages 为空；调用方显式提供自己的上下文。模型自然输出无工具答案时结束；工具轮由 Pi 原生继续。

`createPiAgentRun(options, limits, createAgent?)` 是可信场景适配入口。注入 Pi AgentOptions 及可选运行工厂，返回一次性 handle；`run(prompt, signal)` 返回 completed/text 或 handed_off。handle 的 subscribe/followUp 支持上层观察与场景后续提示，单个 handle 只允许启动一次。默认工厂使用原生 Pi Agent。

## 2. 循环与工具不变量

maxAgentTurns 必须为正安全整数，表示本次运行最多模型轮数。Base 在 Pi 每次完成一轮后的原生回调中递增私有计数，历史助手消息不消耗本次额度，场景对上下文或 newMessages 的裁剪不改变计数。maxAgentTurns=1 时首轮就是无工具轮；完成 maxAgentTurns−1 轮后，下一轮清空 tools，并设置 toolChoice=none。无工具最终轮不能再执行模型虚构的工具调用。

初始工具对象是本次执行的授权上界。prepareNextTurnWithContext 或 prepareNextTurn 可提供更新后的上下文；Base 对工具取当前已准入集合的交集，保留原工具实现。撤下后不能通过后续 hook 恢复，也不能增加新工具。工具类别额度由上层读取 Tools 预算并撤下对应工具；其他工具仍可使用。

场景 hook 可以提前结束、调整提示与上下文，但 Base 在组合 hook 后仍强制全局轮数、取消、handoff 和最终无工具约束。工具顺序执行，调用与结果由 Pi 成对收束。

## 3. 事件、取消与结果

普通执行器发送 started、text_delta、text_reset、tool_activity、completed 或 handed_off。工具轮前言在出现 tool call 后通过 text_reset 撤回；工具活动只包含工具名、调用标识和状态，不包含原始参数或工具返回。成功终态最多一次。执行失败拒绝 Promise，由调用者映射应用错误事件。

调用前已取消时不启动 prompt；运行中 AbortSignal 触发 Pi abort，结束后清理订阅与取消监听。失败保持 provider_failed、stream_failed 或 incomplete_lifecycle 等中立分类，不回显原始 Provider 错误。最终文本为空、包含工具协议或最终消息仍包含工具调用时不能成功。语言指令由上层提供，Agent 不用字符检测删除合法代码或英文输出。

handoff.isRequested 是本次运行的中立交接信号。当前工具批次仍完成调用/结果配对，随后工具被阻止执行，批次后不再请求模型，返回 handed_off。真实人工确认、持久化与恢复授权由 Chat 管理；恢复通过新的执行请求进入。

## 4. 实际消费者与策略归属

Chat 和 Capability 的旧 `pi-agent-executor.ts` 入口单向转出应用 `pi-execution-policy.ts`。后者装配同一个 Base createPiAgentRun，不再自建取消、生命周期与最终答案验收机制。

| 归属 | 内容 |
| --- | --- |
| Base.Agent | 原生 Pi loop 的边界控制、通用模型/工具会话、取消、消息文本工具、终态校验与普通执行器 |
| Chat | Skill、历史映射、transcript/checkpoint、语言锚点、持久化与 HITL 恢复 |
| 应用场景适配 | 网络许可、预算 planner、批次复用、鉴权失败撤工具、安全活动与诊断 |
| Capability 调研策略 | 自然停止后的 synthesis、专属预算/空批次收口、16000 UTF-16 文本证据裁剪、hash/origin、最终格式提示 |

Capability prepareContext 保持 messages=[]。prepareContext 仍是运行开始时的一次性准备；每轮变化沿原生 Pi hook 注入。证据来源使用工具运行端提供的可信通道，研究证据不搬入 Base，也不从模型文本反构可信工具结果。

SDK 的 execution 子入口单向转出中立上下文/来源/事件，并将旧应用请求映射到自身兼容契约。旧请求的 search、skillName、toolAccess、humanPrompt、finalizationSystemPrompt 保持应用语义，不能作为 Base 通用请求。model-observation 子入口保留 SDK 对中立 Model 观察类型的特化。Base 不导入 SDK、contracts、Chat 或公司包；边界检查仍拒绝 SDK 聚合出口。

## 5. 验证范围

独立 Base 执行覆盖普通无研究调用、max=1/2、历史不计轮、工具撤销后其他工具继续且不能恢复、预取消与非法最终协议、安全入口浏览器构建。实际消费者沿用 Chat generic-loop、HITL、会话 checkpoint/continuity、Capability 无历史、模型观察/证据裁剪与失败回执保护。Pi 与 Base 依赖边界检查约束精确入口及传递依赖。

本模块自动验证不证明真实 Provider 自然语言遵从、报告质量或桌面交互体验；真实调用与最终用户体验按项目既有验收流程执行。
