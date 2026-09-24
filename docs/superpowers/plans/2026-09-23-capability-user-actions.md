# Chat 用户说明与公司调研操作补齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。用户已确认范围并要求进入开发，保留子 Agent 开发、主 Agent 复核、最小必要验证与默认打包。无提交授权。

**Goal:** 用户能通过简洁 Chat 操作公司调研全部现有业务，不必理解后台协议。

**Architecture:** 动态功能目录+确定性帮助；机器契约与用户呈现分离；包内领域动作委托现有服务、原队列和导出流程，不另写 Loop 或业务调度器。

**Tech Stack:** 现有 TypeScript、TypeBox、Pi、React、Electron IPC、SQLite；不新增框架。

**Spec:** `docs/superpowers/specs/2026-09-23-capability-user-actions-design.md`（已批准聊天设计的记录）。

## Global Constraints

- 当前 dirty develop 含此前已交付功能和用户评测材料；逐文件修改前备份，本轮 diff 以备份为基线，不覆盖或提交旧工作。
- 不调用真实 API、不更改用户 DB/资料/配置/密钥、不自动启动 Electron；最后打包需确认 app 退出。
- 主 Agent/宿主领域无关；工具元信息与启动 action 目录是单一来源；不自动开放内部 IPC。
- 模型需要的 ID 保留内部，用户默认看名称/业务状态；不全局删 UUID、代码或 URL。
- 删除与付费操作真实确认；添加/导入公司的自动补全如实计入消耗声明；导出保留原保存对话框。
- 子 Agent 不再派生 Agent，不提交/合并/推送；仅定向测试，修改冻结后回报路径、覆盖、证据、限制。

## Review Focus

1. 用户功能总览与具体业务请求混合时不得把执行请求吞成 help；关闭搜索不能误报 Capability 也不能联网。
2. 确认卡中文名称与机器目标一致，确认后修改参数不沿用原授权；空/非法展示不能绕过确认。
3. 批量提交、响应丢失、失败重试不得重复消耗，任务取消不能影响不属于该提交的队列条目。
4. 共享公司编辑与主题移除语义、结构化重试与新建报告语义准确。
5. 导出取消/页面未保存/切会话不会被宣称操作成功；包未启用时 help 和调用都不发布它。

## Task 1：Chat 帮助、用户输出与通用确认展示

**Files:** `packages/application/src/chat/{chat-service,capability-context}.ts`；新增同目录 help 模块；`apps/desktop/src/worker/chat/chat-prompts.ts`；工具注册元信息/适配窄入口；`packages/capability-sdk/src/actions.ts`；`apps/desktop/src/main/capabilities/{action-gateway,chat-host}.ts`；`apps/desktop/src/renderer/components/CapabilityChatCards.tsx`；必要 contracts/preload/装配和定向测试。

**Ownership:** 不修改 `capabilities/company-research/**`。Task2 消费本任务公开展示接口。

**Interface:** SDK `ActionDefinition` 可选 `presentInput(input: Static<I>): ActionInputPresentation | Promise<ActionInputPresentation>`；`ActionInputPresentation = {title:string; fields:Array<{label:string;value:string}>}`，运行时函数不进入编译清单；title/description 继续作为用户功能元信息。授权始终绑定实际 input，而非 presentation。确认输出可沿用 inputSummary 容器，渲染器须验形而不是任意对象打印。结构限长与安全回退由本任务集中定义并向 Task2 报告。

- [ ] 写定向失败用例：`/help` 只列可见功能、不跑 worker/LLM；`告诉我，你有哪些交互环境的出入口` 同模板；`帮我新建一个调研主题：大模型` 不被截走。
- [ ] 从实际 ToolSet/注入工具及 ready 目录获得用户名称描述；固定模板只有“工具”“能力”两组，空组显示简洁无可用项，不输出版本、schema、通用 bridge 或追问。
- [ ] 增强最终回答规则和自动续办提示，不要求输出技术引用；明确机器值只用于下一步调用，用户请求技术解释除外。
- [ ] 实现 `presentInput`、可信网关展示投影与人类可读确认卡；任务/查看卡不裸露原始 capabilityId/viewId/hash，使用已有名称或中性标签，不伪造业务成功。
- [ ] 保留会话事件/持久化、缓存授权、流式普通回答；定向测试、typecheck；报告与基线 diff 交 root。

## Task 2：公司调研业务动作覆盖

**Files:** `capabilities/company-research/actions/{definitions,register,handlers,task-artifact-adapter,drafts}.ts`（按主题/公司/调研拆小模块）；`docs/actions/*.md`；`capability.json`；必要 `application` 共享服务/事务回执；`ui/IndustryResearchCapability.tsx` 与导航适配；包内测试及 `tests/capabilities/chat-protocol.test.ts`。

**Ownership:** 不修改 Task1 宿主/Chat/SDK 文件。需要额外通用契约时先给 root；包存储沿用 opaque draft/task JSON，尽量不加宿主数据库结构。

**Interfaces:** 复用 Task1 `presentInput`；现有公开5动作保持兼容，公司包加法升级2.1.0。以 `main.ts` 私有服务注册为业务入口依据；新增动作而非自动代理任意 operation。TaskRef/ArtifactRef/ViewRef 保持领域无关。

- [ ] 为新增主题创建、非法/未确认删除、导入引发补全消耗、批量重试和导出取消写最小失败测试（Fake 模型/导出/配置）。
- [ ] 主题 CRUD、公司列表+完整详情、添加/识别导入/编辑/移除/补全重试/主体确认公开动作，输入采用已有 Schema；列表 bounded，名称映射由包维护。
- [ ] 单/批量调研、逐公司参数覆盖、失败重试与只重试结构化、队列 get/cancel/resume、单条 cancel 复用统一服务。扩展既有提交回执，在入队事务内绑定 invocation；整个提交集合可查/取消并保留真实产物，不能取消后加入的其他条目。
- [ ] 报告列表/读取/指定版本打开保持；增加删除和 Word 导出（原始/结构化选择），真实保存取消不得当成功。
- [ ] 增加主题公司列表等所需 view，复用未保存输入 guard。每项业务按钮对应 action 或 draft/navigation/task-control；全选/返回等纯UI状态不变成DOM工具。
- [ ] 所有写/消耗动作提供中文 `presentInput`：主题、公司、研究方向、重点范围、截止日期、影响范围，ID/hash不对用户展示；导出沿用保存对话框。
- [ ] 改写每个动作的独立说明，只讲该动作必要操作与业务结果解释；补 action coverage 表、定向测试/typecheck，提供报告与基线diff。

## Task 3：集成验收、文档与打包

**Owner:** 主协调者复核；需要代码修复交原实现者。更新 `docs/capabilities/capability.开发指南.md`、协议/总览与手测清单。

- [ ] 两任务独立审查（规格+质量），接口交叉核验；最后一任务审查同时覆盖全批集成，避免重复全仓审查。
- [ ] root 必要离线闭环：help→新建主题→公司列表/报告读取→付费或删除操作的中文确认/真实结果；typecheck、build、diff-check。无真实API自动调用。
- [ ] 同步开发规范：用户功能元信息、presentInput、每个业务按钮覆盖表及明确影响；加入非公司包兼容测试。
- [ ] app退出后本地arm64打包，校验ASAR与独立能力包，带备份更新已安装能力程序，保留DB/配置/密钥；交用户手测，未验收不宣称稳定。
