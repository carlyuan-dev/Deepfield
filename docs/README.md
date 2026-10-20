# 文档阅读地图

仓库文档只维护当前有效的项目知识。设计目标与已实现状态必须分开；修改功能时同步其正式文档，不用日期型开发计划代替现状说明。

## 正式文档入口

| 文档 | 维护内容 |
| --- | --- |
| [开发指南](development.md) | 环境、运行、配置、分支、交付与文档维护规则 |
| [按风险选测指南](testing.md) | 可复用的必要检查路径，不记录某一批“测试已通过” |
| [Base 总览](base/base.overview.设计文档.md) | Chat／Capability → Base 的单向依赖、能力目录与真实状态 |
| [Base 抽取设计](base/base.extraction.设计文档.md) | 已确认的八域边界、当前归属 → 目标归属及迁移取舍 |
| [Base.Errors](base/base.errors.设计文档.md) | 已实现并接入旧接口的中立错误契约；验收范围与兼容边界见正文 |
| [Base.Config](base/base.config.设计文档.md) | 已实现的通用配置、作用域接入与旧接口兼容；当前配置消费链路已验收，证据范围见正文 |
| [Base.Model](base/base.model.设计文档.md) | 模型安全契约、可信端 runtime 与实际接线；本阶段自动验证完成，可交付 staging，待用户体验验收 |
| [Base.Search](base/base.search.设计文档.md) | 搜索、网页读取／解析及计量边界；已实现、自动检查通过，已完成代码复核，待用户体验验收 |
| [Base.Tools](base/base.tools.设计文档.md) | 工具安全契约、执行／审计／预算与 web 适配；通用核心已实现，Worker 已接入 |
| [Base.Agent](base/base.agent.设计文档.md) | 通用 Pi 有界执行核、取消/事件及 Chat／Capability 场景接线 |
| [Base.Usage](base/base.usage.设计文档.md) | 已实现的用量账本、统计口径、采集与看板 |
| [Chat 运行机制](chat/chat.runtime.设计文档.md) | Pi 循环、工具许可、联网额度、历史与配置调用边界 |
| [Chat 人机交互](chat/chat.interaction.设计文档.md) | 询问／确认、真实表单共同编辑、任务范围授权与恢复 |
| [Capability 总览](capabilities/capability.overview.设计文档.md) | 可选包、启停、加载隔离与宿主边界 |
| [Capability 交互协议](capabilities/capability.protocol.设计文档.md) | 动作、页面、任务、产物及 Chat 双入口契约 |
| [Capability 开发指南](capabilities/capability.开发指南.md) | 当前 SDK、构建安装与独立示例包 |
| [公司调研设计](capabilities/company-research.设计文档.md) | 公司资料、统一队列、两轮报告、证据与导出规则 |

版本事实保留在 [0.1.1 发布记录](releases/2026-10-12-v0.1.1.md)；它描述该版本的验证与限制，不取代当前设计。Capability 包内 `docs/actions/` 与 `docs/help.md` 是运行时使用说明，属于产品契约，必须随包维护和提交。

## 源码导航

- `packages/application/src/chat/`：Chat 会话编排、上下文与人机交互；`packages/application/src/tools/`：应用层工具审计。
- `apps/desktop/src/worker/agent/`：共享 Pi 执行器及窄执行契约；`worker/chat/`：Chat 提示词、历史、溯源与 checkpoint 适配；`worker/tools/`：工具运行和活动投影。
- `apps/desktop/src/worker/capabilities/agent-runtime.ts`：Capability 直接装配共享执行器，不经过 Chat 上下文工厂。
- `capabilities/company-research/`：独立公司调研包，包含 application、runtime、ui、export 与 contracts。
- `packages/capability-sdk/`：领域无关的公共包协议；`packages/base/` 当前公开 Usage、Errors、Config、Model、Search、Tools 与 Agent，并提供对应 runtime 入口（Errors 除外）。Errors、Config 已验收，Model 本阶段自动验证与限定真实链路端测完成，可交付 staging，待用户体验验收；Search 已实现、自动检查通过，已完成代码复核，待用户体验验收；Tools、Agent 已实现并接入真实消费者；Database 与仓储归位尚未完成。各域的实现与验收范围见对应设计。
- `packages/contracts/`、`packages/tool-platform/`、`packages/retrieval/`、`packages/persistence/`：当前配置／错误兼容契约、工具执行、检索工具适配与存储；retrieval 服务入口单向转出 Base.Search，迁移边界以 Base 抽取设计为准。

Base.Agent 提供中立 Pi 执行核；Worker 的共享场景适配保留联网／调研策略，Chat 和 Capability 调用同一个 Base 核心。SDK 的窄执行契约单向复用 Base，职责与兼容边界见 Base.Agent 设计。

## 文档归属与生命周期

| 类型 | 存放与提交规则 |
| --- | --- |
| 正式项目知识 | `docs/base/`、`docs/chat/`、`docs/capabilities/`、开发／验证指南及必要版本决策；随代码提交 |
| 私人协作资料（仅本地） | 私人守则、个人经验／问题记录及 `.agents/skills/` 下的开发辅助 Skill；未来私人草稿和经验放 `docs/local/`，不使用 force-add 上传 |
| 逐步实施计划、Agent 派工／复核、草稿 | 默认放 `docs/superpowers/plans/`、`docs/superpowers/specs/` 或 `docs/local/`；仅本地，已 ignore |
| 日期型手测批次记录、窗口交接／专项审查原件 | 本地保留；可复用步骤归入验证指南，长期结论归入相应正式设计 |
| 外部项目参考、真实请求／抓取、实验原件 | 仅本地；沿用忽略目录，不嵌入正式文档或随提交上传 |

维护规则：

1. 同一功能只维护一个正式设计入口；其他文档链接它，不复制第二套契约。已被替代的方案不能继续标记“当前有效”。
2. specs 中尚有效的约束先核对实现／已批准设计，整理进对应正式文档；未实现内容明确标记，不将历史设想变成新承诺。
3. 文档归属由用途决定，不由保存时长决定。实施结束，将属于公共项目契约的接口、边界、取舍和限制写回正式文档；私人内容不会因长期使用转为公共资料，也不自动提炼上传，必要公开内容先取得用户明确许可。过程材料可以本地归档或在确认无独有信息后清理。
4. 正式文档必须自洽，不依赖私人协作资料、本地计划、交接或参考材料才能读懂，不链接这些忽略文件。远端读者应能只用已提交文件理解项目。
5. `.gitignore` 不会自动取消已跟踪文件；转换为本地材料时须取消版本跟踪并保留本地副本，不重写 Git 历史。之后的提交／推送才会更新远端当前目录。

文字取舍遵循 [AGENTS.md 的文字与文档约定](../AGENTS.md#文字与文档)。
