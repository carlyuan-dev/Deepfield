# Base.Search 设计文档

Search 提供搜索 Provider、公开网页读取、HTML／PDF 解析和资源生命周期管理。Config 生成执行快照；调用方决定联网许可、任务策略和工具额度；Search 按传入快照执行请求。

## 公开入口与依赖

`@deepfield/base/search` 是浏览器安全入口，公开搜索请求与响应、来源日期元数据、输出 Schema 和安全错误。`SourceDateMetadata` 由 Search 定义，Capability SDK 单向转出；模型证据来源、工具来源和研究证据仍由 SDK／Capability 定义。

`@deepfield/base/search/runtime` 提供 `createSearchProvider`、Provider HTTP client、安全 HTTP transport、URL policy、ResourceStore、HTML／PDF parser、网页读取和 Usage 装配函数。Node 网络、DNS、流、哈希以及 cheerio、pdfjs、ipaddr 只在运行时依赖图中加载。Search 使用 Config 和 Usage 的中立契约，依赖图不得进入应用、SDK、业务 contracts 或工具平台。

旧 `packages/retrieval` 服务入口仅转出 Base 实现；web_search、read_webpage、fetch、parse 和 link check 工具定义由 [Base.Tools/web](base.tools.设计文档.md) 适配，retrieval 工具入口单向转出。适配层将 `SearchResourceError`／`TransportError` 映射到工具错误，并把可信工具上下文绑定为资源作用域。旧入口在现有工具消费者及 benchmark／live 设施迁移完毕后才可删除；不另维护服务副本。

## 搜索请求与配置

`SearchProvider.search(request, signal)` 和 `createSearchProvider(snapshot, options)` 保持既有契约。请求在 dispatch 前验证查询、结果数量和日期范围。Provider 负责固定协议、认证头、应用层失败识别与结果归一化，HTTP client 保留原超时、大小边界、取消及 Retry-After 行为。工具平台继续决定工具重试。

执行只使用传入的 `SearchRuntimeSnapshot`，不重新解析 active Profile。调用方从 Config 取得快照时完成凭据与 revision 解析，后续配置编辑不替换运行中快照。Profile／草稿身份和 revision 与该快照绑定；密钥只交给可信请求执行端。

归一化结果保留完整校验后的 HTTP(S) URL、排名、Provider、标题、摘要及可选来源名称。可识别的发布日期和原始来源日期元数据分别保留；缺失或格式错误的可选日期不伪造有效日期。日期字段的长度、类型、原值截断与哈希继续受公开 Schema 和解析规则约束。

## 网页与解析

安全传输在请求及重定向阶段验证 URL、DNS 和公网地址，使用固定解析地址建立连接；有界读取和解压继续限制响应资源。`fetchResource` 将下载结果存入作用域资源仓库；`createHtmlParser`、`createPdfParser` 消费一次性资源，解析后清理缓冲区。资源作用域由调用方提供，工具适配从可信运行上下文构造，不能由模型自报授权范围。

`createWebpageReader` 组合下载与 HTML 解析，返回有界文本、canonical `url`、`requestedUrl` 和真实响应 `finalUrl`；保留字符数与截断标记。HTML 的链接、结构定位和文本上限，PDF 的页数、文本与 metadata 上限沿用现有行为。PDF loader、页面清理、destroy 与取消相互协调，取消不等待不可终止的第三方 Promise，终态错误不携带原始文档内容。

## Usage 与取消

`createMeteredSearchProvider(runtime, snapshot, options)` 接收 `SearchUsagePort` 和配置身份函数。应用保留 ALS 上下文、recorder、跨进程输送和关闭 flush；Search 在 Provider transport 的实际 dispatch 边界开启一次 Usage attempt。

参数非法或请求开始前已取消时不记录 attempt。空结果记录成功且 `resultCount = 0`；已发出请求的传输失败、Provider 应用层失败与取消分别记录对应终态。取消监听同步结束已开启 attempt，允许应用随后 flush；迟到成功、失败或重复取消不能重复结束记录。重试产生的新实际 dispatch 分别计量，ToolRunner 的执行次数不等于 Usage attempt 数量。

Usage 只接收不含凭据的配置身份、来源、revision 和结果数。采集失败不改变服务请求结果；错误和计量契约分别由 Search 与 [Base.Usage](base.usage.设计文档.md) 管理。

## 验证边界

Provider 请求／响应、URL 安全、资源所有权、解析上限与取消继续复用 retrieval 的现有回归。Base 的传递依赖检查约束服务分层，浏览器入口构建检查阻止 Node／解析运行时进入安全契约。计量测试覆盖实际 dispatch、无效请求、预取消、空成功及同步幂等取消；配置身份集成验证显式 Usage 端口。真实 Provider 和桌面旅程按具体变更另行验收，自动构建不替代其结果。
