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

## Task 5: 执行器输入输出不再使用 Chat Worker 契约

前置：10项旧测试失败已在5165469修复；本步不得再容忍它们作为基线失败。

- 新增 `agent/pi-execution-contract.ts`：定义执行器实际所需的 PiExecutionRequest / PiExecutionEvent / PiToolSource，不通过 Pick/Omit/索引引用 AgentWorkerRequest/Event 或 Chat 类型。允许复用 LlmRuntimeSnapshot、SearchRuntimeSnapshot、ToolAccessPolicy 等现有中性配置类型，不迁移Base。
- request只包括requestId、prompt、systemPrompt、可选finalizationSystemPrompt/skillName/search、llm/toolAccess，以及用于原输入估算/已知URL提取的contextMessages（保留原对象内容，不改变估算字符数/URL来源）。不含kind=chat.prompt、conversationId、historyTurns、webSearch展示选项等Chat专用字段。
- event只包含执行器实际发出的 started、text_delta、text_reset、tool_activity、completed（如接口确需failed可保留），保留原字段形状、可选字段与skipped/reused要求budgetConsumed=false的约束；不含transcript_checkpoint。PiToolSource为url/title，不引用ChatToolSource。
- `pi-execution-context.ts` 的 PreparePiExecutionContext 改为接收原生Pi model，返回已存在Prepared结构；不接收Worker request/event。Chat adapter通过每run闭包捕获原request与emit，延迟在原core位置恢复上下文，避免改变错误处理时机。
- `pi-chat-agent.ts` 仍是唯一兼容装配入口：每run把原请求显式映射为中性输入、创建Chat preparer闭包并调用executor，执行器事件以结构兼容方式交给原emit；checkpoint仅由Chat闭包发出。构造executor时无副作用，保留原runtime/gateway默认对象创建时机及共享，不额外创建Agent/model session。
- `pi-agent-executor.ts` 更新字段引用与签名，不改Loop/预算/诊断/stream/收口/取消逻辑；不导入AgentWorkerRequest、AgentWorkerEvent、ChatToolSource或Chat实现。工具来源投影使用PiToolSource并保持旧导出兼容。
- 现有直接executor测试改用无Chat字段的输入；加最少1个兼容映射/双run隔离验证（或强化原有用例），证明旧工厂事件仍通过AgentWorkerEventSchema且history与checkpoint隔离。无需新增大套测试；现有continuity与Capability继续回归。
- docs/README准确记录：输入输出已独立于Chat Worker形状，但模型/工具/配置依赖仍在Worker，Base.Agent未完成。
- 必要验证：typecheck、build、Task4同组回归全部通过（允许原有1跳过），保留用户材料、不调用付费服务。

## Task 6: 执行依赖显式注入，默认实现留在装配入口

目标：不改变行为，移除 executor / runtime 契约对 desktop shared 具体模型、Search计量工厂与Skill目录实现的依赖；不迁移Base、不增加新架构层级。

- 新建 `agent/pi-executor-dependencies.ts`，只定义类型，`PiAgentExecutorDependencies` 包含必填 `runtime: PiRuntime`、`getApiKey: (snapshot: LlmRuntimeSnapshot, providerId: string) => Promise<string>`、`createSearchProvider: (snapshot: SearchRuntimeSnapshot) => SearchProvider`。`PiAgentExecutorOptions` 包含原 tools、skills、runtimeContext、toolSessions、toolActor、diagnosticSink（均可选，类型与原来一致）。允许继续依赖中性 contracts/retrieval/tool-platform 类型，禁止 shared / Chat 实现依赖。
- `createPiAgentExecutor(dependencies: PiAgentExecutorDependencies, options: PiAgentExecutorOptions = {})`：只更换函数入口，用局部解构保持原变量名与默认值；`getApiKey`接线从完整gateway改为依赖函数，Search工厂使用注入值。删除默认具体依赖及 `defaultPiRuntime` 的导出，保留错误类和运行时类型导出。Loop函数体、预算、提示词、取消、诊断与调用顺序不变。
- 新建 `agent/pi-default-runtime.ts`：从 `pi-runtime.ts` 原样迁移 `defaultPiRuntime` 以及 Agent/streamSimple/ModelGateway 相关导入。`defaultPiRuntime(gateway = new PiModelGateway())` 保持原实现（createStream可选，fallback streamSimple）；保留原生Pi Agent。`pi-runtime.ts`只保留接口和同一个错误类，不反向转出口默认实现。
- `pi-runtime.ts`的 `SkillCatalogProvider.get()`只要求 `Promise<{ formatInvocation(name: string, instructions: string): string }>`，不再导入PiSkillCatalog或要求list；现有完整目录结构兼容。不得重写Skill机制。
- `pi-chat-agent.ts`保留公共签名、参数默认值与创建时机；从新文件导入并重新导出 `defaultPiRuntime`。传入executor `{ runtime, getApiKey: (snapshot, providerId) => gateway.getApiKey(snapshot, providerId), createSearchProvider: searchProviderFactory }` 与options。显式闭包调用gateway，避免丢失this。特别注意原runtime默认拥有自己的gateway，不能借机合并两个gateway实例或改变用量采集链路。
- 现有直接executor两个用例改为显式最小依赖，不再要求完整ModelGateway；强化其中一个用例实际调用AgentOptions.getApiKey，断言snapshot/provider原样传入、返回值一致。最少增加/强化一个联网用例证明注入Search工厂被调用、其返回对象传给bindSearchProvider，而离线不创建Search；不新增大规模mock或目录行数断言。
- 更新docs/README真实说明：默认实现留在兼容装配入口，执行器消费显式依赖；配置、工具协议仍未迁入Base。不得声称彻底独立Base.Agent。
- 必要验证：先改直接测试观察入口不匹配RED，再实现。运行typecheck、build和以下受影响组一次（既有1 skip允许）：`npx --no-install vitest run apps/desktop/src/worker/agent apps/desktop/src/worker/chat apps/desktop/src/worker/capabilities/company-research/company-research-agent.test.ts apps/desktop/src/worker/capabilities/company-research/company-profile-agent.test.ts apps/desktop/src/worker/capabilities/company-research/company-profile-run.test.ts apps/desktop/src/worker/assembly.test.ts apps/desktop/src/shared/model-gateway.test.ts apps/desktop/src/shared/usage-collection.test.ts packages/base/src/architecture.test.ts`。不调用真实Provider、不打包应用、不修改用户数据。
- 子Agent不提交，由主Agent复核后提交、合并main并推送；保留用户未跟踪材料。

## 本批完成标准（2026-09-19 收口）

本批指第二批源码职责归类与执行器边界整理，不包含Base.Agent迁移。Task 7完成窄契约入口与边界守卫，Task 8进行整批验收和文档收口后结束，不再无限增加小步骤。仍保持现有Chat/Capability使用方式、所有运行行为、公共旧入口、持久化格式与安装包不变；不新增业务功能。

## Task 7: 配置与工具协议窄入口及执行器依赖守卫

- `packages/contracts/src/model-config.ts`：从settings.ts原样迁移纯LLM/Search配置定义（protocol/provider枚举、presets、base字段、draft/view/runtime snapshot、JsonOptions、SettingsField、SearchProviderManifest及类型）。不迁移SettingsView、DiagnosticResult、PublicAppError依赖；新文件只依赖TypeBox。settings.ts导入自己的3个view/manifest依赖并重新导出model-config，保留所有既有出口；Id等简单本地schema约束按原值保留，不能改变任何校验边界或schema结构。
- 将ToolAccessPolicySchema/类型从settings.ts原样移至tools.ts；settings.ts重新导出保持内部相对路径兼容。避免重复定义或新schema转换，旧root导出与新窄入口必须指向同一schema对象。
- 在contracts/package.json增加 `./model-config`→`./src/model-config.ts`、`./tools`→`./src/tools.ts` 公开入口，tsconfig.base.json加入对应精确path。现有 `.` 入口保持。
- `packages/tool-platform/src/budget-contract.ts`：原样承接 ToolMeterCategory、BudgetDimensionSnapshot、ToolBudgetSnapshot 三个类型，不依赖业务/执行器。definition.ts及budget.ts改为导入并重新导出原符号，保留根入口与内部消费者；不改预算实现。tool-platform/package.json增加 `./budget-contract` 入口和tsconfig精确path。
- retrieval现有search-provider.ts无业务依赖，直接公开 `./search-provider` 子入口和tsconfig精确path，不复制SearchProvider定义、不改其实现/错误class。
- 更新通用执行器闭包的生产imports：pi-execution-contract、pi-runtime、pi-executor-dependencies、pi-agent-executor、pi-tool-results、agent-run-control、runtime-budget-context、tool-batch-admission。配置走contracts/model-config，ToolAccessPolicy/批次/审计走contracts/tools，预算类型走tool-platform/budget-contract，SearchProvider走retrieval/search-provider。不要求全项目替换root imports，pi-chat-agent/default-runtime等装配文件仍可使用原入口。
- 新增最小契约兼容用例（contracts目录）：原root/原settings/新窄入口schema同对象；合法runtime snapshots和ToolAccessPolicy仍通过，空Key、越界policy等仍拒绝。主要依靠原contracts/tools/budget测试，勿新增重复大套case。
- 新增 `apps/desktop/src/worker/agent/pi-execution-boundary.test.ts` 轻量AST依赖检查，覆盖executor及三个核心契约入口的传递静态/动态/type import与re-export，允许原生Pi、TypeBox、node:crypto和明确中性子入口。拒绝Chat/Capability/shared/default-runtime/兼容factory、contracts/retrieval/tool-platform根总入口、其他apps层和不可解析的动态路径；允许核心agent模块和两个纯工具投影模块。使用现有TypeScript或babel解析器，不新增依赖。对实际源码图检查，并至少用小型负例证明经本地转出口绕回Chat或root总入口会失败。不得把type import一概跳过，也不得只靠文本grep。这个守卫是Worker执行器边界，不取代Base架构测试。
- docs/README说明窄入口用途，明确当前中性契约仍属于现有packages，尚未下沉Base；不增加层级、不改Base现有依赖规则。更新package exports不需要升级依赖或联网install。
- 验证：新增守卫在原宽入口上先RED，再作迁移。typecheck、build；一次受影响回归：`npx --no-install vitest run packages/contracts/src packages/tool-platform/src packages/retrieval/src/search-provider.test.ts packages/base/src/architecture.test.ts apps/desktop/src/worker/agent apps/desktop/src/worker/chat apps/desktop/src/worker/capabilities/company-research/company-research-agent.test.ts apps/desktop/src/worker/capabilities/company-research/company-profile-agent.test.ts apps/desktop/src/worker/capabilities/company-research/company-profile-run.test.ts apps/desktop/src/worker/assembly.test.ts apps/desktop/src/shared/model-gateway.test.ts apps/desktop/src/shared/usage-collection.test.ts`。不调用真实Provider、不打包、不碰用户数据。
- 子Agent实现并自审、不提交不暂存；主Agent独立审查、必要复验后合并推送。

## Task 8: 本批整体验收与文档收口

- 主Agent复核Task1至Task7的最终模块与依赖方向，确认旧公共入口、原生Pi Loop、Chat历史/checkpoint、Capability专属流程、用量接线仍各守职责。
- 在既有计划和docs/README中记录完成状态、已验证范围和剩余独立议题，不把本批完成描述为Base.Agent完整迁移。
- 完成一次面向当前完整结果的独立审查，聚焦跨步骤接线/出口/默认行为/依赖规则，不重复每一步的测试大套。发现本批问题交子Agent修复，必要定向回归。
- 最后运行typecheck、build及Application/Worker/边界相关必要集成测试；不以本批为由开启全仓库历史债务修复。真实Provider和UI手测由用户后续完成。
- 提交、合并并推送main；保留用户材料和最新安装包。报告本批成果、验证结果、尚未包含的后续事项，本批结束。

## 本批验收记录

状态：Task 1–8 已完成，第二批在此收口。2026-09-19 最终独立审查对 Task 7 规格/质量及整批接线均给出 PASS，无重要问题；核验范围涵盖单一Pi循环/错误类、默认依赖与计量、每run历史隔离、Capability流程和公共出口。

- Application与Worker按Chat、公司调研、工具、运行时职责归类；Application公共出口保留。
- Pi执行循环、运行时辅助函数和Chat会话适配分离；Chat管理历史/provenance/checkpoint，Capability仍保留专用流程与输出校验。两者继续复用同一原生Pi执行循环。
- 执行请求/事件为独立契约；模型密钥、运行时、Search工厂显式注入，默认模型和用量采集仍由兼容入口装配。
- 通用配置、工具协议、预算快照和Search Provider使用窄入口，旧出口保持；AST守卫递归检查依赖并校验package exports与TypeScript paths。
- 2026-09-19必要自动验证：契约/工具/Agent受影响组45文件462通过、1原有跳过；Application/Worker/Main接线组21文件361通过；类型检查与main/preload/renderer构建通过。不包含真实Provider、桌面真人操作或全仓历史债务验证。
- 10项既有公司档案测试失败已单独修复完整ModelGateway测试替身（5165469），未改生产行为或弱化断言。
- 未做事项：没有迁入Base.Agent，没有新增模型路由/工具或改变业务规则，没有改变数据库格式，也没有重打包本地release。后续Base迁移应独立设计公开API、依赖和兼容策略，不继续附加在本批目录整理中。
