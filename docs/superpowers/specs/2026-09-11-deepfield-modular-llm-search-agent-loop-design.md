# Deepfield 模块化 LLM、Search 与 Agent Loop 设计

日期：2026-09-11
状态：产品与工程设计已通过对话评审，等待书面规格复核

## 1. 决策摘要

Deepfield 不再依赖任何模型服务商的原生联网搜索。联网能力统一由
Deepfield 自己的 Agent Loop、`web_search` 工具和独立 Search Provider
提供。

Settings 第一版只有两个一级模块：

1. LLM；
2. Search。

LLM 和 Search 均允许保存多个 Profile，但同一时间各自只能启用一个。
一个 LLM Profile 对应一套可以直接运行的模型配置；一个 Search Profile
对应一套可以直接运行的搜索配置。第一版不引入 Provider Account、一个
连接下的模型列表、模型路由或搜索自动故障转移。

本设计取代以下仍在使用 DeepSeek 原生联网搜索的工程边界：

- 普通 Chat 的 DeepSeek Responses 联网路径；
- 单公司调研第一阶段的 DeepSeek Responses `web_search` 路径；
- Worker 请求中硬编码 DeepSeek 模型和密钥的接口。

`docs/superpowers/specs/2026-09-11-deepfield-single-company-key-research-v1-design.md`
中已经落地或正在使用的调研状态机、原始报告持久化、第二阶段结构化、
Harness 校验和报告视图继续有效。若其中的 Worker、模型或联网描述与本设计
冲突，以本设计为准。

## 2. 产品目标

本轮交付要达到以下结果：

- 用户可以在 Settings 中配置、诊断、保存和启用任意受支持的 LLM；
- LLM 支持 OpenAI-compatible Chat Completions 和 Anthropic Messages 两种
  协议，不再固定 DeepSeek；
- 用户可以在 Settings 中配置、诊断、保存和启用五个 Search Provider；
- 普通 Chat 打开联网按钮后，当前 LLM 可以通过 Deepfield 的标准工具反复
  搜索和核读网页；关闭联网按钮后，网络工具不可见；
- 单公司调研第一阶段使用联网 Agent Loop，第二阶段明确禁止联网；
- 切换 LLM 或 Search Profile 后，不修改业务代码即可更换服务商；
- API Key 不进入普通配置、日志、审计事件、报告或错误文本。

## 3. 不在第一版范围内

- 模型服务商原生联网搜索；
- “联网模型”或“调研模型”等第二模型角色；
- Provider Account 与共享凭据层；
- 一个 LLM Profile 下配置多个模型；
- 按任务自动选择模型、模型故障转移或模型负载均衡；
- Search Provider 自动轮询、自动降级或额度路由；
- Embedding 配置页面；
- 自动拉取服务商模型列表；
- 允许用户定义任意 HTTP 请求模板；
- Settings 全局 Draft/Apply 工作流；
- 搜索结果自动成为可信事实，或对来源权威性进行机器证明。

这些能力未来可以建立在 Profile、Registry、Gateway 和 Harness 边界之上，
但不为尚未出现的需求增加首版复杂度。

## 4. 总体架构

```text
Renderer Settings
  ├─ LLM Profiles + LLM Diagnostics
  └─ Search Profiles + Search Diagnostics
           │ typed IPC
           ▼
Main Process
  ├─ ProfileStore（非敏感配置、当前启用项）
  ├─ SecretStore（API Key）
  ├─ DiagnosticsService
  └─ Worker Host
           │ request-scoped runtime snapshot
           ▼
Utility Process
  ├─ ModelGateway
  │    ├─ OpenAI-compatible adapter
  │    └─ Anthropic Messages adapter
  ├─ AgentRuntime / Pi Agent Loop
  └─ SearchProviderRegistry
       ├─ MetaSo
       ├─ Baidu
       ├─ Zhipu
       ├─ Tavily
       └─ Serper
```

职责边界：

- `ProfileStore` 只负责配置持久化、Schema 校验和启用项；
- `SecretStore` 只负责密钥保存和读取，Renderer 永远不能读取已保存明文；
- `ModelGateway` 把 LLM Profile 转换为统一的模型调用能力；
- `SearchProviderRegistry` 根据 Search Profile 创建一个实现统一契约的实例；
- `AgentRuntime` 负责消息、工具调用、预算、取消和循环终止；
- Chat UI 与 Research Harness 决定每次调用允许哪些工具；
- LLM 只能决定是否使用已经开放的工具，不能自行获得联网权限。

## 5. LLM Profile

### 5.1 数据模型

一个 LLM Profile 就是一套可直接运行的模型配置：

```ts
type LlmProtocol = "openai_compatible" | "anthropic_messages";

interface LlmProfile {
  id: string;
  name: string;
  provider: string;
  protocol: LlmProtocol;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  credentialRef: string;
}

interface LlmSettings {
  schemaVersion: 1;
  activeProfileId: string | null;
  profiles: LlmProfile[];
}
```

`provider` 是预设 ID，而不是运行时协议。第一版内置 DeepSeek、Qwen、
OpenAI、Anthropic 和 Custom 预设。选择预设时填入推荐协议和 Base URL；
协议、Base URL、模型 ID 和上下文大小仍允许用户修改。Custom 不猜测模型
能力，要求用户明确选择协议并填写连接参数。

`openai_compatible` 在第一版表示兼容 Chat Completions 与标准 function/tool
calling 的协议，不表示 OpenAI Responses，也不承诺任何服务商原生工具。
`anthropic_messages` 表示 Anthropic Messages 协议及其标准 Tool Use。

若用户以后需要同一个 Key 配置两个模型，先创建两个 LLM Profile。凭据重复
录入是首版接受的简化。未来引入模型路由时，可以在不改变业务调用方的前提
下，把 `credentialRef` 抽到共享 Provider Account。

### 5.2 ModelGateway

`ModelGateway` 接收完成 Schema 校验且已解析密钥的运行时快照，输出 Pi Agent
可使用的模型对象。它不读取 Settings UI 状态，不自行选择 Profile，也不根据
问题内容切换协议。

首版优先复用 `@earendil-works/pi-ai` 已有的 OpenAI-compatible 与 Anthropic
协议支持，不重新实现两套流式协议。本轮必须把普通 Chat、标题生成、公司识别、
档案补全和公司调研等生产 LLM 调用统一改为通过当前 LLM Profile 调用，避免 Chat
已解耦但辅助功能仍被 DeepSeek Key 锁死。

## 6. Search Profile 与适配器注册表

### 6.1 数据模型

```ts
type SearchProviderId =
  | "metaso"
  | "baidu"
  | "zhipu"
  | "tavily"
  | "serper";

interface SearchProfile {
  id: string;
  name: string;
  provider: SearchProviderId;
  baseUrl: string;
  credentialRef: string;
  options: Record<string, unknown>;
}

interface SearchSettings {
  schemaVersion: 1;
  activeProfileId: string | null;
  profiles: SearchProfile[];
}
```

`options` 不能作为任意 JSON 直接进入请求。每个适配器通过自己的 TypeBox
Schema 校验并只读取允许字段。

### 6.2 Provider Manifest

每个 Search Adapter 同时提供一个只读 Manifest：

```ts
interface SearchProviderManifest {
  id: SearchProviderId;
  displayName: string;
  defaultBaseUrl: string;
  credentialFields: readonly CredentialField[];
  optionSchema: unknown;
  optionFields: readonly SettingsField[];
  capabilities: {
    timeFilter: "exact_range" | "relative_recency" | "none";
    domainFilter: boolean;
    publishedDate: boolean;
  };
}
```

Settings 使用 Manifest 动态展示字段；运行时使用同一个注册表创建适配器，
避免 UI 和 Worker 各维护一份 Provider 名单。选择 Provider 后自动填入默认 Base
URL，用户可以修改为兼容网关地址；修改后的地址仍必须通过公共 HTTPS 和
Provider 路径策略校验。

第一版产品目录固定为秘塔、百度、智谱、Tavily、Serper。Brave 不出现在
Settings、运行时注册目录或验收清单中；已经存在的底层文件可暂时保留为未暴露
代码，不为本轮目标进行无收益删除。

智谱使用独立 Web Search API，不使用 Web Search in Chat 或 Search Agent。
默认中国区 Base URL 为 `https://open.bigmodel.cn/api/paas/v4`，适配器调用
`/web_search`，使用 Bearer Token，并把 `search_result` 中的标题、链接、摘要、
媒体和发布日期转换为统一结果。首版允许在 Settings 选择智谱搜索引擎，默认
`search_std`，可选值由适配器 Manifest 限制。

### 6.3 统一搜索契约

Agent 面向的公开工具名统一为 `web_search`。现有 `search_web` 实现可以复用，
但不再作为模型看到的规范名称。

```ts
interface WebSearchInput {
  query: string;
  maxResults?: number;
  timeRange?: { from: string; to: string };
}

interface WebSearchResult {
  provider: SearchProviderId;
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    rank: number;
    publishedAt?: string;
    sourceName?: string;
  }>;
}
```

每次 Tool 调用只包含一个查询。Provider 必须明确声明精确日期范围、相对时效筛选
或无时间筛选；不支持精确时间范围时不得假装已经应用，Agent 应把必要日期写入
查询词。搜索标题和摘要只是发现线索；正式调研引用应继续调用 `fetch_url` 核读
目标页面。

## 7. Settings 信息架构与交互

Settings 第一版只显示 LLM 和 Search 两个一级入口。不单独建立 Status、Network、
Capabilities 或 Embedding 页面。状态和诊断放在对应模块内；联网按钮属于 Chat
或具体 Capability，而不是全局 Settings。

两个模块采用相同交互：

- 左侧 Profile 列表；
- 新增、选择、删除 Profile；
- 右侧当前 Profile 表单；
- 保存；
- 设为当前启用；
- Diagnostics 区域。

一个正在启用的 Profile 不能直接删除；用户必须先启用另一个 Profile，或者明确
清空当前启用项。保存和启用是两个动作：保存不会暗中切换运行时，启用也只能选择
已经成功保存的 Profile。

API Key 字段始终以掩码展示。Renderer 只能知道“已有密钥”，不能取回密钥原文。
用户没有修改密钥字段时，保存保留原值；清空或替换必须是明确操作。

第一版不实现全局 Save Draft/Apply。每个页面维护局部脏状态并使用页面内保存，
减少跨模块草稿、回滚和运行时同步复杂度。

## 8. Diagnostics

LLM 与 Search 使用同一个状态组件和相同状态机：

```text
idle（黑灯）
  └─ 点击测试 → running（旋转）
       ├─ 成功 → success（绿灯 + 耗时 + 摘要）
       └─ 失败 → failure（红灯 + 脱敏原因）

任意相关字段变化 → idle
```

诊断直接测试当前未保存表单，不自动保存、不自动启用。若 API Key 字段保持“使用
已保存密钥”状态，Main Process 从 `SecretStore` 解析该密钥；若用户输入新 Key，
只把本次草稿值传给诊断调用，成功与否都不落盘。

LLM 诊断发送无工具、极小输出的固定请求，验证 Base URL、鉴权、协议、模型 ID
和响应解析。Search 诊断执行一次固定、低结果数查询，验证 Base URL、鉴权、
Provider 请求格式和统一结果转换；它会产生一次真实搜索调用。

多个诊断请求使用 request ID 和取消机制。用户修改表单或再次点击测试后，旧响应
不得覆盖新状态。诊断结果只驻留 Renderer 状态，重开页面后回到 `idle`。

失败信息只显示稳定类别和安全说明：缺少配置、鉴权失败、模型或引擎无效、网络
不可用、超时、限流、服务商不可用、返回格式不兼容。不得显示请求头、密钥、完整
供应商响应或内部堆栈。

## 9. Agent Loop 与工具授权

### 9.1 权限来源

联网权限由用户或业务 Harness 明确授予，不由 LLM、ModelGateway 或 AgentRuntime
根据内容判断。

普通 Chat：

- 联网按钮关闭：网络工具不进入本轮 Tool allowlist；
- 联网按钮打开：本轮开放 `web_search` 和 `fetch_url`。

单公司调研：

- 第一阶段“原始调研”：Research Harness 开放 `web_search` 和 `fetch_url`，阶段
  内部允许多次 LLM—Tool 循环；
- 第二阶段“结构化处理”：Research Harness 不开放任何网络工具，只输入第一阶段
  原始报告、模板快照和结构化 Schema。

“第一阶段”是一段工作流阶段，不等于只请求一次 LLM。第一阶段可包含多次模型
调用和工具调用；第二阶段仍是独立的非联网处理阶段。

### 9.2 运行时快照

每次 Chat 发送或完整调研运行开始时，Main Process 解析当前启用的 Profile，读取
必要密钥并生成不可变运行时快照。调研首次启动后的两个阶段使用同一份 LLM 快照，
第一阶段同时使用启动时的 Search 快照。运行过程中切换或修改 Settings 只影响下
一次用户发起的任务，不会让正在运行的 Agent 或阶段间自动切换模型或搜索服务商。
`structure_failed` 后由用户单独发起的结构化重试属于新任务，重新读取当时的 LLM
Profile，但仍不读取 Search Profile，也不开放网络工具。

不联网调用不要求存在 Search Profile。联网调用在开始前必须确认当前 Search
Profile 完整可用；缺少配置时立即返回明确设置错误，不把任务交给 LLM 猜测或假装
联网。

### 9.3 循环和预算

复用现有 Pi Agent Loop 的消息与 Tool Call 循环，并把 SearchProvider、网页抓取和
解析工具接入现有 Tool Platform、权限、预算和审计边界。

首版默认预算：

| 场景 | 最大 Agent 轮次 | 最大搜索调用 | 最大页面核读 |
| --- | ---: | ---: | ---: |
| 普通联网 Chat | 6 | 4 | 3 |
| 单公司原始调研 | 12 | 8 | 8 |

达到上限后不再执行新工具，要求模型根据已有材料完成回答并说明材料不足。工具错误
作为结构化 Tool Result 返回，模型可以在剩余预算内修正查询，但相同失败不得无限
重试。第一版不自动切换 Search Provider。

搜索结果和网页正文都设置单项、单次和累计大小限制。`contextWindow` 用于输入预算
计算；它是用户声明值，诊断通过不代表服务商一定接受达到该上限的请求。

## 10. 普通 Chat 数据流

```text
用户发送消息 + 联网按钮状态
→ Chat Harness 生成 Tool allowlist
→ 解析当前 LLM Profile 快照
→ 若联网，再解析当前 Search Profile 快照
→ Pi Agent 调用模型
→ 模型可选择调用 web_search
→ SearchProvider 返回统一结果
→ 模型可选择调用 fetch_url 核读
→ 循环直至最终回答或预算结束
→ 保存正常 Assistant 消息和安全 Tool 审计
```

模型服务商输出的普通文本永远不被当成伪造 Tool Call 执行。旧 DeepSeek DSML
协议文本不再参与任何解析或联网路径，也不得原样作为“调研成功”结果保存。

## 11. 单公司调研数据流

第一阶段：

```text
Research Harness 授予网络工具
→ 使用当前 LLM 与 Search 快照运行 Agent Loop
→ 搜索、核读、形成带 URL 的 Markdown 原始报告
→ 原始报告持久化
```

第二阶段：

```text
Research Harness 使用空网络 Tool allowlist
→ 使用当前 LLM 快照读取原始报告和模板
→ 输出候选结构化 JSON
→ 确定性 Harness 校验与有限修补
→ 持久化结构化报告
```

第一阶段失败且没有原始产物时继续沿用现有清理语义。原始报告已经持久化后，第二
阶段失败不得删除或重跑第一阶段；用户可以只重试结构化处理，避免重复搜索费用。

报告页面继续优先显示原始报告，原始报告按钮位于左侧、结构化报告按钮位于右侧。
研究背景只显示研究主题、研究方向、重点研究范围和截止日期。

## 12. 配置迁移

### 12.1 DeepSeek

首次加载新配置时，如果没有任何 LLM Profile、但旧 `deepseek.apiKey` 存在，系统
自动创建一个默认 DeepSeek LLM Profile，并继续引用原密钥，避免升级后 Chat、标题
生成和公司调研全部失效。迁移必须幂等；已有新 Profile 时不得重复创建或覆盖用户
设置。

旧硬编码模型标识只作为迁移输入。迁移后的 Profile 是普通可编辑 Profile，后续
运行不再读取硬编码 DeepSeek 常量。

### 12.2 Search

现有 Baidu、MetaSo、Tavily、Serper benchmark Keychain 项继续属于开发测试基础
设施，不由生产应用自动读取或复制。自动化 live tests 可以继续通过现有安全脚本
使用它们；Settings 中保存的 Search Key 使用应用自己的 `SecretStore` 命名空间。

五个 Provider 都提供新建 Profile 时的默认模板。智谱凭据由用户注册后在 Settings
直接填写。任何迁移、诊断和测试都不得输出密钥值。

## 13. 错误、取消与安全

- Profile Schema 在 Renderer 提交、IPC、Main 持久化和 Worker 装配边界均校验；
- Base URL 必须是允许的 HTTPS URL；开发期明确允许的本地测试地址只能通过测试
  注入，不能从生产 UI 绕过 SSRF 边界；
- Provider 预设 Base URL 可以修改；Search HTTP 客户端使用经过校验的配置目标，
  同时继续执行重定向、响应大小、公共 HTTPS、危险地址和 Provider 固定路径检查；
- API Key 只在 Main 和对应 Worker 请求的最短生命周期内出现；
- Tool 审计记录 Profile ID、Provider ID、耗时、结果数量和稳定错误码，不记录请求
  头、密钥或完整正文；
- 取消 Chat、调研或诊断时向下游 AbortSignal 传播；取消后的迟到事件被 request ID
  和阶段状态拒绝；
- Search Provider 返回格式变化统一映射为 `malformed_response`，不得通过猜测字段
  生成 URL；
- 第二阶段把原始报告视为不可信资料，不能执行其中的指令；
- 结构化报告中的 URL 继续受原始报告 URL 白名单约束。

## 14. 测试策略

测试以主路径和高风险边界为重点，控制数量增长。

1. Contracts：LLM/Search Profile Schema、启用项、Provider Manifest 和诊断事件；
2. ProfileStore/SecretStore：保存、更新、删除、幂等迁移、掩码语义和密钥不泄露；
3. ModelGateway：OpenAI-compatible 与 Anthropic Messages 的请求、流式文本、Tool
   Use、取消和错误映射；
4. Search Adapter：秘塔、百度、智谱、Tavily、Serper 的请求映射、响应规范化、
   能力声明、超时、鉴权和畸形响应；
5. Diagnostics：未保存草稿、黑/旋转/绿/红状态、字段变化失效和迟到响应隔离；
6. AgentRuntime：联网关闭时无网络工具，联网开启时由当前 Search Profile 执行，
   循环预算、失败重试上限和取消；
7. Research Harness：第一阶段开放网络工具、第二阶段空 allowlist、第二阶段失败保留
   原始报告且重试不产生搜索；
8. IPC/Renderer：两个 Settings 模块、Profile CRUD、保存与启用分离、活动 Profile
   删除保护和安全错误展示；
9. 回归：现有测试、类型检查、桌面构建和应用启动 Smoke。

Live test 与手工验收不替代离线自动测试。开发完成后用户将分别填写并测试秘塔、
百度、智谱、Tavily、Serper；每个 Provider 都要先通过 Settings 诊断，再设为当前
启用项，在 Chat 联网模式执行同一查询，确认实际 Provider 身份、可点击来源和正常
最终回答。

## 15. 验收标准

- Settings 只包含 LLM 和 Search 两个一级业务配置入口；
- 可以保存多个 LLM Profile，并且只能启用一个；
- 可以保存多个 Search Profile，并且只能启用一个；
- LLM Profile 支持两种明确协议、Provider 默认值和人工修改 Base URL；
- Search Provider 目录包含秘塔、百度、智谱、Tavily、Serper，不包含 Brave；
- LLM 与 Search 均可用未保存草稿运行诊断，并呈现黑、旋转、绿、红四种状态；
- Chat 联网按钮关闭时绝不调用 Search，打开时使用当前 Search Profile；
- 单公司调研第一阶段可以进行多轮搜索和页面核读，第二阶段无法联网；
- 单公司调研继续保留原始报告优先视图和失败后单独重试结构化处理；
- 切换 Profile 只影响下一次调用，不改变正在运行的任务；
- 旧 DeepSeek Key 可以安全迁移，升级后已有用户不必重新配置 LLM；
- 不再存在生产可达的 DeepSeek 原生搜索或 DSML 联网路径；
- 五个 Search Provider 完成适配器契约测试，并可由用户逐个完成真实 Chat 手测；
- 全量自动测试、类型检查和桌面构建通过。
