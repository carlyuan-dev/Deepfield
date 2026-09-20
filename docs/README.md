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
- `packages/contracts/src/model-config.ts`、`packages/contracts/src/tools.ts`、`packages/tool-platform/src/budget-contract.ts` 与 `packages/retrieval/src/search-provider.ts`：为通用执行器提供配置、工具协议、预算快照和搜索 Provider 的窄入口，避免执行器依赖各包根总入口；旧根入口与 `settings` 兼容出口继续保留。
- `apps/desktop/src/worker/`：Worker 入口、装配、主进程传输、消息生命周期与用量运行时。
- `apps/desktop/src/worker/agent/`：Pi Agent 执行与运行时契约；`pi-execution-contract` 定义不依赖 Chat Worker 形状的执行请求、事件与工具来源，`pi-agent-executor` 保留执行循环并只消费显式注入的运行时、密钥读取与搜索 Provider 工厂，`pi-execution-context` 定义注入的 Pi 会话上下文边界，`pi-chat-agent` 是保持旧 API、装配默认具体实现的兼容工厂。`pi-runtime` 只定义运行时契约，`pi-default-runtime` 提供默认 Pi 实现；`pi-message-utils`、`pi-tool-results` 和 `finalization-prompts` 分别承载消息判定、工具结果处理和终局提示词，运行控制、运行时上下文与工具批次准入保持为独立模块。
- `apps/desktop/src/worker/chat/`：Chat agent 选择、消息映射、Chat 提示词、会话转录与每轮 checkpoint 收集；`pi-chat-context` 将这些 Chat 行为装配为执行器上下文。
- `apps/desktop/src/worker/capabilities/company-research/`：公司档案与公司研究能力、提示词、诊断和测试 helper。
- `apps/desktop/src/worker/tools/`：Pi 工具适配、工具运行时、安全活动投影与工具来源投影。

已确认的 Chat / Capability 方向见 [Agent、Chat 与 Capability 边界设计](superpowers/specs/2026-09-15-agent-chat-capability-boundaries-design.md)，阅读时先看其中 **2026-09-18 更新**：通用 Agent 优先复用 Pi 原生机制；Chat 拥有会话与工具授权，Capability 拥有业务流程、输出契约与产物。旧文中的阶段收口设计不再作为通用 Chat 循环契约，当前总体职责边界以 Base 总览为准。

Worker 的 `pi-agent-executor` 输入输出已独立于 Chat Worker 形状，且不导入 `chat/`、desktop shared 具体模型、Search 计量工厂或 Skill 目录实现；Chat 提示词、会话恢复、历史 provenance 和 checkpoint 由 `pi-chat-agent` 在每次 run 经 `pi-chat-context` 适配。`pi-chat-agent` 继续实现旧 `ChatAgent` 工厂 API，并在兼容装配入口保留默认模型运行时、密钥读取与 Search 计量实现；Capability 调用点也仍经该兼容工厂进入执行器。执行器通过上述窄入口依赖现有配置与工具协议；这些中性契约仍属于现有 packages，尚未下沉 Base，也没有增加新的架构层级或改变 Base 依赖规则。本边界不是 Base.Agent，也不表示 Worker 传输契约已经移除。

## 历史决策与过程参考

Capability 包化目标见 [Capability 架构设计文档](capabilities/capability.overview.设计文档.md)（2026-09-20 草案，待审阅）：自有可信包、启动扫描与按需加载、统一动作协议、Chat 渐进说明加载，以及 Capability A 的迁移边界。当前代码尚未实现该加载协议。

本轮源码整理的范围与验收记录见[第二批源码职责归类](superpowers/plans/2026-09-18-source-organization.md#本批验收记录)：完成职责归类、执行器适配/依赖拆分和窄契约守卫；不包含Base.Agent迁移、业务功能变更或安装包更新。

`superpowers/specs/` 和 `superpowers/plans/` 下的日期型文件保留用于追溯背景、批准方向和实施过程，不作为当前实现的完整事实来源；同一文件中的后续更新可能覆盖早期章节。`manual-tests/` 记录特定切片的人工验收清单，也需结合当前代码使用。本轮不搬迁或删除这些材料。

常用背景：

- [LLM / Search 模块化设计](superpowers/specs/2026-09-11-deepfield-modular-llm-search-agent-loop-design.md)：Profile 与协议拆分背景。
- [公司调研历史设计](superpowers/specs/2026-09-16-company-research-history-design.md)：失败记录、原记录重试和版本管理背景。
- [批量公司调研设计](superpowers/specs/2026-09-17-batch-company-research.md)：批量编排背景。

正式工作目录与主线约定见[项目入口](../README.md)。临时 worktree、`.superpowers/` scratch 与可重建输出不属于当前文档入口；私人资料、应用数据与最新 release 的保留规则见开发指南。
