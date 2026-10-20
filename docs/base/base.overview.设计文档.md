# Deepfield Base.overview 设计文档

版本：0.12 · 更新日期：2026-10-20

状态：八批实现已齐，实际消费者、公司仓储归属与作用域注入已收口，必要自动检查与代码复核通过。当前 Base.Model → Base.Agent → Base.Tools → Tavily 真实链路及 Usage 已验证；隔离打包界面与重启读回已通过，新公司包完整真实调研与用户体验仍待验收。Errors、Config 保留其此前已完成的用户验收范围；各域契约与证据边界见对应设计。

本文维护 Base 的整体职责、依赖边界和能力域目录，随系统演进更新。

## 1. 定位

Base 提供业务无关、可以组合使用的基础能力，主要服务于 Capability 的构建，也供 Chat 和应用服务按需复用。Base 不反向依赖上层业务。

| 层级 | 职责 | 不应承担 |
| --- | --- | --- |
| Chat／主 Agent | 会话、上下文与记忆策略、Skill／RAG 使用策略、人机交互和授权 | 将这些 Chat 专属规则强加给所有 Capability；另建一套用量账本 |
| Capability | 业务流程、专属 Harness、领域校验、数据与成果 | 重复实现已有基础机制；要求 Base 识别具体业务 |
| Base | 业务无关的公共能力、契约和统一基础规则 | 公司、行业、报告等业务流程；Chat 历史和记忆策略 |

“被多处使用”不是进入 Base 的唯一理由：能力还须职责清晰、接口业务无关、不需要反向了解调用者。Chat 不整体下沉，不强制通过 Base.Agent 执行；现有共享执行器能保留的部分继续复用，不能以共享为由限制主 Agent 的演进。

## 2. 强制依赖边界

依赖方向为 **Chat／Capability → Base**，禁止反向依赖。

- Base 不导入 `apps/desktop`、业务 application 服务、公司或报告仓储及其内部类型。
- 调用者使用 Base 公开导出，不跨模块导入内部实现。
- Capability 依赖稳定、精简的公开契约并显式声明依赖；运行服务沿现有 SDK／宿主注入接线，不暴露完整全局对象，也不为兼容适配新增架构层级。
- Base 内部演进保持公开契约与关键行为；内部版本、宿主接口版本、能力包版本分别管理。兼容边界、破坏性更新和旧包验收见抽取设计的 [公开契约与 Capability 兼容](base.extraction.设计文档.md#41-公开契约与-capability-兼容)。
- Base 可以执行符合其中立契约的注入实现，例如工具执行器、存储端口和观察器。这是依赖倒置，不是反向代码依赖；禁止在 Base 内导入上层实现、硬编码能力名称或读取上层全局状态。
- 来源、任务、阶段是调用方提供的普通标识；Base 不按业务类型分支执行领域逻辑。
- Settings 查询 Base 并负责展示；Base 不依赖 React、Electron、IPC channel 或页面组件。
- Base 能力域间逐项声明依赖，禁止循环依赖，不设万能公共出口。
- 用量账本、任务额度、业务进度和技术审计职责独立，可通过 ID 关联，不能互相替代。

实施时加入轻量依赖检查，约束源码 import、动态 import 和转出口，禁止直接或间接反向依赖；类型检查不能替代依赖检查。

## 3. 能力域目录

| 能力域 | 公开入口 | 职责 | 当前状态 |
| --- | --- | --- | --- |
| Config | `@deepfield/base/config`、`@deepfield/base/config/runtime` | 通用配置声明／存取／校验、可选 Profile 管理、调用快照 | 已实现，本轮验收完成；证据与范围见[设计](base.config.设计文档.md) |
| Model | `@deepfield/base/model`、`@deepfield/base/model/runtime` | 模型协议适配、普通／流式调用、请求观察与用量接入 | 本阶段自动验证完成，可交付 staging，待用户体验验收；范围见[设计](base.model.设计文档.md) |
| Search | `@deepfield/base/search`、`@deepfield/base/search/runtime` | 搜索 Provider、统一结果、现有网页读取与内容解析 | 已实现、自动检查通过，已完成代码复核，待用户体验验收；范围见[设计](base.search.设计文档.md) |
| Tools | `@deepfield/base/tools`、`@deepfield/base/tools/runtime`、`@deepfield/base/tools/web` | 工具注册、参数校验、执行与授权检查、预算及审计机制 | 已实现，Worker 已接入；契约见[设计](base.tools.设计文档.md) |
| Agent | `@deepfield/base/agent`、`@deepfield/base/agent/runtime` | 基于 Pi 的有界模型—工具循环、取消、事件与最终输出 | 已实现并接入共享执行路径；契约见[设计](base.agent.设计文档.md) |
| Database | `@deepfield/base/database`、`@deepfield/base/database/runtime` | 数据库连接、通用读写／CRUD、事务、迁移执行与生命周期 | 通用底座已实现，现有仓储使用同一连接的 Base view；公司仓储已回到能力包 |
| Usage | `@deepfield/base/usage`、`@deepfield/base/usage/runtime`、`@deepfield/base/usage/sqlite` | 用量记录、实例化 collector、幂等持久化契约与汇总查询 | 已实现；ALS、输送与生命周期留应用，SQLite 适配已归位并使用 Database |
| Errors | `@deepfield/base/errors` | 中立错误结构、公共分类及安全传输约定 | 核心及 contracts 兼容接线已实现；已通过用户手测 |

Config 管配置，不负责执行 Model／Search 调用；Search 提供能力，不负责决定何时搜索；Tools 执行调用方给定的授权，不授予授权；Agent 提供执行机制，不接管 Chat 的记忆与 Capability 的业务流程。

Search 核心不依赖 Tools，web 工具适配由 Tools 使用 Search。Agent 的类别预算耗尽只撤下对应工具，场景证据要求及收口由上层策略提供。上述目标模块均以安全入口公开契约，可信端 `/runtime` 承载执行实现。

Database 封装“怎样读写数据”，可以提供参数化查询、写入和轻量单表 CRUD；表结构、领域映射及业务条件由使用方负责，不将公司、报告等业务操作下沉。

Database 保持同库、同连接的同步事务；公司包自行构造仓储，宿主只提供数据库作用域和窄审计清理接口。已实现契约见 [Base.Database](base.database.设计文档.md)；迁移账本、受控 CRUD、注入与清理生命周期见[抽取设计的 Database 边界](base.extraction.设计文档.md#33-database-与业务仓储)。宿主与自有公司包同步升级，旧包与数据的兼容范围及更新方式见[公开契约与 Capability 兼容](base.extraction.设计文档.md#41-公开契约与-capability-兼容)。

`packages/base` 当前公开 Usage、Errors、Config、Model、Search、Tools、Agent 与 Database。Errors 的真实接口与旧 API 兼容边界见 [Base.Errors 设计文档](base.errors.设计文档.md)。Config、Model、Search、Tools、Agent 与 Database 均区分安全入口和可信端 runtime；主进程 Capability 通过 `config.v1` 取得作用域句柄。Model 的旧共享入口只做单向薄装配，SDK 精确特化其中立观察契约，见 [Base.Model 设计文档](base.model.设计文档.md)。Search 的旧 retrieval 服务入口单向转出 Base 实现，工具定义由 Base.Tools/web 适配，旧 retrieval 工具入口单向转出，见 [Base.Search 设计文档](base.search.设计文档.md)。完整的当前归属、目标依赖和分批边界见 [Base 抽取设计文档](base.extraction.设计文档.md)。Capability SDK 保留独立，不并入 Base。

用量在实际请求边界统一计量，上层不手工累加；字段、恢复机制与看板口径见 [Base.Usage 设计文档](base.usage.设计文档.md)。

## 4. 演进与维护

1. 按抽取设计逐批迁移，每批保持可运行、可验证，由 Agent 自验后独立提交；连续推进已授权范围，最终集中进行用户体验验收。
2. 模块进入实施前明确职责、公开契约、可替换依赖、关键行为／数据不变量、兼容边界和最小验收，在本页更新入口和真实状态，不提前制造空模块或大量空文档。未知未来需求先留在包内，出现真实复用后再抽取。
3. 总览只维护全局边界和目录，不复制模块字段表、流程细节或验收用例。
4. 抽取应保留业务语义；公司调研必须实际使用新的基础能力，不能只新增目录而保留另一套旧实现。
5. 未实现能力明确注明状态，不将设计目标写成已具备功能。
