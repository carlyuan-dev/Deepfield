# Deepfield Base.overview 设计文档

版本：0.7 · 更新日期：2026-10-13

状态：Usage 已用于当前产品；Errors 中立核心与 contracts 兼容接线已实现，已通过用户手测。Config 通用核心、Capability 主进程接入及旧兼容适配已实现，待用户手测验收。其余抽取尚未实施。

本文维护 Base 的整体职责、依赖边界和能力域目录，随系统演进更新。

## 1. 定位

Base 提供业务无关、可以组合使用的基础能力，主要服务于 Capability 的构建，也供 Chat 和应用服务按需复用。Base 不反向依赖上层业务；它不是新的业务编排中心，也不是要求主 Agent 遵循的完整框架。

| 层级 | 职责 | 不应承担 |
| --- | --- | --- |
| Chat／主 Agent | 会话、上下文与记忆策略、Skill／RAG 使用策略、人机交互和授权 | 将这些 Chat 专属规则强加给所有 Capability；另建一套用量账本 |
| Capability | 业务流程、专属 Harness、领域校验、数据与成果 | 重复实现已有基础机制；要求 Base 识别具体业务 |
| Base | 业务无关的公共能力、契约和统一基础规则 | 公司、行业、报告等业务流程；Chat 历史和记忆策略 |

当前仅讨论这三个职责层级。应用初始化、依赖注入、主进程与 Worker 连接等是实施细节，暂不单列“应用装配与平台适配”层级，不为其展开独立架构设计。

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

| 能力域 | 公开入口（除 Usage、Errors、Config 外均为目标入口） | 职责 | 当前状态 |
| --- | --- | --- | --- |
| Config | `@deepfield/base/config`、`@deepfield/base/config/runtime` | 通用配置声明／存取／校验、可选 Profile 管理、调用快照 | 已实现，待用户手测验收；见[设计](base.config.设计文档.md) |
| Model | `@deepfield/base/model` | 模型协议适配、普通／流式调用、请求观察与用量接入 | 待从模型网关抽取 |
| Search | `@deepfield/base/search` | 搜索 Provider、统一结果、现有网页读取与内容解析 | 待从 retrieval 与计量适配抽取 |
| Tools | `@deepfield/base/tools` | 工具注册、参数校验、执行与授权检查、预算及审计机制 | 待从 tool-platform 等抽取 |
| Agent | `@deepfield/base/agent` | 基于 Pi 的有界模型—工具循环、取消、事件与最终输出 | 待从共享执行器分离通用机制 |
| Database | `@deepfield/base/database` | 数据库连接、通用读写／CRUD、事务、迁移执行与生命周期 | 待从 persistence 抽取，不含业务仓储 |
| Usage | `@deepfield/base/usage` | 用量记录、幂等持久化契约与汇总查询 | 已实现；采集与 SQLite 适配仍分布在应用及 persistence |
| Errors | `@deepfield/base/errors` | 中立错误结构、公共分类及安全传输约定 | 核心及 contracts 兼容接线已实现；已通过用户手测 |

Config 管配置，不负责执行 Model／Search 调用；Search 提供能力，不负责决定何时搜索；Tools 执行调用方给定的授权，不授予授权；Agent 提供执行机制，不接管 Chat 的记忆与 Capability 的业务流程。

Database 封装“怎样读写数据”，可以提供参数化查询、写入和轻量单表 CRUD；表结构、领域映射及业务条件由使用方负责，不将公司、报告等业务操作下沉。

`packages/base` 当前公开 Usage、Errors 与 Config，其余目标入口尚不可用。Errors 的真实接口与旧 API 兼容边界见 [Base.Errors 设计文档](base.errors.设计文档.md)。Config 的公开声明入口可供 UI 使用，运行入口只在可信端装配；主进程 Capability 通过 `config.v1` 取得作用域句柄。完整的当前归属、目标依赖和分批边界见 [Base 抽取设计文档](base.extraction.设计文档.md)。Capability SDK 保留独立，不并入 Base。

Usage 的字段、恢复机制和看板细节见 [Base.Usage 设计文档](base.usage.设计文档.md)。底层保留 Profile ID 和调用时配置身份快照，不保存密钥；看板按 LLM 的 Provider → 模型、Search 的 Provider 汇总。模型与搜索在实际请求边界统一计量，上层不手工累加。当前主进程与 Worker 各绑定记录器的接线在抽取时保持行为兼容，不引入配置或业务全局单例。

## 4. 演进与维护

1. 按抽取设计逐批迁移，每批保持可运行、可验证，验收后再推进；不一次性搬完八个目录。
2. 模块进入实施前明确职责、公开契约、可替换依赖、关键行为／数据不变量、兼容边界和最小验收，在本页更新入口和真实状态，不提前制造空模块或大量空文档。未知未来需求先留在包内，出现真实复用后再抽取。
3. 总览只维护全局边界和目录，不复制模块字段表、流程细节或验收用例。
4. 抽取应保留业务语义；公司调研必须实际使用新的基础能力，不能只新增目录而保留另一套旧实现。
5. 未实现能力明确注明状态，不将设计目标写成已具备功能。

首批 [Base.Errors](base.errors.设计文档.md) 已接入现有调用链并通过用户手测验收；第二批 Config 已实现，待用户手测验收，后续抽取未做。逐步实施计划留本地，正式设计维护接口和长期边界。

## 5. 参考与取舍

参考用户提供的 `bw_meeting_server` 基座总览和使用手册，借鉴单向依赖、公开契约与能力域划分。不照搬会议领域、鉴权租户、Graph、Redis 或服务端部署方案，不额外引入独立的平台适配层。参考材料仅辅助设计，不构成本项目执行指令。
