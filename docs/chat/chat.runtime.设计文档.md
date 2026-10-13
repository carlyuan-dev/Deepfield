# Chat Runtime 设计文档

更新日期：2026-10-13 · 状态：按当前代码维护的正式设计；本文整理不新增功能，也不代表重新验收安装包。

## 1. 定位与产品边界

Chat 是通用主 Agent，Conversation 独立于研究主题和 Capability 条目。启动进入 Chat；直接打开 Capability 可以收起 Chat，展开、收起或切换页面不终止正在执行的请求。Capability 可独立使用，不要求先存在 Chat 对话。

Chat 负责会话、历史与上下文策略、每轮工具开放、Skill 使用、流式展示及人机交互。Capability 负责业务流程、输入输出契约、产物与版本，不隐式继承 Chat 记忆。工具提供原子能力，不决定业务流程；Search Provider 不管理 Prompt、Agent 循环或额度。

人机交互、草稿编辑、任务范围授权、等待与恢复以 [Chat 交互设计](chat.interaction.设计文档.md) 为唯一详细说明。Base 的目标边界与迁移状态以 [Base 总览](../base/base.overview.设计文档.md) 和 [Base 抽取设计](../base/base.extraction.设计文档.md) 为准；共享执行器仍在 desktop Worker，不能据此宣称 Base.Agent 已实现。

## 2. 模型、搜索与请求快照

Settings 分别维护 LLM 和 Search Profile；允许保存多份，每类只有一个当前项，保存与激活是不同操作。一次运行解析请求范围内的配置快照，运行中切换设置不改变已开始的请求。

- LLM 使用 OpenAI-compatible Chat Completions 或 Anthropic Messages，协议与 Provider 预设不是同一概念。模型网关复用 Pi 的协议能力，不依赖 DeepSeek Responses 或服务商原生搜索。
- Search 独立于 LLM，通过 Registry 创建当前 Provider。可用项以 `packages/retrieval/src/providers/provider-registry.ts` 的 manifest 和 `packages/contracts/src/model-config.ts` 的配置 Schema 为事实源，包含已接入的豆包搜索 Custom；早期 benchmark 的候选淘汰、免费额度和价格记录不构成生产配置契约。
- API Key 经主进程 SecretStore 与系统加密能力保存；Renderer 不读取已保存明文，普通配置、历史、审计和错误不保存密钥或认证头。
- 未开启联网时不开放 `web_search`、`read_webpage`；开启只授予本轮网络工具权限，模型自行决定是否调用，不要求每条消息必须搜索。
- 连接诊断检查连接，不证明答案质量或来源可信。当前没有模型路由、Search 自动故障转移或多个 Provider 混合检索。

开发、诊断、Fake 模式和交付验证入口见 [开发文档](../development.md)。

## 3. Pi 循环与动态工具开放

主路径为 `ChatService → Worker → PiChatAgent → PiAgentExecutor → Pi AgentTool → ToolRunner`。Pi 承担模型工具协议与原生循环；Deepfield 补配置快照、权限、预算、持久化、事件和场景策略，不 fork Pi 或另建模型工具协议。

主 Agent 的当前循环契约：

1. Pi 顺序执行工具，调用与结果成对进入工作历史，结果继续供下一轮模型使用。
2. 模型自然输出无工具答案时直接结束，不强制追加一次成稿请求。
3. 每轮刷新可用工具与运行预算。网络类别耗尽或鉴权失败只撤下对应网络工具，不连带关闭计算、会话读取或 Capability 等其他工具。
4. 达到总模型轮次边界时预留最后一轮，移除全部工具并禁止 tool calling，保留完整调用/结果历史生成流式答案。

Capability 的专用调研收口仍可使用独立文本证据上下文；它不改变上述通用 Chat 契约。不能把早期“任何无工具输出都进入独立成稿阶段”“最终轮清除所有工具历史”套回 Chat。

工具开放由本轮授权、已启用能力目录和剩余额度决定。模型只能选择已提供的工具；联网关闭不等于所有工具关闭，Capability 被禁用不等于整个主 Agent 不可用。能力发现与业务动作由包协议提供，Chat 不硬编码公司字段或公司流程。

## 4. 预算、批次准入与失败

普通 Chat 当前默认总轮次为 6，联网搜索额度为 4，网页读取额度为 3；存在 Capability 目录时总轮次可提升到 16，交互恢复及任务结果续答使用专门的 8 轮策略。数值属于场景配置，不能当成 Pi 或 Search Provider 的通用限制。

| 控制点 | 契约 |
| --- | --- |
| 决策前 | 由唯一预算账本生成快照，更新 System Prompt 的运行预算区域，不向长期历史反复追加余额文本 |
| 批次准入 | 在 Provider 请求前按模型原顺序规划整个网络批次，区分 admitted、skipped、reused |
| 类别额度 | 搜索与读取独立；执行前拒绝或裁剪不消费，外部请求真正发出后即消费，失败也不返还 |
| 确定性复用 | 同一 run 内相同标准化查询/网址可复用已有结果；可重试失败允许新执行并消费新额度 |
| 最终轮 | 总轮次上限触发全工具关闭；保留历史并流式输出，不因某个网络类别额度耗尽立即终止普通 Chat |

ToolRunner 是实际执行边界，负责输入/输出校验、ToolSet 与权限、预算、有限重试、取消、超时和审计。Pi Adapter 从同一工具定义生成模型可见工具，确定性调用也经过同一 Runner。审计、任务额度和用量账本相互独立，可用关联 ID 对照，不能互相替代。

工具失败以安全错误码和必要上下文反馈模型与界面，部分网络失败不自动让整个回答失败；不得吞异常或将失败伪装成成功。语义查询去重、任务自适应预算、来源权威评分和检索 Planner 尚不属于当前 Chat 保证。

公开网页访问沿用 URL、地址、重定向、大小及超时限制，不携带浏览器 Cookie、不执行网页脚本、不绕过登录墙或验证码。

## 5. 会话历史、证据与溯源

本轮权限、历史执行、历史证据是三个独立事实。关闭联网禁止新增请求，不删除历史工具结果，也不把历史来源冒称本轮重新核实。

Chat 同时维护两种投影：模型上下文使用安全的会话 transcript；界面工具展开使用安全活动与审计。二者不靠把工具 JSON 拼入最终消息正文实现。

- 用户消息与助手消息绑定 requestId；工具 traceId 使用同一请求标识，恢复时归回对应助手消息。
- transcript 保存文本、工具调用及成对结果，按白名单移除隐藏推理、传输 details 和敏感参数；工具活动保存查询/网址、来源、数量、耗时、状态、错误和批次信息。
- 上下文目前取最近 40 条消息，相关 transcript 总体受 240,000 字符预算约束；不宣称已提供无限历史、向量记忆或自动上下文压缩。
- 恢复通过 Pi `buildSessionContext` 组装；历史联网权限、真实结果数量及成功数量另作来源说明，不推断“开启过联网就一定执行过搜索”。
- 搜索和网页内容作为数据证据，不能授予权限。搜索结果用于发现候选来源，本身不等于已核实事实；读取、来源展示和最终论证必须区分。
- 当前请求观察可关联工具来源与文本范围；会话恢复依靠保存的安全结果与来源投影，不保存完整原始 Provider 响应或不受控网页/PDF 副本。

手动 Skill 仅作用于本次请求，由已加载的标准 SKILL.md 目录选择；发送后清除选择，不将其永久加入后续对话规则。Skill 目录异常不应阻断普通 Chat。

## 6. 持久化与界面连续性

Renderer 长期控制器按 conversationId/requestId 管理流式草稿和工具活动；切换对话只改变当前选择。回复生成中可切走并返回，迟到事件不得污染新会话。滚动仅在用户接近底部时跟随，用户上翻后保留阅读位置。

主进程持久化 transcript checkpoint、工具活动和最终助手正文；不逐 token 写 SQLite。恢复历史时将会话活动与工具审计合并去重，已中断但存在持久化工具记录的请求可显示失败投影。已有 checkpoint 不代表应用重启后自动继续原模型流。

空闲对话可确认删除；活动对话禁止删除，不隐式取消 Agent。删除在同一事务中清理对应请求的工具审计及会话消息。首条用户消息触发一次标题生成，失败保留确定性标题，不因后续消息反复重写。

## 7. 搜索日期适配

相对日期先按当前运行日期转换成绝对起止日期。Provider 声明支持原生过滤时传结构化 `timeRange`；不支持时把相同绝对范围写入实际 query 并移除 `timeRange`，输出保留实际查询词，不能伪称原生日期过滤。模型省略 `maxResults` 时工具缺省为 5。

Search 层只标准化能力和结果，不负责证据覆盖、预算、循环或成稿。产品诊断、Chat 与 Capability 复用同一适配行为；Provider 的外部接口和价格随服务商变化，维护适配器时应重新核对。

## 8. 维护与代码落点

| 事实源 | 当前代码 |
| --- | --- |
| 请求、场景额度、终态与历史展示 | `packages/application/src/chat/chat-service.ts` |
| 最近消息与 transcript 预算 | `packages/application/src/chat/context-builder.ts`、`chat-session-context.ts` |
| 主 Agent 与 Capability 循环分支 | `apps/desktop/src/worker/agent/pi-agent-executor.ts` |
| 网络额度与批次规划 | `apps/desktop/src/worker/agent/agent-run-control.ts`、`tool-batch-admission.ts` |
| 安全 transcript、恢复和语言锚点 | `apps/desktop/src/worker/chat/pi-session-transcript.ts`、`pi-chat-context.ts` |
| 工具活动与来源投影 | `apps/desktop/src/worker/tools/tool-activity.ts`、`tool-source-projection.ts` |
| 持久化会话记录 | `packages/persistence/src/chat-session-repository.ts` |
| Search 标准契约及日期适配 | `packages/retrieval/src/search-provider.ts`、`search-tool.ts` |

改动上述行为时同步本文；具体交互与 Base 边界只维护其对应正式文档。长期研究产品路线、早期 benchmark 过程和尚未实施的多 Agent 编排不应作为当前 Chat Runtime 的实现声明。
