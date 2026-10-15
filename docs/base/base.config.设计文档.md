# Deepfield Base.Config 设计文档

版本：0.3 · 更新日期：2026-10-15

状态：0.2 设计已于 2026-10-13 经用户确认；通用核心、Capability 主进程接入及旧 LLM／Search 兼容适配已实现，截至 2026-10-15 本轮验收完成。验收证据为当前配置下 Chat 可用、资料更新与两阶段调研完成，不表示所有配置功能均逐项手测。下一批 Model 尚未实施。总体边界见 [Base 抽取设计](base.extraction.设计文档.md)；本文不包含逐步实施计划或派工记录。

## 1. 目标与取舍

提供与业务无关的配置定义、校验、保存、凭据管理和执行快照能力。新的 Capability 可以声明多组自己的配置，不必修改 Base、自己读写文件或照搬 LLM／Search 的 Profile 结构。当前 LLM／Search 是第一批真实消费者，现有公司调研必须通过原宿主接口实际使用新实现。

采用“通用配置核心 + 可选 Profile 管理 + 注入存储端口 + 原入口薄适配”。普通配置不需要 Profile；有多套配置和当前选择需求时才使用 Profile 管理。相较 0.1，本批明确包含非 Profile 配置及 Capability 的作用域接入，不再把这两部分留到以后。

- 只搬 Schema／类型或只包装 LLM／Search 两套固定 API 不能完成目标：新的业务配置仍要另写一套实现。
- 重建全局配置中心、YAML 继承、环境变量覆盖或插件注册体系会改变当前 Settings 体验，本批不做。
- Config 负责“用哪个配置、如何校验与保存、如何形成一次执行的快照”；Model／Search 负责真正调用服务，仍按后续批次迁移。
- 配置声明、业务含义和编辑界面由使用方维护。提供 Config 不等于自动生成设置页、自动接入外部服务或让 Chat 获得修改配置的工具。

## 2. 原归属与现实现归属

| 原位置 | 现实现归属 | 本批保留的边界 |
| --- | --- | --- |
| `packages/contracts/src/model-config.ts` | Config 的 LLM／Search Schema、Draft／View／RuntimeSnapshot、Provider 配置定义 | 旧文件单向转出，字段与严格校验形状不变 |
| `packages/contracts/src/chat.ts` 的 `DEFAULT_DEEPSEEK_MODEL_ID` | Config 的 LLM 默认配置 | Chat 原出口兼容转出，不改变默认值 |
| `apps/desktop/src/main/profile-store.ts` | Config 核心的初始化、保存、激活、删除、revision 和快照解析 | 原路径保留构造方式、错误出口及 Settings 聚合适配 |
| 上述文件中的 fs/path/UUID、文件替换 | 桌面存储适配与依赖注入 | 文件位置、JSON v1 格式及 0600 临时文件替换方式不变 |
| `secret-store.ts`、`secret-store-core.ts` 与 `safeStorage` 装配 | 桌面密钥实现，满足 Config 的 SecretStore 端口 | 不改密文格式、加密算法或历史凭据名 |
| `providers/provider-registry.ts` 的纯 manifest／选项声明、智谱引擎枚举 | Config 的纯 Search 配置定义 | Provider 工厂与执行校验继续消费同一份定义，不提前改变校验时机 |
| `configuration-service.ts`、Settings UI、IPC、配置变更通知 | 应用层 | 草稿诊断调用、耗时／错误展示与 Usage 编排不进入 Config |

Config 不导入 contracts、Capability SDK、retrieval、application、Electron、React 或上层单例。Node 文件读写留桌面，不为本批新增专门的平台架构层。

## 3. 公开入口与职责

公开入口：

- `@deepfield/base/config`：通用配置声明契约、纯 Schema、类型、默认值、Provider 描述与选项声明，可供 Renderer 使用；不转出存储实例、密钥读取或运行管理器。
- `@deepfield/base/config/runtime`：通用配置绑定与读写、Profile 管理器及配置存储、SecretStore、ID 工厂端口。仅在可信执行端装配，不创建全局实例、不自行读取目录或环境变量。

内部按通用配置记录、凭据／快照、可选 Profile 集合、LLM／Search 定义、存储契约分工；不要求每个类型单独一个文件。Profile 集合必须组合通用校验、凭据投影、嵌套复制及 revision 机制，不能在新增通用接口后仍保留另一套相同行为。

### 3.1 三个数据视图

| 视图 | 用途 | 凭据规则 |
| --- | --- | --- |
| Draft | 新建、编辑与未保存诊断 | 可带用户刚输入的凭据；省略表示沿用同配置记录的已存凭据，不表示清除 |
| View | Settings 和其他配置查询 | 返回允许展示的普通值和凭据是否存在；不回传凭据、credentialRef 或内部 revision |
| RuntimeSnapshot | 可信执行输入 | 包含执行所需配置、凭据及配置身份／revision，禁止整份返回到 Renderer 或进入日志／Usage |

用户输入的明文 Key 必然短暂存在于表单 Draft；安全要求是不能把已保存的 Key 读回表单，不能把整份 RuntimeSnapshot 当作公开结果或观测数据。普通字段默认可能展示给 UI，开发者必须把 token、密码等声明为凭据，不能藏在普通 options 中。Usage 继续按现有白名单摘取身份，不消费密钥；接入 Config 本身不会自动产生用量统计，计量仍在实际请求边界。

### 3.2 通用配置声明与绑定

配置定义属于使用方。一个 Capability 可以定义多个本地 key，各自含任意数量的普通字段；Base 不设业务配置名枚举，也不按 Capability 名称写分支。

每份定义最少描述：

- `key`：包内稳定名称，例如 `document-service`、`output-preferences`；不是文件路径，也不能指定别的包。
- `schemaVersion`：这组配置的数据版本，与 Capability 版本、宿主接口版本、调用 revision 分开。
- `schema` 与 `defaults`：普通值的 TypeBox Schema 和默认值；沿用现有校验依赖，不新增第二套 Schema 框架。
- `secrets`：可选的命名凭据声明，可以有多项；标明哪些是解析执行快照时必需的，不允许把明文默认凭据写进定义。
- `migrations`：版本升级时按需提供的纯数据迁移函数；接口不注入文件、网络或密钥读取能力，函数须保持纯函数、不隐式改凭据身份。这是开发契约，不是同进程代码沙箱。

新通用配置的 `values` 顶层为 JSON 对象，嵌套仅允许 JSON 值；保存及迁移写回前拒绝循环引用、函数、Date、BigInt、非有限数字、负零、稀疏数组及访问器等不能按原值 JSON 往返的数据，不能“保存成功、重读变形”。缺省字段通过省略表达，不把显式 `undefined` 当作持久值。TypeBox 定义也须遵守这一值域；标准 TypeBox 标记由定义处理，接受的 Schema 元数据仍须可按 JSON 往返和比较，不接受函数等任意元数据。旧 LLM／Search 的外部 Schema 和 options 校验时机仍按第 4 节保持，不借此额外收紧旧协议。

以下使用当前公开导出；两组定义均由 Capability 自己维护。完整 bootstrap 接入示例见 [Capability 开发指南](../capabilities/capability.开发指南.md#包私有配置)：

```ts
import { Type } from "typebox";
import { defineConfig, type ScopedConfigService } from "@deepfield/base/config";

const documentService = defineConfig({
  key: "document-service",
  schemaVersion: 1,
  schema: Type.Object({
    endpoint: Type.String(),
    timeoutMs: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  defaults: { endpoint: "", timeoutMs: 30_000 },
  secrets: { apiToken: { requiredForExecution: true } },
});

const outputPreferences = defineConfig({
  key: "output-preferences",
  schemaVersion: 1,
  schema: Type.Object({ language: Type.String() }, { additionalProperties: false }),
  defaults: { language: "zh-CN" },
});

// bootstrap 内获取宿主已经限定到本包的接口。
const config = services.get<ScopedConfigService>("config.v1");
const handle = config.bind(documentService);
const preferences = config.bind(outputPreferences);
await preferences.save({ values: { language: "zh-CN" } });
await handle.save({ values: { endpoint: "https://example.com", timeoutMs: 30_000 },
  secrets: { apiToken: "user-supplied-token" } });
const view = await handle.getView(); // 普通值 + 凭据是否存在，无已保存密钥
const snapshot = await handle.resolveSnapshot(); // 仅交给可信执行代码
```

`endpoint` 留空表示可保存的未配置状态；真正执行服务前的 URL／可用性检查由服务模块承担，不是有一个字符串和 Key 就保证服务可用。其他业务可自行定义更严格的保存 Schema。

同一个绑定句柄提供 `getView()`、`save(draft)`、`resolveSnapshot()`、`resolveDraft(draft)`：

- `getView` 返回 `{ values, secretStatus }`，不公开凭据引用和内部 revision；`resolve*` 才得到可信执行数据及配置身份。
- `save` 是整份普通值的提交，不是任意路径 patch。字段缺失时只补该定义显式提供的顶层默认值；传入的嵌套对象／数组整体替换，不做兄弟配置继承或隐式深合并。不做类型强转或静默丢弃非法字段；允许未知字段与否由 Schema 明确规定。
- 缺少记录时用声明默认值形成初始 View，不因读取默认值就落盘。定义的默认值必须满足其普通值 Schema；没有合理默认值的业务需在 Schema 中允许明确的未配置状态，而不是让 Base 猜值。保存缺少凭据允许通过，执行快照缺必需凭据时报错。
- `secrets` 中省略的字段沿用已有值；提供非空字符串才替换，不把空值解释成删除。本批不新增通用清除凭据操作。每组凭据与作用域、配置 key 绑定，不允许跨组按名字找 Key。
- `resolveDraft` 使用当前草稿普通值，仅回填省略的凭据；生成独立诊断身份，不保存、不影响已保存 revision。`resolveSnapshot` 只解析该记录，不替上层决定何时执行或重试。
- 同一次激活内同 key 的相同定义可复用；schema／defaults／凭据声明／schemaVersion 冲突必须拒绝，不能“后注册覆盖先注册”。迁移声明随同一份包内定义维护，不支持运行中替换定义。
- 所有输入、View 和快照都隔离嵌套引用；已返回的执行快照不随保存变动。读默认值可使用同一绑定生命周期内稳定的临时身份，首次保存建立持久 revision；实际配置或凭据变化才更新持久 revision。

这不是完整配置 CRUD 平台：普通配置不自带 active、列表、删除、路由或自动 UI。有多套账号／端点切换需求时使用下述 Profile 集合；业务数据条目应使用 Database，而不是当作配置无限增加 key。

### 3.3 可选 Profile 管理及旧 LLM／Search 外观

Profile 集合在通用配置记录之上增加实例 ID、显示名、集合列表与当前选择。配置内容和凭据仍由定义描述；实例之间隔离，不能通过继承其他实例获得未提供的字段。后续新增 Profile 类型可以复用这一层，不要求重新写保存、密钥或 revision 逻辑。

需要私有多配置的包通过 `config.v1` 的 `bindProfiles(definition)` 获得同作用域集合句柄；不自行创建管理器。集合提供 `getView()`、`save({ id?, name, values, secrets? })`、`activate(id | null)`、`delete(id)`、`resolveActive()` 与 `resolveDraft(draft)`。省略 id 表示新建，保存已有 id 只更新该实例；保存不自动激活，不能删除 active 实例。不存在的集合初始为空、active 为 null，不自动生成示例实例。普通 `bind` 和 `bindProfiles` 不能在同 scope/key 上混用；Profile 凭据身份再包含实例 ID。宿主全局 LLM／Search 使用相同集合机制，由存储适配保持旧文件的整体写入形状。

现有 LLM／Search 通过薄适配保持以下操作粒度与原外部字段形状，不要求旧调用方改为通用的 `{ values, secrets }`：

- `initialize()`：严格读取配置并执行已有兼容迁移。
- `getView()`：返回脱敏的 LLM／Search Profile 集合和 active ID。
- `saveLlmProfile(draft)`／`saveSearchProfile(draft)`：保存，不自动激活。
- `activateLlmProfile(id | null)`／`activateSearchProfile(id | null)`：选择或取消选择。
- `deleteLlmProfile(id)`／`deleteSearchProfile(id)`：保留 active Profile 不可删除的规则。
- `resolveActiveLlm()`／`resolveActiveSearch()`：解析当前选择的执行快照。
- `resolveLlmDraft(draft)`／`resolveSearchDraft(draft)`：解析未保存的诊断快照，不写入配置。

管理器及通用句柄对外使用 Promise；存储与密钥端口首版保持同步，由主进程内同一宿主实例串行完成写入，以匹配现有一次操作内不让出执行权的行为。不新增多进程配置写入、后台文件热监听或分布式锁。

配置存储端口只负责按受控记录身份读取未知文档、写入已由核心构造的不含明文凭据的文档；核心负责 Schema 校验及迁移。SecretStore 端口沿用 `has/get/set/delete`，ID 工厂由宿主注入。端口不携带业务服务、HTTP 客户端或完整应用对象。

核心的 View 不依赖应用的 `SettingsView`。桌面兼容适配把它与纯 Search manifests 组成现有 SettingsView，确保现有 IPC 输出完全相同。新调用方可仅依赖它需要的读取或解析接口。

### 3.4 Capability 作用域与生命周期

新增宿主服务 `config.v1`，沿用现有 `CapabilityHostServices` 和 requirements 机制，不新建插件发现体系。使用方声明该需求；宿主不支持时，沿现有机制报告该包不兼容，不能仅靠 `get<T>` 的类型断言宣称版本兼容。

宿主在主进程 bootstrap 边界按可信 manifest ID 包装 services，为 `config.v1` 提供包专属句柄，其他旧服务保持原契约。当前 Worker 不提供 `config.v1`；主进程解析后按已有可信执行协议传递所需快照，不能把服务句柄或密钥交给 Renderer。包只能给本地配置 key，不传全局 namespace、存储路径或别的包身份。Base 接收不透明 scope，不导入 Capability SDK、不读取 manifest；路径映射与合法性检查由宿主适配承担。

全局 LLM／Search 由宿主拥有，不能被包内同名 key 遮蔽。包需要全局模型／搜索时仍走原有显式服务；私有配置不等于自动继承或覆盖宿主配置。该隔离用于防止串用和错误覆盖，不是对同进程可信包的安全沙箱。

- 宿主拥有配置存储与密钥存储生命周期；包不自行创建全局管理器。
- 只在已启用包激活并绑定后，按需读取／迁移其私有记录。未启用、目录缺失或全部移除时，不扫描其配置、不运行其迁移，不影响主 Chat 启动。
- 绑定资源纳入已有 `registrar.defer`／宿主激活清理。激活失败或实际卸载时撤销该包句柄；后续调用明确报已失效，已复制出去的快照不会被远程改写，任务取消仍归上层生命周期。
- 勾选变化仍只影响下次启动，不能点击取消勾选就提前撤销当前运行句柄。禁用、卸载与移除包都不自动删除配置或密钥；同身份包恢复后可继续读取。
- 配置 UI、保存 action、IPC 输出校验仍由 Capability 按既有协议提供；仅返回 View。Config 不把私有配置或凭据自动加入 Chat 上下文、功能目录或工具列表。

### 3.5 私有数据存储与版本

保留旧 LLM／Search 的 `settings.json` v1 及 credentialRef。新 Capability 私有配置使用独立的宿主管理记录存储，不把每个包的字段塞进旧 Settings Schema，不要求先改写全部旧配置。桌面当前存放在 `userData/capability-config/`，scope 与 key 分别映射为哈希目录和文件名，单个记录损坏不能使所有包配置一起不可读；目录不是包的公共协议，包不直接操作文件。凭据仍通过同一 SecretStore 和 `safeStorage` 加密保存。

新记录保存普通值、schemaVersion、revision 和内部凭据引用，不保存定义函数或明文凭据。读取同版本必须校验；低版本只按声明迁移路径转换，全部步骤及最终 Schema 校验成功后才写回新版本；高于当前定义的版本、迁移缺失或失败均保留原文档并报出可定位错误，不自动重置或降级。迁移函数只处理复制后的普通数据，首版不支持自动重命名／迁移凭据字段。

一个绑定失败不使 Config 全局初始化失败。Capability 可以在自己的配置入口呈现错误；若 bootstrap 未处理该错误，沿现有激活失败机制只隔离该包。故障信息允许 scope、key、版本和关联信息，不记录完整配置、密钥或任意原始校验值。配置文件与密钥文件仍不是跨文件事务，见下一节。

## 4. 现有 LLM／Search 必须保持的行为

1. **保存与可执行分开。** 新配置可以不带 Key 保存／激活；执行或诊断解析时才报告缺凭据。Schema 仍拒绝显式空字符串；UI 将清空输入转为省略字段，保留现有“留空则保留”语义。本批不新增清除 Key 操作。
2. **草稿不落盘。** 使用草稿全部当前字段，只根据 id 回填省略的凭据；不以已保存的模型或 URL 覆盖草稿。未知 id 配合显式 Key 可诊断，但保存不存在的 id 仍失败，保持旧行为。
3. **身份稳定。** 不改变 Profile ID、credentialRef、active ID。实际配置或 Key 变化才产生新 configRevisionId，无变化保存保持 revision；每次草稿解析保留独立 draftSessionId／revision。
4. **迁移不扩散。** 保留 JSON v1 校验、缺失 revision 补齐、原 DeepSeek model ID 替换条件及 legacy Key 引入条件，不新加一次全量迁移。legacy Profile 删除后保留旧 Key、下次初始化可能再次引入的既有行为不在本批修改，也不宣称永不重复引入。
5. **错误可辨识。** 配置无效、Profile 不存在、缺凭据、删除 active 冲突、文档损坏等身份不漂移；错误不得公开密钥或整份配置。
6. **配置与密钥不是跨文件事务。** 当前两个存储分别写入，不能承诺断电／部分写失败会整体回滚。本批保留同步写入顺序和失败传播，不新增事务日志或伪装成功；不把这个既有限制包装为新增用户风险提示。

旧文档中同一集合的重复 Profile ID、指向不存在 Profile 的 active ID 属于损坏文档。`initialize()` 在任何兼容迁移写回之前拒绝这些状态并保留原文件，不自动修复或将其视为兼容格式。

### 4.1 本批补齐：嵌套值隔离

原 `profile-store.ts` 的 Search 保存、View、active／draft 解析曾共享 `options` 引用。Config 在输入进入内部状态、输出 View、生成 RuntimeSnapshot 时复制嵌套选项；修改输入、某一份 View 或某一份快照都不得影响内部保存状态、其他快照和 revision 判断。

隔离指独立数据所有权，不承诺跨进程 JavaScript `Object.freeze`，也不改变 Provider 是否支持某个选项的规则。保留现有 Schema 的宽松 options 外形及 Provider 执行时的严格校验；不利用抽取悄悄放宽或提前收紧允许值。实现时复用现有 TypeBox／平台数据复制能力，验证嵌套对象和数组，不新增一套序列化框架。

旧 Search options 的合法类型宽于新通用配置的 JSON 值域。legacy codec 实际组合通用 Profile 集合与记录核心，仅在兼容适配内部以 `structuredClone` 隔离旧值，并通过 `equalValues` 端口使用宿主注入的原 `isDeepStrictEqual` 比较保持无变化 revision；该策略不暴露给 `ScopedConfigService`，新包普通配置仍严格遵守 JSON 约束。

### 4.2 配置读取时机不变

| 调用入口 | 保留的解析时机与使用范围 |
| --- | --- |
| Chat 普通发送、交互恢复、自动分析 | 各自启动一次 Worker 请求时解析；该请求内部的模型／工具循环使用传入快照 |
| 会话标题生成、公司文本识别 | 各自操作启动时解析 LLM；本次操作及其内部重试沿用快照 |
| 新公司调研 | 每个队列项开始执行时解析；同一次 raw → structure 沿用既有快照 |
| 重新调研／仅重试结构化 | 按当前显式重试入口重新解析；结构化单独重试只需 LLM |
| 公司资料补全 | 队首任务 prepare 时解析，后续执行使用捕获值 |
| 配置诊断 | 本次点击时解析传入 Draft，不保存、不激活 |

因此切换 active Profile 不影响正在执行的请求，但可能影响尚未开始的下一个队列项。不能改成整个批次入队时固定配置，也不能让 Worker 每轮重新读 active。

## 5. 错误与旧入口兼容

Config 使用 Base.Errors 定义本模块内部异常和允许上下文，不继承或导入应用的 AppError。已有公共 `CONFIG.*`、`BUSINESS.CONFLICT`、`STORAGE.FAILED`、`INTERNAL.UNKNOWN` 身份和 `service: llm/search` 映射在原边界保持不变，不增添 UI 错误协议。

桌面 `ProfileStore`／`ProfileStoreError` 保留兼容外观，由薄适配转译内部异常；不留下第二份保存、revision 或解析实现。底层存储异常保留 cause 供内部定位，不将任意异常 message 直接公开。

旧 contracts 的 model-config 子入口、settings 转出和默认模型常量继续单向引用 Config；旧 Schema 名称与字段保持兼容。`SettingsViewSchema`、`DiagnosticResultSchema`、ToolAccessPolicy、Worker envelope 等应用协议不整体搬入 Base。

公司包继续通过现有 `model.configuration` 服务获取 `profiles`、`settings` 与 `onConfigurationChanged`，不修改服务名、方法签名或 requirements。设置变更通知仍在原应用边界发出。迁移不能要求现有已编译能力包仅为导入路径改变而升级。

## 6. 扩展成本与本批边界

未来 Capability 新增配置只需三件事：在包内维护定义 → 从 `config.v1` 绑定 → 在自身设置／业务入口读写 View、解析快照。新增字段或配置组不改 Base 核心；改变已有持久数据结构时维护本定义的 schemaVersion／迁移。业务开发者仍需写自己的页面、业务校验与服务调用，不能把这部分成本说成“零代码接入”。

以后增加 Embedding 等 Profile 类型，可以提供独立配置定义，复用通用 Profile 集合；全局 Settings 增加对应页面属于应用接线，不往 Config 添加服务执行逻辑。包私有 Profile 也不得影响全局 active 选择。

本批落实通用配置绑定、命名凭据、默认值／Schema、版本错误与迁移入口、作用域和快照隔离，并让现有 LLM／Search 真实复用。通过最小测试夹具展示一个包声明两组普通配置，其中一组含凭据；不为了展示抽象给公司调研硬加不存在的设置或发布演示能力。

不做自动设置页生成、远程配置中心、动态加载能力包、自动环境变量覆盖、YAML／兄弟继承、跨配置依赖图、模型路由或多版本 Base 并行运行。参考实现的“配置结构与来源分离”可借鉴，服务端只读缓存模型不能替代本产品的写入、草稿诊断与密钥管理。

## 7. 迁移顺序与最小验收

以下是 Config 批次的分段交付边界，不是已授权的逐文件实施计划；不改变其余模块顺序。每段保持旧产品可运行：

1. 定义通用配置记录／句柄及端口，迁移纯 LLM／Search 契约、默认值及 Provider 元数据，保留旧单向转出；用普通配置夹具验证扩展不依赖业务分支。
2. 将现有 Profile 管理组合到通用机制上，接入桌面文件／密钥适配；复用旧持久化与诊断测试，补嵌套隔离回归。此时 Chat 与公司调研的旧入口必须实际调用新核心。
3. 在 Capability bootstrap 接入作用域化 `config.v1` 与清理，旧 `model.configuration` 不变；核验隔离、禁用／移除／恢复及未重新编译旧能力包的配置调用边界，更新开发指南。完成必要检查后构建、打包，交用户手测。

必要验证聚焦两组行为：通用配置的多定义、默认值／校验、JSON 往返、凭据隔离、版本失败不覆盖旧数据、两个包同 key 不串用、私有 Profile 不影响全局选择、未启用包不读取与句柄清理；旧 Profile 的保存／激活／删除、缺 Key 保存但执行阻拦、凭据保留、草稿不落盘、revision 稳定、旧文档迁移、嵌套隔离、错误与密钥不泄漏、运行中切换与下一队列项读取、两阶段快照复用。

已有基础包括 `profile-store.test.ts`、`configuration-service.test.ts`、`SettingsView.test.tsx`、`settings-compat.test.ts`、Chat 与公司调研相关契约测试、Base 架构检查。只补本批风险所需断言，不复跑无关全套或真实付费请求。冻结旧能力包验证限于声明兼容的配置边界，不称完整旧包生命周期已验证。

用户手测重点是旧配置仍可用、保存／切换正常、未保存诊断正常，以及原 Chat／公司调研入口可用。最终统一检查已完成，截至 2026-10-15 本轮验收完成：用户确认修复后当前配置下 Chat 可用、网络测试正常，并自行完成百度文心资料更新和失败报告重新调研。只读复核确认资料为 ready，调研完成且原始报告与结构化报告均有内容，两阶段结果已落盘。

上述证据覆盖当前配置的实际消费链路，不将用户总体成功反馈扩大为保存／激活／切换、未保存诊断、凭据保留及其他配置功能的逐项手测记录，也不代表对报告事实逐条背书。长期契约在本文持续维护；下一批 Model 尚未实施。
