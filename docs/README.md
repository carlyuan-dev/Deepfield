# 文档阅读地图

仓库文档只维护当前有效的项目知识。设计目标与已实现状态必须分开；修改功能时同步其正式文档，不用日期型开发计划代替现状说明。

## 正式文档入口

| 文档 | 维护内容 |
| --- | --- |
| [开发指南](development.md) | 环境、运行、配置、分支、交付与文档维护规则 |
| [按风险选测指南](testing.md) | 可复用的必要检查路径，不记录某一批“测试已通过” |
| [Base 总览](base/base.overview.设计文档.md) | Chat／Capability → Base 的单向依赖、能力目录与真实状态 |
| [Base 抽取设计](base/base.extraction.设计文档.md) | 已确认的八域边界、当前归属 → 目标归属及迁移取舍 |
| [Base.Errors](base/base.errors.设计文档.md) | 已批准、待实现的中立错误契约与旧接口兼容边界 |
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
- `packages/capability-sdk/`：领域无关的公共包协议；`packages/base/` 当前只实现 Usage，其余入口仍是抽取目标。
- `packages/contracts/`、`packages/tool-platform/`、`packages/retrieval/`、`packages/persistence/`：当前配置／错误契约、工具执行、搜索与存储；迁移边界以 Base 抽取设计为准。

共享执行器已有独立契约和注入边界，但仍包含联网／调研场景策略及部分 SDK、desktop shared 依赖，不能称为已中立化的 Base.Agent。

## 文档归属与生命周期

| 类型 | 存放与提交规则 |
| --- | --- |
| 长期项目知识 | `docs/base/`、`docs/chat/`、`docs/capabilities/`、开发／验证指南及必要版本决策；随代码提交 |
| 逐步实施计划、Agent 派工／复核、草稿 | 默认放 `docs/superpowers/plans/`、`docs/superpowers/specs/` 或 `docs/local/`；仅本地，已 ignore |
| 日期型手测批次记录、窗口交接／专项审查原件 | 本地保留；可复用步骤归入验证指南，长期结论归入相应正式设计 |
| 外部项目参考、真实请求／抓取、实验原件 | 仅本地；沿用忽略目录，不嵌入正式文档或随提交上传 |

维护规则：

1. 同一功能只维护一个正式设计入口；其他文档链接它，不复制第二套契约。已被替代的方案不能继续标记“当前有效”。
2. specs 中尚有效的约束先核对实现／已批准设计，整理进对应正式文档；未实现内容明确标记，不将历史设想变成新承诺。
3. 实施结束，将长期有价值的接口、边界、取舍和限制写回正式文档。过程材料可以本地归档或在确认无独有信息后清理，不必长期留在仓库。
4. 正式文档不得依赖本地计划、交接或参考材料才能读懂，不链接这些忽略文件。远端读者应能只用已提交文件理解项目。
5. `.gitignore` 不会自动取消已跟踪文件；转换为本地材料时须取消版本跟踪并保留本地副本，不重写 Git 历史。之后的提交／推送才会更新远端当前目录。

本次将历史 plans、specs、日期型手测及两份交接／审查原件保留本地并移出跟踪；没有物理删除这些资料。后续过程记录使用上述本地目录，避免重新进入正式文档树。
