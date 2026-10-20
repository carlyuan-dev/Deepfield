# Deepfield Base 抽取设计文档

版本：0.9 · 日期：2026-10-20

状态：总体设计、各模块安全契约与 runtime 分入口、Database 通用 CRUD 和模块迁移账本、公司仓储归属及宿主注入边界已确认。Errors、Config 已实现并完成已声明范围的用户验收；Model 安全契约、runtime、Usage collector 及实际消费者接线已实现，自动验证与真实链路端测完成。Search 抽取已实现、自动检查通过，已完成代码复核，最终用户体验尚未验收。Tools 通用核心与 web 适配已实现，Worker 及通用工具消费者已接入，长期契约见 [Base.Tools 设计](base.tools.设计文档.md)。Agent 通用核已实现并接入 Chat／Capability；Database 通用底座及 Usage SQLite 归位已实现；公司仓储搬入能力包、database.v1 注入与撤销接线留下一批。后续各批由 Agent 自验并独立提交，最终集中进行用户体验验收；本文件维护长期边界与当前真实状态。

当前 Errors 实现在 `packages/base/src/errors/`，旧接口在 `packages/contracts/src/errors.ts` 保留薄兼容适配；其他模块的当前归属见下表。

## 1. 目标与取舍

让新的 Capability 能使用现成的配置、模型、搜索、工具执行、轻量 Agent、数据库、用量与错误能力搭建业务，避免能力增多后重复拆解。公司调研作为第一个真实消费者完成迁移，不能停留在接口设计或目录搬家。

主 Chat／主 Agent 的完善优先：允许按需使用 Base.Model、Base.Tools、Base.Usage 等，不强制使用 Base.Agent。当前 Chat 与 Capability 已经共用 Pi 执行器，保留有价值的复用，不另起一套循环；会话、上下文清理、记忆、Skill、RAG 使用策略和人机确认仍由 Chat 管理。

沿现有边界逐批替换实现：每批切换真实调用点，旧入口必要时单向转出兼容，验证后移除重复实现。迁移保持现有 Pi、SQLite、产品交互和业务规则。

## 2. 当前归属 → 目标归属

以下路径是当前代码证据，不是承诺逐文件原样搬迁。

| 当前归属 | 目标归属 | 留在原职责方的内容 |
| --- | --- | --- |
| `packages/base/src/config/` 实际核心；`apps/desktop/src/main/profile-store.ts` 与 `packages/contracts/src/model-config.ts` 为旧入口薄适配 | Config 已抽取：通用配置、可选 Profile、选择、草稿／视图／快照及中立定义 | Electron 密钥加密、Settings UI、IPC 和诊断编排留桌面应用 |
| `packages/base/src/model/` 实际核心；`apps/desktop/src/shared/model-gateway.ts`、`model-request-observation.ts` 为单向薄装配／转出 | Model 已抽取：调用、请求观察、HTTP 诊断及 LLM transport；SDK 精确特化中立契约 | 公司证据如何接收、冻结、使用请求记录留 Capability |
| `packages/base/src/search/` 实际核心；`packages/retrieval` 服务入口单向转出；`shared/usage-search.ts` 为应用计量装配 | Search 已抽取：Provider、读取解析、资源生命周期与计量接入 | 联网许可、检索任务策略留上层；web 工具定义由 Base.Tools/web 适配 |
| `packages/base/src/tools/` 实际核心；tool-platform 与 retrieval web 工具入口单向转出 | Tools 已抽取：定义、注册、执行、准入、TraceBudgetPool 与审计端口 | Chat 会话工具实现、HITL 授权、业务工具及应用装配留上层 |
| `packages/base/src/agent/` 通用核；SDK execution 单向转出中立契约 | Agent 已抽取：Pi 循环与运行控制 | Chat 上下文和调研专属收口策略留应用适配器 |
| `packages/persistence/src/database.ts`、`transactions.ts`、迁移执行机制及仓储重复的参数化执行 | Database 通用底座已实现；旧连接／事务入口为兼容桥，现有仓储实际使用 Base view | Chat／公司／报告表与仓储归各自模块；旧迁移保留兼容 |
| `packages/base/src/usage` 含实例化 collector；`shared/usage-collection.ts` 为 ALS／recorder 桥接；`persistence/usage-repository.ts` | Usage 通用采集与 SQLite 适配已归位；后者使用 Base.Database | Settings 展示、主进程／Worker 传输与初始化留应用 |
| `packages/base/src/errors/`；`packages/contracts/src/errors.ts` 兼容适配 | Errors 核心及旧公共出口接线已实现；已通过用户手测 | 业务错误码、恢复动作、用户文案与边界白名单归各模块 |

当前必须承认的边界缺口：

1. 主进程仍组装 `company-research.repositories`，能力包依赖 persistence 的聚合仓储类型；公司数据层尚未完全回到包内。
2. 现有 `schema_migrations` 1–32 混合多模块表结构，不能因归属变化重排、重跑或删除历史迁移。

## 3. 模块边界

### 3.1 Config、Model、Search 分开

Config 统一管理“使用哪个配置、字段是否合法、如何保存、怎样生成一次调用的快照”。首批保留 LLM／Search 两类配置；相关 Schema、Profile 契约与默认值放在 Config 的独立子域，不与服务执行代码绑定。

新增配置提供自己的声明式定义，沿用公共存取、校验与可选 Profile 机制。`defineConfig`、`bind`／`bindProfiles`、主进程 `config.v1` 及旧 LLM／Search 兼容适配已实现；公开接口、存储格式与快照规则见 [Config 设计](base.config.设计文档.md)。

- Model 消费 LLM 快照，处理 OpenAI／Anthropic 协议、普通及流式请求、错误和请求观察。
- Search 消费 Search 快照，处理 Provider 请求、结果统一、网页读取和解析；不是完整 RAG，也不负责多轮搜索决策。
- Config 不调用 Model／Search；“测试连接”继续由应用编排 Config 的草稿解析与对应服务调用。
- 默认 URL、Provider 元数据等以中立配置定义提供，Config 不反向导入 Model／Search 运行时。

配置区分可编辑 Draft、脱敏 View 与可信执行端 RuntimeSnapshot。执行中不得重新读取 active Profile 偷换配置，已返回快照不受后续编辑影响；各入口解析时机见 [Config 读取时机](base.config.设计文档.md#42-配置读取时机不变)。

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

历史 `schema_migrations` 1–32 作为不可变的兼容升级序列保留，不并入 Base.Database 的通用核心；宿主即使没有安装公司包，也能完成该序列的兼容升级。旧序列完成后视为各模块的基线 0，后续模块迁移从版本 1 开始，使用独立账本记录 `namespace`、`version`、`migration_key`、`applied_at`。Database 提供通用执行机制，模块声明自己的迁移；待执行迁移及其账本记录在同一同步事务内提交，失败共同回滚。禁用包不执行新模块迁移，也不删除已有数据。

公司包在包内构造仓储，宿主注入 `database.v1` 及窄接口 `tools.audit.v1`，供跨仓储清理共享同库、同连接事务。清理业务落盘后再撤销包的数据库句柄，最后关闭连接；关闭前不能让必要的清理操作失去数据库访问权。迁移机制的验证复用真实 Schema 与兼容数据，无需增加业务字段或 DDL 作为演示。

未启用或已移除的 Capability 不加载业务模块、不恢复其队列、不注册新业务动作，不因此删除用户数据。重新启用后仍可读取原记录。迁移后用“已有数据 → 禁用／缺失包 → Chat 可用 → 恢复包后读回”验证，而不是只用空数据库证明可启动。

### 3.4 Usage 与 Errors

Usage 保持现有账本语义：LLM 在实际 fetch 边界、Search 在实际 dispatch 边界记一次 attempt，保留身份、来源、配置 revision、幂等终态和关联信息。Agent／Tools 不重复记同一请求；重试产生的新实际请求仍分别记录。跨主进程／Worker 的输送和启动恢复不因搬迁改变，账本内部记录与看板纳入规则继续区分。

Errors 抽取中立错误结构、公共分类和脱敏序列化；各模块维护自身错误码、上下文、校验器和恢复策略，Renderer 决定面向用户的文案。现有错误集合含 Capability 专属码和只接受 LLM／Search 的上下文，不能整体冒充通用契约。迁移保留旧 IPC 白名单与公共错误映射，不通过接受任意对象或暴露 cause／密钥换取“通用”。

错误码可由模块独立扩展；每个公共出口仍需校验并明确允许字段。错误分类只说明故障类别，不隐含重试动作。内部异常与公开结果分离，具体接口和旧出口兼容要求见 [Errors 设计](base.errors.设计文档.md)。

## 4. 目标组织与依赖

沿用 `packages/base`，按能力域提供子入口，不提供把全部运行时一起载入的万能根出口。目标源目录为 `config/`、`model/`、`search/`、`tools/`、`agent/`、`database/`、`usage/`、`errors/`；只在相应批次新增，不提前建空目录。

| 消费方 | 允许的 Base 依赖与注入点 |
| --- | --- |
| Errors | 中立校验依赖；不依赖其他业务模块 |
| Config | Errors；配置存储和密钥存储端口 |
| Database | Errors；数据库驱动，不依赖业务 Schema 或仓储 |
| Usage | 中立元数据、存储／时钟等端口；SQLite 适配可使用 Database，核心不反向导入适配器 |
| Model | Config 的 LLM 契约、Usage 采集接口、Pi；中立观察器及自身模型错误契约 |
| Search | Config 的 Search 契约、Usage 采集接口、Errors；安全传输与解析依赖 |
| Tools | Errors、中立工具契约；具体 web 工具适配可使用 Search，核心不反向导入具体工具 |
| Agent | Model／Tools 的公开契约与 Pi；注入上下文、工具集合、运行策略和事件接收者 |

模块之间不循环依赖。元数据与类型依赖也要审查，不因 `import type` 就允许 Base 导入 Chat、Capability SDK 或包含业务内容的 contracts 总入口。Search、Tools、Agent、Database 均区分安全契约入口与可信端 `/runtime` 入口；UI 使用安全的契约／视图子入口，不能通过一次转出把 Node、SQLite 或凭据读取实现带进 Renderer。

旧入口兼容方向只能是“旧入口 → Base 新实现”，不能在 Base 新增转出口后仍依赖旧应用实现。迁移批次应明确兼容出口的消费者和删除条件，避免长期维护两套行为。

现有 `packages/base/src/architecture.test.ts` 已检查传递导入、动态导入和转出。新增 Pi、Node、SQLite 等依赖时按模块精确放行；不删除边界测试、不放开整个旧业务包。

### 4.1 公开契约与 Capability 兼容

Capability 只依赖稳定公开契约，不依赖 Base 内部目录、实现类型或宿主内部对象；Base 不反向依赖业务。模型、搜索、数据库等运行服务由现有 SDK／宿主注入与接线。Capability 显式声明所需依赖，宿主只提供契约所需能力，不传入完整全局对象；兼容适配沿现有边界处理。

公开契约包含参数、返回值以及取消、错误、事件、事务、重试等可观察行为。Base 内部替换实现或搬迁目录须保持这些约定，不因内部变化要求 Capability 升级。新增可选字段也不能默认视为兼容：旧校验器可能拒绝未知字段，须结合实际消费者检查。现有服务获取的 `get<T>` 只是类型断言，`requirements` 只检查服务名，均不能证明运行时契约或版本兼容；这些约束是实施和验收要求，不表示当前兼容能力已充分实现。

Base 内部版本、宿主接口版本和 Capability 包版本分别表达不同变化，不绑定同步递增。公开契约的破坏性更新通过显式接口版本处理，不能悄悄改变同名服务的含义；自有包可随宿主同步升级，确需保留旧包时使用有明确消费者与退出条件的薄适配。适配只承担必要的契约转换，不长期维护两套基础实现。

Capability 自有数据结构由其仓储与迁移管理；Base.Database 的通用读写机制不自行修改业务表或替业务模块决定 Schema 演进。宿主接口兼容与数据兼容分别验收，历史数据约束继续遵循本文件的 Database 边界。

公司仓储归位时，宿主与自有公司包同步升级，移除旧 `company-research.repositories` 依赖后，不承诺未升级旧包继续兼容。现有安装不会自动覆盖旧包；交付沿用现有完整包更新流程并保留备份。该版本边界不改变历史数据库的兼容升级要求。

每批迁移验证实际 Chat／Capability 消费者及本批关键行为。如果承诺旧包无需升级，须用未重新构建的旧包夹具运行新宿主，验证相关调用与行为；仅把新宿主和能力包新源码一起编译不能证明旧包兼容。验收覆盖本批声明的兼容范围，不扩展为完整插件版本管理平台。

## 5. 分批顺序与最小验收

每行是可独立交付的边界；每个模块实施前明确职责、公开契约、可替换依赖、关键行为／数据不变量、兼容边界和最小验收。未知未来需求先留在能力包内，出现真实复用后再抽取。各批完成必要的 Agent 自验后独立提交，并连续推进已授权范围，最终打包进行集中用户体验验收。下列检查复用现有设施，不要求每批重跑全套，也不要求每批消耗真实 API。

| 批次 | 本批闭环 | 最小验证重点 |
| --- | --- | --- |
| 1. Errors | 中立错误结构及安全序列化下沉，旧公共错误出口保持兼容 | 错误映射／脱敏／未知对象处理、IPC 原有形状、依赖边界 |
| 2. Config | 通用配置及可选 Profile 管理下沉，旧入口兼容切换，Capability 作用域接入 | 多组配置／版本／作用域隔离、保存／激活／切换、未保存诊断、密钥保留、快照隔离；沿用配置测试 |
| 3. Model | 模型网关、观察契约、通用采集归位，Chat 和 Capability 真正使用 | 普通／流式调用与取消、每次实际请求只计一次、请求观察不丢失 |
| 4. Search | Provider／读取解析与计量归位，保留工具入口 | 选定 Provider 的请求契约、失败／超时、URL 安全检查、Search 不依赖 Tools |
| 5. Tools | 通用注册与执行归位，应用工具和授权留上层 | 工具准入、额度／重试／取消、审计；网络额度耗尽不撤下其他类别工具 |
| 6. Agent | 分离场景策略后迁移 Pi 执行核心；两种上层入口继续可用 | Chat 历史可用、Capability 无 Chat 历史注入、最终收口／HITL 等待恢复行为兼容 |
| 7. Database | 通用连接／参数化读写／事务／迁移执行归位，现有仓储先使用新底座；单表助手按实际重复需求纳入 | 参数绑定与读写结果兼容、旧库升级幂等、事务回滚、重开读取、保持同库同连接语义 |
| 8. 仓储归属收口 | 公司仓储回到能力包并实际使用 Database；Chat 仓储留 Chat；移除宿主公司专属接线 | 旧报告与证据读回、冻结原子性、启停／移除能力后主 Agent 可用 |

仓储归位按数据所有者保持独立闭环；模块新增迁移遵循上述账本与事务契约。

后续中立契约随对应模块迁移，按各批兼容边界替换 contracts／SDK 中的相关引用。

## 6. 验收不变量与风险控制

- **行为不漂移**：调研两阶段、报告重试、证据交付、队列和人工确认不因目录迁移改变。已知基线失败单独记录，不用削弱测试掩盖。
- **真实接入**：沿 Chat／Capability 入口检查实际调用链，不以新增 `Base.*` 类或目录作为完成依据；重复实现必须退场。
- **配置与费用可定位**：一次运行绑定可追溯快照，密钥不外泄；调用与失败可关联，搬迁不重复计量，也不丢失用量未知事件。
- **失败可恢复**：保留取消、幂等终态、重启恢复和错误上下文；不吞异常或把失败转换成成功。
- **数据兼容**：只对临时／复制数据库做升级验证，不在设计阶段操作用户数据；禁用／移除能力不是卸载数据。
- **可拆卸与可独立演进**：主 Agent 不强制依赖 Base.Agent；Base 不依赖任何能力包。现有空能力构建与加载检查继续有效。

优先复用测试：配置存储／诊断、tool-platform 的准入与预算、`pi-agent-executor` 的历史隔离、persistence 的事务与旧库读取、公司证据集成、Capability runtime／loader 及 production boundary。仅对本批新增风险补必要回归保护；构建通过不替代关键行为验证。

已实现模块的长期契约见 [Base.Errors 设计](base.errors.设计文档.md)、[Base.Config 设计](base.config.设计文档.md)、[Base.Model 设计](base.model.设计文档.md)、[Base.Search 设计](base.search.设计文档.md)、[Base.Tools 设计](base.tools.设计文档.md)、[Base.Agent 设计](base.agent.设计文档.md)、[Base.Database 设计](base.database.设计文档.md)和 [Base.Usage 设计](base.usage.设计文档.md)。Model 已完成本地协议回归、限定冻结旧包服务兼容、生产边界与打包验证；当前 DeepSeek `deepseek-flash`／Tavily 下的配置诊断、Chat、资料更新和完整两阶段调研真实链路端测通过，证据与 Usage 对齐。其他真实 Provider／模型、集中用户体验验收及冻结旧包 GUI／完整生命周期仍待验证；取消行为沿用本地回归证据。

Search 抽取已实现，typecheck、build、Search／Settings／Usage 回归及安全边界检查通过，已完成代码复核；本批未启动 Electron 或调用真实 Provider，最终用户体验尚未验收。Agent 通用核已实现并接入 Chat／Capability；Database 通用底座及 Usage SQLite 归位已实现；公司仓储搬入能力包、database.v1 注入与撤销接线留下一批。
