# 第二批：源码职责归类实施计划

目标：在独立分支分步整理源码，每步必要测试通过后合并 main，不改变已验收行为。

## 全局约束

- 保留公共包入口、现有业务行为、提示词和持久化格式。
- Base 不依赖 Chat、Capability 或应用层；本批不强行迁移 Agent 到 Base。
- 不删除测试、用户材料、数据或当前安装包，不调用付费服务测试。
- 开发交给子 Agent，主 Agent 复核；仅运行受影响测试、类型检查和必要构建。

## Task 1: Application 按职责分目录

- 将 packages/application/src 下 chat-service、chat-service-helpers、chat-session-context、conversation-service、context-builder 及相关测试移入 chat/。
- 将 industry-research-service、company-* 服务、harness、validation 及相关测试移入 capabilities/company-research/。
- 将 tool-audit 和相关测试移入 tools/。
- 将 application-test-helpers 和 company-profile-test-fixtures 移入 testing/。
- ports.ts、index.ts 保留根目录；更新全部生产代码和测试导入，保持公共导出完全一致。
- 更新 docs/README.md 中源码导航，历史文档不做批量改写。
- 验证：typecheck、Application 测试、Base 架构测试、build；不运行 live 测试。
- 复核只发生移动和路径变化后提交，合并 main；作为第二批首个独立验收步骤。

## Task 2: Worker 按职责分目录

- 根目录保留 index、assembly、host-client、message-loop、message-loop-types、usage-runtime 及其测试和 message-loop-test-helpers：它们负责进程入口、装配、传输与消息生命周期。
- `agent/`：pi-chat-agent、agent-run-control、runtime-system-context、runtime-budget-context、tool-batch-admission 及对应测试、pi-chat-agent-test-helpers。保留已有函数名和执行逻辑；它是执行相关代码的归类，不代表已与 Chat 契约解耦。
- `chat/`：fake-chat-agent、select-chat-agent、pi-message-mapper、pi-session-transcript 及相关测试（包括 pi-session-continuity）。
- `capabilities/company-research/`：全部 company-profile-*、company-research-* 与 profile-diagnostic 及其测试、company-research-test-helpers。
- `tools/`：pi-tool-adapter、tool-runtime、tool-activity 及对应测试。
- 移动时同步更新所有相对导入（包括 main、shared 消费方及 vi.mock 路径），不创建旧路径转发层，不改公开符号、提示词、依赖版本或配置。
- 保持 electron.vite.config.ts 的 worker/index.ts 打包入口不变；更新 docs/README.md 的源码导航与残留耦合说明。
- 验证：先在当前基线执行 Worker 测试留下结果；移动后执行同组测试对比，不借此修复既有失败。执行 typecheck、build、Base 架构测试和 main/agent-worker-client、main/profile-diagnose-runner、main/company-profile-completer、shared/usage-collection 的定向测试。
- 复核重命名差异只包含路径改动，确认无新增失败后独立提交、合并 main。

## 后续边界

大型 pi-chat-agent 文件的函数拆分、Chat 契约中立化与 Base.Agent 抽取另作独立步骤，不混入本次目录移动。

## Task 3: Pi 执行器辅助模块拆分（2026-09-19）

本步骤在 Task 2 合并后独立实施；仍不改变行为，不迁移 Base，不添加新框架或依赖。

- `agent/pi-runtime.ts`：迁移现有 PiChatAgentError、SkillCatalogProvider、PiSession、PiAgentHandle、PiRuntime、PiToolSessionProvider、PiRunDiagnostic、defaultPiRuntime；现有 pi-chat-agent.ts 重新导出它们以保持消费者兼容。新模块不得反向依赖 pi-chat-agent.ts。
- `agent/pi-message-utils.ts`：原样迁移 hasProviderFailure、normalizedStopReason、assistantText、assistantTurnCount、hasToolCalls、serializedChars、modelInputCharsEstimate、assistantToolCalls、finalToolFreeAnswer、validateFinalAnswer。只对外导出需要使用的函数，不改正则、校验优先级或返回格式。
- `agent/pi-tool-results.ts`：原样迁移 CachedPiToolOutcome、parseToolFailure、resultBudgetConsumed、scopedActivityCallKey、reusedToolResult、reusedToolFailure、toolResultFailureCode、usableUrlsInText、parsedToolResult、NETWORK_TOOL_NAMES、filterRuntimeTools；保留去重、预算消耗和错误信息语义。
- `agent/finalization-prompts.ts`：原样迁移 SYNTHESIS_SYSTEM_PROMPT、SYNTHESIS_USER_PROMPT。
- `chat/chat-prompts.ts`：原样迁移 OFFLINE_SYSTEM_PROMPT、ONLINE_SYSTEM_PROMPT、CHAT_FORMATTING_SYSTEM_PROMPT。保持在原调用位置拼接，Capability 不新增 Chat 格式要求。
- `chat/pi-session-checkpoints.ts`：将当前 run 内 transcript 数组及 message_end 的 transcriptMessage→push→structuredClone→emit 封装为每次run新建的 collector；参数 requestId、emit；提供 record(message: AgentMessage): void。在原 !capabilityFinalization 分支、原事件位置调用，不改变 emit 同步性、错误传播或快照复制。历史 restoreSessionContext 保持原处和调用时机。
- `agent/pi-chat-agent.ts` 只替换上述定义为导入及 collector 接线，createPiChatAgent 其余闭包、回调顺序、取消/finalization 行为保持不变。
- 更新 docs/README.md 说明新文件职责，明确尚有 Chat 契约依赖；不把这一步称为完成 Base.Agent。
- 验证：typecheck、build，既有 agent/、chat/、company-research-agent、company-profile-agent、company-profile-run、assembly、shared/usage-collection 与 Base architecture 测试。先记录当前基线再作同组对比。必要新增 collector 的小型功能测试：快照不随后续记录改变、不同collector不串线、非持久化消息被忽略。不得新增机械行数或目录结构断言。
- 主Agent复核提取前后函数体/提示词一致、公共exports和错误instanceof保持同一实现；通过后独立提交合并。

## Task 4: Chat 会话行为与 Pi 执行循环的适配边界

- 将 `agent/pi-chat-agent.ts` 核心移至 `agent/pi-agent-executor.ts`，函数名 `createPiAgentExecutor`。原 `pi-chat-agent.ts` 保留小型兼容工厂，现有参数、默认值、exports 不变；它装配 Chat 行为适配器与执行器，不复制Loop。
- 新增 `chat/pi-chat-context.ts`，负责原位置的 restoreSessionContext、每run checkpoint collector、当前网络状态提示词、仅 main_agent 使用的 CHAT_FORMATTING_SYSTEM_PROMPT 和历史 provenance。通过 `prepareContext(request, model, emit)` 回调向执行器提供 messages、basePromptParts、finalizationPromptParts、sessionId、onMessageEnd。基础parts严格按原顺序：网络提示词，main_agent格式提示词，main_agent provenance（保留空字符串）；finalizationParts仅main_agent格式提示词。Capability仍恢复传入messages但不新增格式、provenance、checkpoint。
- `agent/pi-execution-context.ts` 定义上述回调及prepared结果类型，使用Pi消息/模型类型；作为Worker内接口仍允许AgentWorkerRequest/Event，必须在文档注明尚未成为Base独立契约。该接口和执行器禁止导入 `chat/` 实现。
- 执行器在原restore位置调用注入prepareContext，仅使用返回内容替代 restoredSession、硬编码Chat prompts、conversationId和checkpointCollector；onMessageEnd在原message_end位置同步调用。保留工具actor/Capability finalization/预算/stream/reset/诊断/取消/错误映射全部原逻辑，不为了统一而改写。
- `toolResultProjection` 从 `chat/pi-session-transcript.ts` 原样移至 `tools/tool-source-projection.ts`，执行器直接依赖工具模块，旧模块重新导出保持兼容。其过滤、原URL、字段限制与返回类型均不变。
- `pi-agent-executor.ts` 不导入ChatAgent返回类型，使用本地PiAgentExecutor run接口保持同签名；保留PiChatAgentError单一实现，暂不为改名改变错误name。
- 不改变Capability调用点，仍经兼容工厂获得旧行为；本步是行为注入边界，不宣称彻底移除Worker传输契约或完成Base.Agent。
- 最少新增验证：自定义prepareContext在不使用Chat实现时可执行，注入messages/prompts/sessionId和message_end回调有效；现有session continuity、generic Loop、Capability测试继续覆盖默认工厂。禁止添加重复框架或无意义目录断言。
- 测试与Task3同组先后对比，typecheck/build必做，不调付费服务，不修复10项既有company-profile-run失败。docs/README.md更新真实边界。
