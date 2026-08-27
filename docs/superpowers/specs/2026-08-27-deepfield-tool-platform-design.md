# Deepfield 可复用 Tool Platform 设计

日期：2026-08-27

状态：草案已通过对话评审，等待书面规格复核

## 1. 目标

Plan 2 为 Deepfield 建立一套供主 Agent、未来 Capability Runtime、子 Agent
和确定性后端代码共同使用的原子 Tool 执行平台。平台统一负责版本、Schema、
ToolSet、权限、预算、重试、取消、并发、错误、事件和审计；首个垂直能力是安全的
公开网页检索与 HTML/PDF 解析。

Plan 2 的退出标准是：应用能在开发模式中运行一次有明确上限的检索探针，展示
Tool 执行轨迹，完成真实搜索 Provider 基准并选定首版 `search_web` 适配器，同时
不在数据库或日志中保存完整网页和 PDF。

## 2. 与 Pi AgentTool 的关系

Deepfield 不重新实现 LLM Tool Calling，也不修改或 fork Pi。Agent 面向模型的一层
继续使用 Pi 原生 `AgentTool`：

- Pi 向模型声明 Tool 名称、描述和参数 Schema；
- Pi 校验模型生成的参数；
- Pi 提供 `AbortSignal`、`onUpdate`、顺序/并行模式和 Tool 事件；
- Pi 把 Tool 结果写回当前 Agent 工作上下文。

Deepfield 实现 Pi 之下的产品执行底座：

```text
Pi Agent → Pi AgentTool Adapter ─┐
                                ├→ Tool Runner → Tool Executor
Capability / 后端直接调用 ──────┘
```

Registry 中的 `ToolDefinition` 是唯一事实源。Pi Adapter 从 Definition 生成
`AgentTool`，不维护第二套工具定义。非 Pi 调用方仍必须经过同一个 Runner；因此
Runner 会在信任边界上再次校验输入，不能假设请求一定来自 Pi。

这条边界保证：页面直接使用 Capability 时可以零 LLM 成本调用 Tool，而主 Agent
使用的仍然是 Pi 原生 Tool 机制。

## 3. 与前后计划的边界

### 3.1 复用 P1

Plan 2 复用 P1 已验收的：

- Electron Main、sandboxed Renderer 和 typed preload；
- Utility Process、request correlation、取消和退出清理；
- Pi Core 与 DeepSeek Provider；
- SQLite 事务、迁移和 Repository 组合；
- macOS `safeStorage` 密钥存储；
- Chat 事件路由、开发构建和 Apple Silicon 打包链路。

普通 Chat 在 Plan 2 仍默认 `tools: []`。Plan 2 会完成并测试 Pi Tool Adapter，
但不会在缺少正式确认体验时让普通 Chat 自动产生网络请求或费用。

### 3.2 为 Plan 3 提供

Plan 3 的 Capability Runtime 和 Agent Supervisor 将直接消费：

- versioned Tool Registry；
- immutable ToolSet；
- Tool Run Context；
- Policy Decision；
- Budget Scope；
- Tool Runner 和 Tool Audit；
- Pi AgentTool Adapter；
- worker Tool request/event 协议。

Plan 3 负责持久化 Job、检查点和用户确认请求；Plan 2 只返回
`confirmation_required`，不实现确认队列或确认 UI。

### 3.3 为 Capability A 和 B 提供

Capability A 的 Discovery/Company Research Agent 复用 `search_web`、
`fetch_url`、`fetch_pdf`、`parse_html`、`parse_pdf` 和
`check_link_accessibility`。Claim、EvidenceFragment、Citation 和报告生成不属于
Plan 2。

未来 Capability B 复用相同网络与解析底座。社交媒体和付费数据源将以新 Tool 或
新 Provider 适配器注册，不修改 Runner。

## 4. 运行位置

首版 Tool Runner 与 Pi Agent 运行在现有 Electron Utility Process 中。纯核心逻辑
位于 workspace package，不能依赖 Electron；Utility Process 只负责装配、协议和
生命周期。

不选择 Electron Main 的原因是网络、解析和第三方库故障不应阻塞桌面主进程。
不立即建立第二个 Tool Utility Process，是因为它会引入 utility-to-main-to-utility
中转、双重取消和额外恢复状态。Runner 接口不得依赖当前进程形态，以便未来按负载
或稳定性需要独立拆分。

## 5. 模块边界

### 5.1 `packages/contracts`

增加跨进程的可序列化契约：

- `ToolExecutionId`、`ToolTraceId`；
- `ToolIdentity`：`name` 与正整数 `version`；
- `ToolCallRequest`；
- `ToolExecutionEvent`；
- `ToolExecutionResult`；
- `ToolFailure`；
- `ToolManifestEntry`。

契约不得包含执行函数、API Key、数据库句柄、网页正文或二进制。

### 5.2 `packages/tool-platform`

新增纯 TypeScript package，建议按责任拆分：

- `definition.ts`：Definition、Executor 和 Schema 类型；
- `registry.ts`：注册、冻结、精确查找和 manifest；
- `tool-set.ts`：调用者可见的精确 Tool 集；
- `policy.ts`：授权和确认判断；
- `budget.ts`：调用、字节、时间、并发预算；
- `runner.ts`：唯一执行入口；
- `retry.ts`：可注入时钟的有限退避；
- `errors.ts`：稳定错误码和脱敏；
- `events.ts`：事件生产与单终止约束；
- `audit.ts`：审计 port；
- `testing.ts`：Fake Executor、Clock、Audit 和事件收集器。

### 5.3 `packages/retrieval`

新增公开网络检索实现：

- URL 和地址策略；
- HTTP/HTTPS transport；
- 内存 ResourceStore；
- HTML/PDF fetch 与 parse Tools；
- 链接可访问性 Tool；
- SearchProvider 统一接口；
- 候选 Provider 适配器；
- `search_web` Tool；
- 人形机器人 benchmark harness。

HTML/PDF 解析库必须在实施时做 Node 24、Electron 43、ESM 和打包兼容验证，随后
以精确版本写入 lockfile。不得引入浏览器自动化或执行网页脚本。

### 5.4 Persistence

新增 `tool_executions` 持久化边界。每条记录包括：

- execution/trace ID；
- Tool 名称和版本；
- 调用者类型和可选项目 ID；
- 状态、稳定错误码和停止原因；
- 尝试次数、重试次数、开始/结束时间、耗时；
- 网络字节数、结果数量和可选 Provider 成本单位；
- 允许审计的 URL 或查询词摘要。

不得保存网页全文、PDF 二进制、完整解析文本、API Key、Cookie、认证头或底层原始
异常。实时 progress 不逐条持久化；只保存最终记录和少量有审计意义的生命周期
节点。

### 5.5 Application、Main、Preload、Renderer

Application 增加固定的 `RetrievalProbeService`。Renderer 只能提交查询词，不能
指定任意 Tool 名称、版本、URL、预算或权限。Main 暴露窄 IPC 并继续做参数校验。

开发 Trace 页面仅在 `DEEPFIELD_DEVELOPER_MODE=1` 可见。它展示 Tool、状态、尝试、
耗时、URL 选择/跳过原因和稳定错误码，不展示 API Key、完整网页或原始异常。

## 6. Tool Definition 与 Registry

每个 `ToolDefinition` 必须包含：

- 稳定名称和正整数版本；
- 面向 Agent 的 label 与 description；
- TypeBox input/output Schema；
- effect/permission 分类；
- 默认 timeout；
- retry policy；
- per-tool concurrency；
- 预算计量类别；
- Executor。

Registry 在装配阶段注册并冻结。冻结后不能由 Agent、Renderer 或运行中的
Capability 添加、覆盖或删除 Tool。相同名称和版本重复注册是启动错误；调用不存在
或未授权的版本是安全的运行时失败。

Pi Tool 名称使用稳定 Tool 名称；ToolSet 另外固定 Registry 版本。版本升级必须并存
或显式迁移，不能让运行中的定义静默改变。

## 7. ToolSet、权限和确认判断

权限默认拒绝。`ToolRunContext` 至少包含：

- actor：`main_agent`、`capability`、`child_agent`、`direct_ui` 或
  `developer_probe`；
- trace ID；
- 可选 project ID；
- immutable ToolSet；
- Budget Scope；
- 已满足的确认凭证；
- AbortSignal。

ToolSet 只允许确切的名称与版本，并可进一步限制域名、结果数、响应大小等参数。
Plan 2 实际实现的 effect 只有 `network.read.public`。以下 effect 只保留策略枚举，
没有执行器：

- `project.read`；
- `imported_file.read`；
- `external.open`；
- `document.write`。

Policy 返回 `allow`、`deny` 或 `confirmation_required`。Plan 2 的开发探针由用户显式
点击启动，因此携带固定、窄范围的确认凭证；Plan 3 再实现可持久化确认请求。

## 8. 预算和并发

Budget Scope 支持：

- 总 Tool 调用数；
- 按 Tool 名称计数；
- 搜索次数；
- 抓取次数；
- 总下载字节；
- 总运行时间；
- 全局与 per-tool 并发。

预算必须在执行前原子预留，完成后核销实际用量。两个并发调用不能共同突破最后一份
预算。失败和重试如何计费由 Definition 明确：网络尝试计入尝试和字节，但研究轮次
由未来 Capability 另行管理。

所有限制都是硬上限；Agent 无权扩大自己的预算。

Plan 2 默认运行上限为：单次 trace 最多 12 次 Tool 调用，最多 1 次搜索、3 次链接
检查和 3 次抓取；全局最多 4 个 Tool 并发，同一网络 Tool 最多 2 个并发。Definition
和 ToolSet 可以把限制收紧，不能放宽。Capability A 在 Plan 3/4 中创建自己的更高层
研究预算，不沿用开发探针的数值。

## 9. Tool Runner 执行语义

固定链路：

```text
resolve exact Tool
→ validate input
→ evaluate ToolSet/policy
→ reserve budget and concurrency
→ emit started
→ execute with timeout/cancellation
→ retry only classified transient failures
→ validate output
→ finalize audit and budget
→ emit exactly one terminal event
```

Runner 对 Pi 和非 Pi 调用一致。Executor 成功返回后才允许 `completed`；审计或关键
持久化失败时不得向上层宣称成功。取消、超时、worker 退出和迟到回调必须保持单终止
语义。

重试最多两次，即一次初始尝试加两次重试。只允许明确的临时网络故障、408、429 和
受控 5xx 重试；认证、权限、预算、输入、URL 安全、内容类型、解析和输出 Schema
错误不重试。退避使用可取消的注入时钟，单元测试不真实等待。

## 10. 错误协议

稳定错误码至少包括：

- `invalid_input`
- `tool_not_found`
- `tool_not_allowed`
- `permission_denied`
- `confirmation_required`
- `budget_exceeded`
- `timeout`
- `cancelled`
- `rate_limited`
- `authentication_failed`
- `network_unavailable`
- `url_blocked`
- `redirect_blocked`
- `response_too_large`
- `unsupported_content_type`
- `parse_failed`
- `invalid_output`
- `executor_failed`

失败结构包含 code、safe message、retryable、attempt count 和可选安全 metadata。
底层异常只在本地受控诊断中使用，不进入 Renderer、Agent transcript 或持久化 JSON；
不得通过 `cause`、可枚举属性或序列化对象泄漏秘密。

## 11. 事件流

事件类型：

```text
accepted
validated
policy_checked
started
progress
retry_scheduled
completed | failed | cancelled
```

每个事件含 execution ID、trace ID、Tool identity、序号和时间。`progress` 只允许
受控数字、阶段名和安全摘要，不能携带网页正文。所有调用恰好产生一个终止事件；
取消或终止后丢弃迟到事件。

Pi Adapter 将 Runner progress 映射到 Pi `onUpdate`，将最终结果映射到
`AgentToolResult`。Pi 自身 Tool 事件保留；Deepfield Tool 事件用于项目审计、直接
调用和开发 Trace，两者通过 execution ID 关联而不重复执行。

## 12. 网络安全

网络 Tool 只允许公开 `http:` 和 `https:`，首版只允许标准 80/443 端口。禁止：

- `file:`、`data:` 和其他协议；
- URL userinfo；
- localhost、loopback、unspecified、private、link-local、multicast；
- IPv4/IPv6 私网和云元数据地址；
- DNS 解析到任何被禁止地址；
- 公开地址重定向到禁止地址。

URL 在初始请求和每次重定向都校验。地址校验必须进入实际连接的 DNS lookup 路径，
不能只做一次预解析后让 HTTP 客户端重新解析，以防 DNS 重绑定。

首版不发送 Cookie，不继承 Chromium session，不运行脚本，不绕过验证码、登录墙或
付费墙。重定向、连接时间、总时间、响应大小和内容类型都有硬上限。默认上限由
Definition 固定，调用方只能进一步缩小。

首版网络默认值：连接 10 秒、整次请求 30 秒、最多 5 次重定向；HTML 最多 8 MiB，
PDF 最多 32 MiB，链接检查的 fallback GET 最多读取 1 MiB。超限立即中止响应流，
不能先完整下载后再丢弃。

## 13. 临时 ResourceStore

`fetch_url` 和 `fetch_pdf` 不把完整正文返回给 Agent，而是把受限响应放入 Utility
Process 内存 ResourceStore，并返回随机 `resourceId`、final URL、content type、
size 和 hash。

Resource 与 owner trace、project 和 ToolSet 绑定。`parse_html`/`parse_pdf` 只能在
匹配上下文中读取。Resource 有数量、总字节和 TTL 上限；完成、取消、超时或 worker
退出时释放。ID 不可枚举，数据库只记录 metadata 和 hash。

首版每个 trace 最多保留 4 个 Resource、合计 40 MiB，TTL 为 10 分钟。任一限制
达到后拒绝新增，不通过淘汰仍可能被后续 parse 调用的 Resource 来隐式腾出空间。

解析结果可以返回受长度限制的文本与定位信息供当前 Agent 使用，但 Tool Audit 不
持久化完整解析结果。Capability A 后续只将必要 EvidenceFragment 写入数据库。

## 14. 首版 Retrieval Tools

### `search_web` v1

输入：查询词、受策略限制的结果数和可选时间范围。输出统一的 title、URL、snippet、
rank、provider 和可选日期。搜索摘要只用于发现线索，不能成为正式证据。

### `fetch_url` v1

只接受预期 HTML 的公开 URL，完成安全请求并返回 HTML resource handle。类型不匹配
失败。

### `fetch_pdf` v1

只接受预期 PDF 的公开 URL，完成安全请求并返回 PDF resource handle。类型不匹配
失败。

### `parse_html` v1

读取当前 scope 的 HTML resource，输出标题、canonical URL、受限正文、链接和结构
定位。移除脚本、样式和隐藏噪声，保留段落、列表和表格文本。

### `parse_pdf` v1

读取当前 scope 的 PDF resource，输出逐页文本、页码和受限 metadata。损坏、加密或
超限文件产生稳定错误。

### `check_link_accessibility` v1

返回可访问状态、HTTP 状态、final URL、content type 和检查时间。先尝试 HEAD；站点
不支持 HEAD 时使用严格限量 GET，不把正文持久化。

## 15. SearchProvider 基准

Provider 使用统一接口和响应 Schema。首批候选建议为 Brave、Tavily 和 Serper；
执行前必须再次确认服务可用性，并至少获得两个 Provider 的测试凭据。凭据只来自
本地加密存储或显式测试环境，不进入仓库。

固定人形机器人查询集覆盖中文行业词、整机、核心零部件、海外公司和官方站点查找。
技术 benchmark 的核心公司参考集与记者最终盲测清单分离，不能替代 Capability A
发布盲测。

查询集 v1 固定为以下十条，每个 Provider 每条取前 20 个结果并完整运行两次：

1. `人形机器人 公司`；
2. `人形机器人 整机 企业`；
3. `人形机器人 产业链 核心零部件 公司`；
4. `人形机器人 减速器 企业`；
5. `人形机器人 伺服电机 企业`；
6. `人形机器人 传感器 企业`；
7. `具身智能 人形机器人 创业公司`；
8. `humanoid robot companies official website`；
9. `humanoid robot startup company`；
10. `humanoid robot actuator supplier`。

技术参考集 v1 固定为 Tesla、Figure AI、Agility Robotics、Apptronik、1X、
Boston Dynamics、宇树科技、优必选、傅利叶智能、智元机器人、银河通用和众擎机器人。
它只用于 Provider 横向比较，不作为 Capability A 的最终“不应遗漏公司”清单。

所有 Provider 使用相同查询、结果数、超时和重复次数。评分：

| 指标 | 权重 |
| --- | ---: |
| 核心公司召回率 | 35% |
| 中文官方站点覆盖 | 25% |
| 链接可访问率 | 20% |
| 噪声与重复率 | 10% |
| 成本 | 5% |
| 延迟 | 5% |

硬门槛：链接可访问率至少 95%，中文查询必须返回有效结果，不得产生危险 URL，核心
公司不得出现系统性类别缺失。至少两个 Provider 完成同一基准后才可选择。没有候选
达到门槛时 Plan 2 应阻塞并报告，不通过降低标准强行指定。

live benchmark 输出放在忽略目录，保存查询、规范化结果、指标、时间和成本，不保存
抓取网页。Repository 中提交固定的人工 fixture 和最终选择记录，不提交 Key。

## 16. 开发检索探针

`RetrievalProbeService` 是固定后端流程，不是 Capability：

```text
query
→ search_web
→ bounded top-N selection
→ check_link_accessibility
→ fetch_url/fetch_pdf
→ parse_html/parse_pdf
→ condensed preview + Tool trace
```

Renderer 只能传查询词。服务固定 ToolSet、预算、N 值和取消范围，不能形成任意网络
代理。开发页面显示执行状态、选择/跳过原因、耗时、重试和稳定错误；凝练预览受长度
限制，不展示完整页面。

开发探针固定搜索 1 次、检查前 3 个去重 URL，并最多抓取/解析其中 3 个；单页凝练
预览最多 4,000 字符，页面只展示合计最多 10,000 字符。Trace 结束即释放所有原始
Resource。

Fake Provider/Transport E2E 必须离线运行。真实 Provider probe 只在显式 opt-in 和
本地 Key 存在时运行。

## 17. 明确不做

Plan 2 不实现：

- Capability Runtime、ResearchCycle、AgentJob 和检查点；
- Discovery/Company Research/Summary Agent；
- 公司、模板、报告、Claim、EvidenceFragment 和 Citation；
- 持久化确认请求和用户确认 UI；
- 社交媒体、Capability B 和付费数据库；
- 浏览器自动化、登录态、Cookie、验证码或脚本执行；
- 任意文件系统、shell 或通用 Renderer Tool API；
- `read_imported_file`、`get_project`、`get_company_report`、
  `open_external_link`、`export_word`；
- 网页/PDF 快照长期保存；
- 公司研究并行化。

## 18. 测试与验收

Plan 2 按严格 TDD 分任务执行。自动测试至少覆盖：

- Registry 重复/未知版本和 Schema；
- deny-by-default ToolSet、项目隔离和原子预算；
- timeout、retry、cancel、并发和迟到事件竞态；
- 单终止事件与秘密脱敏；
- SQLite migration、重启审计和正文泄漏扫描；
- Pi Adapter 与后端直接调用共用 Runner；
- worker 退出和 request/execution correlation；
- IPv4、IPv6、DNS、重定向、端口、大小和内容类型；
- Resource 跨 trace/project 隔离和释放；
- 中文 HTML、表格、链接、多页/损坏 PDF；
- Provider fixture 合同、认证、限流和 malformed response；
- 开发 Trace UI、取消和无迟到更新；
- Fake Electron E2E 连续两次；
- opt-in real DeepSeek Tool Calling 和 live provider smoke；
- arm64 packaged app 启动。

最终人工门槛：真实 benchmark 有书面选择记录；开发探针能展示完整 Trace；数据库和
日志扫描确认没有完整网页、PDF、Key 或原始异常；P1 Chat、项目、密钥和打包能力不
回退。

## 19. 实施任务顺序

1. Tool Contract 与 versioned Registry；
2. ToolSet、Policy 与 Budget；
3. Runner、错误、重试、取消、事件和 test kit；
4. Tool Audit 持久化；
5. Utility Process 协议与 Pi AgentTool Adapter；
6. 安全网络层与 ResourceStore；
7. HTML/PDF/链接 Tools；
8. SearchProvider 合同、候选适配器和 benchmark harness；
9. 真实 benchmark、Provider 选择和 `search_web` 注册；
10. 开发检索探针、Trace UI、E2E 与 arm64 package smoke。

每项任务必须形成独立提交和评审门。外部 Key 只阻塞第 9 项真实 benchmark，不阻塞
前八项离线实现；第 9 项未通过时不能把 Plan 2 标记完成。

## 20. 架构原则

1. Pi AgentTool 是 Agent 接口，Deepfield Tool Platform 是共享执行底座。
2. Tool Definition 只有一份，Pi Adapter 和直接调用共用它。
3. 权限默认拒绝，ToolSet 和预算不能由 Agent 扩大。
4. Renderer 不获得通用 Tool、网络、文件或数据库能力。
5. 原始网页/PDF 只短暂存在于受 scope 约束的内存中。
6. 搜索摘要只发现线索，正式证据必须来自后续原文。
7. 先验证 Tool 平台和 Provider，再让 Capability A 组合它们。
