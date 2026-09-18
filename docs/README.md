# 文档阅读地图

本文是当前文档入口，不新增架构层级。判断已实现行为时，以当前主线代码与对应测试为依据；日期型设计和实施计划记录当时的决策，不代表所有内容已经实现或仍然有效。

## 当前维护的文档

1. [开发指南](development.md)：运行配置、测试选择、报告行为与本地交付。
2. [Base 总览](base/base.overview.设计文档.md)：当前 Chat / Capability → Base 的单向依赖边界、能力目录和实施状态。
3. [Base Usage](base/base.usage.设计文档.md)：统一用量账本、统计口径、采集与看板。当前 Base 包只包含 Usage，不意味着其他通用模块已完成迁移。

## 源码导航

- `packages/application/src/chat/`：Chat 会话编排、上下文构建与会话相关测试。
- `packages/application/src/capabilities/company-research/`：公司研究能力、行业研究入口、校验与能力测试。
- `packages/application/src/tools/`：应用层工具审计实现与测试。
- `packages/application/src/testing/`：Application 及跨包测试共享的数据库 helper 与 fixture。
- `packages/application/src/ports.ts`：Application 对外部运行时与能力适配器的端口定义。
- `packages/application/src/index.ts`：Application 公共导出入口；目录调整不改变其公共 API。
- `apps/desktop/src/worker/`：Worker 入口、装配、主进程传输、消息生命周期与用量运行时。
- `apps/desktop/src/worker/agent/`：Pi Agent 执行与运行时契约；`pi-agent-executor` 保留执行循环，`pi-execution-context` 定义注入的会话上下文边界，`pi-chat-agent` 是保持旧 API 的兼容工厂。`pi-runtime`、`pi-message-utils`、`pi-tool-results` 和 `finalization-prompts` 分别承载运行时适配、消息判定、工具结果处理和终局提示词，运行控制、运行时上下文与工具批次准入保持为独立模块。
- `apps/desktop/src/worker/chat/`：Chat agent 选择、消息映射、Chat 提示词、会话转录与每轮 checkpoint 收集；`pi-chat-context` 将这些 Chat 行为装配为执行器上下文。
- `apps/desktop/src/worker/capabilities/company-research/`：公司档案与公司研究能力、提示词、诊断和测试 helper。
- `apps/desktop/src/worker/tools/`：Pi 工具适配、工具运行时、安全活动投影与工具来源投影。

已确认的 Chat / Capability 方向见 [Agent、Chat 与 Capability 边界设计](superpowers/specs/2026-09-15-agent-chat-capability-boundaries-design.md)，阅读时先看其中 **2026-09-18 更新**：通用 Agent 优先复用 Pi 原生机制；Chat 拥有会话与工具授权，Capability 拥有业务流程、输出契约与产物。旧文中的阶段收口设计不再作为通用 Chat 循环契约，当前总体职责边界以 Base 总览为准。

Worker 的 `pi-agent-executor` 不再导入 `chat/` 实现，Chat 提示词、会话恢复、历史 provenance 和 checkpoint 已由 `pi-chat-context` 注入；`pi-chat-agent` 继续实现旧 `ChatAgent` 工厂 API，Capability 调用点也仍经该兼容工厂进入执行器。`pi-execution-context` 仍使用 `AgentWorkerRequest` / `AgentWorkerEvent`，因此只是 Worker 内部行为边界，不是独立的 Base.Agent 契约，也不表示 Worker 传输契约已经移除。

## 历史决策与过程参考

`superpowers/specs/` 和 `superpowers/plans/` 下的日期型文件保留用于追溯背景、批准方向和实施过程，不作为当前实现的完整事实来源；同一文件中的后续更新可能覆盖早期章节。`manual-tests/` 记录特定切片的人工验收清单，也需结合当前代码使用。本轮不搬迁或删除这些材料。

常用背景：

- [LLM / Search 模块化设计](superpowers/specs/2026-09-11-deepfield-modular-llm-search-agent-loop-design.md)：Profile 与协议拆分背景。
- [公司调研历史设计](superpowers/specs/2026-09-16-company-research-history-design.md)：失败记录、原记录重试和版本管理背景。
- [批量公司调研设计](superpowers/specs/2026-09-17-batch-company-research.md)：批量编排背景。

正式工作目录与主线约定见[项目入口](../README.md)。临时 worktree、`.superpowers/` scratch 与可重建输出不属于当前文档入口；私人资料、应用数据与最新 release 的保留规则见开发指南。
