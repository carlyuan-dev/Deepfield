# Deepfield Base 抽取设计文档

版本：0.2 · 日期：2026-10-13

状态：用户已确认总体设计，并确认补充 Database 的通用 CRUD 边界。本文件确定目标边界和分批迁移顺序，不表示已完成抽取，也不是一次性执行全部迁移的实施计划。

代码核验基线：`7d99619`（0.1.1）；本轮仅调整文档。

## 1. 目标与取舍

让新的 Capability 能使用现成的配置、模型、搜索、工具执行、轻量 Agent、数据库、用量与错误能力搭建业务，避免能力增多后重复拆解。公司调研作为第一个真实消费者完成迁移，不能停留在接口设计或目录搬家。

主 Chat／主 Agent 的完善优先：允许按需使用 Base.Model、Base.Tools、Base.Usage 等，不强制使用 Base.Agent。当前 Chat 与 Capability 已经共用 Pi 执行器，保留有价值的复用，不另起一套循环；会话、上下文清理、记忆、Skill、RAG 使用策略和人机确认仍由 Chat 管理。

选择“沿现有边界逐批替换实现”：每批切换真实调用点，旧入口必要时单向转出兼容，验证后移除重复实现。暂不选择以下方案：

- 仅把现有包整体改名为 Base：变更少，但会把业务分支和上层依赖一起搬进去。
- 先设计完整通用框架再重写：扩展空间大，但会同时改变配置、Loop、存储和业务行为，难以定位回归。

本轮不新增平台适配层、不替换 Pi、不引入新数据库或工作流框架，不顺带修改产品交互、提示词效果、搜索策略和报告规则。

## 2. 当前归属 → 目标归属

以下路径是当前代码证据，不是承诺逐文件原样搬迁。

| 当前归属 | 目标归属 | 留在原职责方的内容 |
| --- | --- | --- |
| `apps/desktop/src/main/profile-store.ts`；`packages/contracts/src/model-config.ts` | Config：Profile、选择、草稿／视图／快照及中立配置定义 | Electron 密钥加密、Settings UI、IPC 和诊断编排留桌面应用 |
| `apps/desktop/src/shared/model-gateway.ts`、`model-request-observation.ts` | Model：调用与请求观察；中立观察契约随之下沉 | 公司证据如何接收、冻结、使用请求记录留 Capability |
| `packages/retrieval` 的 Provider／读取解析实现；`shared/usage-search.ts` | Search：服务能力与计量接入 | 联网许可、检索任务策略不进入 Search；web 工具定义归工具适配 |
| `packages/tool-platform`；Worker 工具运行时中的通用部分 | Tools：定义、注册、执行、准入与审计端口 | Chat 会话工具实现、HITL 授权、业务工具及应用装配留上层 |
| `apps/desktop/src/worker/agent` 的共享执行器；SDK 中中立 execution 契约 | Agent：Pi 循环与运行控制 | Chat 上下文和调研专属收口策略留各自适配器 |
| `packages/persistence/src/database.ts`、`transactions.ts`、迁移执行机制及仓储重复的参数化执行 | Database：连接、通用读写／CRUD、事务和迁移执行 | Chat／公司／报告表与仓储归各自模块；旧迁移保留兼容 |
| `packages/base/src/usage`；`shared/usage-collection.ts`；`persistence/usage-repository.ts` | Usage 核心保留；通用采集和 SQLite 适配逐步归位 | Settings 展示、主进程／Worker 传输与初始化留应用 |
| `packages/contracts/src/errors.ts` | Errors：中立结构、公共分类和序列化机制 | 业务错误码、恢复动作、用户文案与边界白名单归各模块 |

当前必须承认的边界缺口：

1. 共享 Agent 不依赖 Chat 历史实现，但仍内置 `WEB_CHAT_POLICY`、搜索／读取额度及 Capability 分支，不能整体视为已中立化。
2. Model 和 Agent 的部分中立契约仍来自 Capability SDK；下层依赖插件 SDK 的方向需要调整。
3. 主进程仍组装 `company-research.repositories`，能力包依赖 persistence 的聚合仓储类型；公司数据层尚未完全回到包内。
4. 现有 `schema_migrations` 1–32 混合多模块表结构，不能因归属变化重排、重跑或删除历史迁移。

## 3. 模块边界

### 3.1 Config、Model、Search 分开

Config 统一管理“使用哪个配置、字段是否合法、如何保存、怎样生成一次调用的快照”。首批保留 LLM／Search 两类配置；相关 Schema、Profile 契约与默认值放在 Config 的独立子域，不与服务执行代码绑定。

新增配置沿用公共存取与校验机制，提供自己的声明式定义；不要求所有配置都有 Profile，也不让新增配置把业务流程带入 Config。先支持实际需要的两类，不预建复杂配置注册平台、YAML 继承系统或自动环境变量扫描。

- Model 消费 LLM 快照，处理 OpenAI／Anthropic 协议、普通及流式请求、错误和请求观察。
- Search 消费 Search 快照，处理 Provider 请求、结果统一、网页读取和解析；不是完整 RAG，也不负责多轮搜索决策。
- Config 不调用 Model／Search；“测试连接”继续由应用编排 Config 的草稿解析与对应服务调用。
- 默认 URL、Provider 元数据等以中立配置定义提供，Config 不反向导入 Model／Search 运行时。

维持三个数据视图：可编辑 Draft、脱敏 View、可信执行端 RuntimeSnapshot。未保存可诊断、保存与激活分开、切换 Profile、未修改密钥时复用已有凭据等行为保持不变。执行中不得重新读取 active Profile 偷换配置；新任务及显式重试按现有时机解析新快照，不借本次迁移改变队列和阶段的配置读取时机。快照中的嵌套选项也不能被后续编辑污染。

密钥通过注入的 SecretStore 端口管理，Electron `safeStorage` 实现留桌面。明文密钥仅进入可信运行端，不能进入 Renderer、日志、错误详情或 Usage；Usage 保留的是不含凭据的配置身份快照。

### 3.2 Tools、Agent 与主 Agent

Tools 管理工具定义、参数校验、注册、执行、并发／重试／预算机制及活动记录端口。调用方决定给哪些工具、授权范围、额度和审计接收者；Tools 严格执行限制，不能自行授权或扩大范围。

Search 服务与工具壳分离：`web_search`、`read_webpage` 的工具适配使用 Search；Search 核心不依赖工具注册器。未来文件／代码工具可以复用 Tools，不要求它们经过 Search。

Base.Agent 复用 Pi 提供有界执行循环：调用模型、执行被允许的工具、继续循环、取消、阶段事件以及最终无工具输出。工具类别额度用尽只撤下对应工具；全局循环上限才触发全局收口。迁移保持当前已验收行为，不趁机重做 Loop。

业务或场景策略由调用方提供：Chat 提供自己的上下文与交互策略；公司调研提供联网轮／非联网轮、输出契约和证据要求。当前 `prepareContext` 是每次运行准备上下文，并非已存在的每次模型请求前公共 Hook；未来 Chat 的精细上下文管理需要时再按实际需求扩展，不在本轮提前承诺接口。

现有检索与收口策略先保留为适配器，只有通用运行机制进入 Base.Agent。中立执行契约从 SDK 下沉，SDK 可单向兼容转出；Base 不依赖 SDK。Capability 的 action／form／task／view／artifact 协议仍归 SDK。

“Base 不调用上层”指没有反向代码依赖和业务知识，不是禁止执行注入函数。调用工具的中立 `execute`、上下文提供器、观察器、存储端口是允许的；在 Base 内按 `company-research` 名称分支或读取 Chat 全局对象则不允许。

### 3.3 Database 与业务仓储

Database 提供 SQLite 连接、通用数据读写／CRUD、事务、迁移执行和生命周期；不提供带有公司、研究主题、报告或 Chat 会话业务规则的 CRUD。

通用读写首先覆盖查询单条／多条、参数绑定、写入及影响行数返回、多次操作共享事务。可以针对实际重复需求提供轻量单表 `insert/update/delete/findById` 助手，但表与字段声明由调用方提供；表名／字段名必须来自受控声明，数据值参数化绑定，更新／删除必须明确条件。不预建万能仓储或完整 ORM，不依赖 TS 泛型充当运行时数据校验。

公司调研包负责自己的表结构演进、仓储接口与实现，真实使用 Base.Database 的读写／事务接口。“只补空字段且不能覆盖人工修改”“没有主题引用才能删除公司”等仍属于公司仓储规则；Base 不根据表名猜测这些规则。Chat 的仓储留 Chat；Usage 的 SQLite 适配归 Usage 并使用 Database。主程序只负责通用服务初始化和生命周期，不继续硬编码公司仓储构造。

首轮维持同一 SQLite 文件、同一事务所用连接和现有同步事务契约，不为每个仓储另开连接，不将 Promise 偷塞进同步事务。证据冻结与报告状态更新等操作必须保持原子性。

历史迁移 1–32 作为不可变的兼容升级序列保留，不并入 Base.Database 的通用核心，也不要求旧能力代码存在才能完成主程序兼容升级。未来新增模块迁移需使用明确的模块标识与有序版本，进入数据迁移批次前单独定义与旧版本表的衔接；本设计不授权提前改写旧迁移。

未启用或已移除的 Capability 不加载业务模块、不恢复其队列、不注册新业务动作，不因此删除用户数据。重新启用后仍可读取原记录。迁移后用“已有数据 → 禁用／缺失包 → Chat 可用 → 恢复包后读回”验证，而不是只用空数据库证明可启动。

### 3.4 Usage 与 Errors

Usage 保持现有账本语义：LLM 在实际 fetch 边界、Search 在实际 dispatch 边界记一次 attempt，保留身份、来源、配置 revision、幂等终态和关联信息。Agent／Tools 不重复记同一请求；重试产生的新实际请求仍分别记录。跨主进程／Worker 的输送和启动恢复不因搬迁改变，账本内部记录与看板纳入规则继续区分。

Errors 抽取中立错误结构、公共分类和脱敏序列化；各模块维护自身错误码、上下文、校验器和恢复策略，Renderer 决定面向用户的文案。现有错误集合含 Capability 专属码和只接受 LLM／Search 的上下文，不能整体冒充通用契约。迁移保留旧 IPC 白名单与公共错误映射，不通过接受任意对象或暴露 cause／密钥换取“通用”。

错误码可由模块独立扩展，不等于可直接穿过所有公共出口；每个出口仍需校验并明确允许的字段。错误分类只说明故障类别，不隐含可重试性或重试动作。内部异常保留 cause，公开结果与内部异常分离；首批不复制服务端 HTTP 异常树、不新增重试策略，也不统一现有 Tool／SDK／Provider 的独立错误协议。

## 4. 目标组织与依赖

沿用 `packages/base`，按能力域提供子入口，不提供把全部运行时一起载入的万能根出口。目标源目录为 `config/`、`model/`、`search/`、`tools/`、`agent/`、`database/`、`usage/`、`errors/`；只在相应批次新增，不提前建空目录。

| 消费方 | 允许的 Base 依赖与注入点 |
| --- | --- |
| Errors | 中立校验依赖；不依赖其他业务模块 |
| Config | Errors；配置存储和密钥存储端口 |
| Database | Errors；数据库驱动，不依赖业务 Schema 或仓储 |
| Usage | 中立元数据、存储／时钟等端口；SQLite 适配可使用 Database，核心不反向导入适配器 |
| Model | Config 的 LLM 契约、Usage 采集接口、Errors、Pi；中立观察器 |
| Search | Config 的 Search 契约、Usage 采集接口、Errors；安全传输与解析依赖 |
| Tools | Errors、中立工具契约；具体 web 工具适配可使用 Search，核心不反向导入具体工具 |
| Agent | Model／Tools 的公开契约与 Pi；注入上下文、工具集合、运行策略和事件接收者 |

模块之间不循环依赖。元数据与类型依赖也要审查，不因 `import type` 就允许 Base 导入 Chat、Capability SDK 或包含业务内容的 contracts 总入口。UI 使用安全的契约／视图子入口，不能通过一次转出把 Node、SQLite 或凭据读取实现带进 Renderer。

旧入口兼容方向只能是“旧入口 → Base 新实现”，不能在 Base 新增转出口后仍依赖旧应用实现。迁移批次应明确兼容出口的消费者和删除条件，避免长期维护两套行为。

现有 `packages/base/src/architecture.test.ts` 已检查传递导入、动态导入和转出。新增 Pi、Node、SQLite 等依赖时按模块精确放行；不删除边界测试、不放开整个旧业务包。

## 5. 分批顺序与最小验收

每行是可独立交付的边界；进入该批前细化接口与改动清单，完成必要自动验证并打包交给用户手测，通过后按项目分支约定继续。下列检查复用现有设施，不要求每批重跑全套，也不要求每批消耗真实 API。

| 批次 | 本批闭环 | 最小验证重点 |
| --- | --- | --- |
| 1. Errors | 中立错误结构及安全序列化下沉，旧公共错误出口保持兼容 | 错误映射／脱敏／未知对象处理、IPC 原有形状、依赖边界 |
| 2. Config | Profile 逻辑与配置定义下沉，Settings 与任务解析切换 | 保存／激活／切换、未保存诊断、密钥保留、快照隔离；沿用配置测试 |
| 3. Model | 模型网关、观察契约、通用采集归位，Chat 和 Capability 真正使用 | 普通／流式调用与取消、每次实际请求只计一次、请求观察不丢失 |
| 4. Search | Provider／读取解析与计量归位，保留工具入口 | 选定 Provider 的请求契约、失败／超时、URL 安全检查、Search 不依赖 Tools |
| 5. Tools | 通用注册与执行归位，应用工具和授权留上层 | 工具准入、额度／重试／取消、审计；网络额度耗尽不撤下其他类别工具 |
| 6. Agent | 分离场景策略后迁移 Pi 执行核心；两种上层入口继续可用 | Chat 历史可用、Capability 无 Chat 历史注入、最终收口／HITL 等待恢复行为兼容 |
| 7. Database | 通用连接／参数化读写／事务／迁移执行归位，现有仓储先使用新底座；单表助手按实际重复需求纳入 | 参数绑定与读写结果兼容、旧库升级幂等、事务回滚、重开读取、保持同库同连接语义 |
| 8. 仓储归属收口 | 公司仓储回到能力包并实际使用 Database；Chat 仓储留 Chat；移除宿主公司专属接线 | 旧报告与证据读回、冻结原子性、启停／移除能力后主 Agent 可用 |

批次 8 涉及多种数据所有者，实施时可再拆成“公司仓储迁移”“其余仓储归位”两个小闭环，不要求一次提交全部完成。模块私有新增迁移规则应在本批前评审，不能先改旧库再补协议。

首个实际开发批次只做 Errors，不同时改 Profile、Loop、数据库或提示词。后续中立契约随对应模块迁移，不在第一批一口气搬空 contracts／SDK。

## 6. 验收不变量与风险控制

- **行为不漂移**：调研两阶段、报告重试、证据交付、队列和人工确认不因目录迁移改变。已知基线失败单独记录，不用削弱测试掩盖。
- **真实接入**：沿 Chat／Capability 入口检查实际调用链，不以新增 `Base.*` 类或目录作为完成依据；重复实现必须退场。
- **配置与费用可定位**：一次运行绑定可追溯快照，密钥不外泄；调用与失败可关联，搬迁不重复计量，也不丢失用量未知事件。
- **失败可恢复**：保留取消、幂等终态、重启恢复和错误上下文；不吞异常或把失败转换成成功。
- **数据兼容**：只对临时／复制数据库做升级验证，不在设计阶段操作用户数据；禁用／移除能力不是卸载数据。
- **可拆卸与可独立演进**：主 Agent 不强制依赖 Base.Agent；Base 不依赖任何能力包。现有空能力构建与加载检查继续有效。

优先复用测试：配置存储／诊断、tool-platform 的准入与预算、`pi-agent-executor` 的历史隔离、persistence 的事务与旧库读取、公司证据集成、Capability runtime／loader 及 production boundary。仅对本批新增风险补必要回归保护；构建通过不替代关键行为验证。

总体设计及首批方案已确认，长期契约见 [Base.Errors 设计](base.errors.设计文档.md)，代码迁移尚未开始。逐步计划和派工记录只留本地；本文件只维护模块边界、迁移顺序和验收不变量。纯文档整理不运行产品构建、不调用付费服务或生成测试包。
