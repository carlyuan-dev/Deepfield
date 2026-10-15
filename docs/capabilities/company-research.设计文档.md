# 公司调研设计文档

更新日期：2026-10-13。本文维护公司调研包的长期领域契约；具体动作与实现以包内文档和源码为准。
公共接入遵循 [Capability 协议](capability.protocol.设计文档.md)，开发与检查方式见 [开发文档](../development.md)。

## 定位与责任边界

产品提供带来源、供记者核验的研究素材收集与整理。结构合规、来源编号存在、搜索调用成功、证据可追溯均不能证明事实正确，报告不可直接视为可发布稿。

Chat 与 UI 共用公司调研业务动作、队列与报告，不创建隐藏 Conversation，不把调研正文写成 Chat 消息历史。包负责主题、公司、模板、两阶段状态机、Harness 和产物；宿主负责通用授权、模型/Search 服务及传输。

## 公司主体与主题关联

公司基础实体全局共享，规范名称按 trim、Unicode NFKC、空白折叠和小写去重；展示名称与已核实公司主体应区分。主题—公司关联承载候选备注，研究记录绑定具体关联，因此同一公司在不同主题中的调研上下文和版本独立。

移除关联不影响其他主题引用的公司；零引用公司及被移除关联下的报告按事务和外键生命周期清理。批量删除不能产生半完成状态。

公司新增先持久化实体与关联，再安排后台资料补全。补全失败、等待配置或主体待确认不应阻塞列表浏览、公司管理或直接调研；调研服务校验目标关联及本轮输入，不以资料 `ready` 为硬门槛。报告使用启动时的上下文快照，正式两轮调研不顺便生成或写回公司档案。

资料更新统一从公司详情的“更新信息”入口发起，列表不再提供重试叹号；更新期间禁用重复提交，详情显示更新中、部分未知或失败待再次更新的状态。更新失败只改变状态和安全错误，不清空既有人工字段与来源。补全进度按当前主题关联动态计数；删除关联后不再计入该主题，仍被其他主题引用的公司继续共享补全，不因单个主题移除而误取消。具体入口见 [公司页面](../../capabilities/company-research/ui/IndustryResearchCapability.tsx)，字段与来源保留见 [公司存储](../../packages/persistence/src/company-repository.ts)。

补全引用必须来自本轮成功工具结果，摘要与已读网页分开；品牌、产品不能冒充公司主体。具体编号、一次修正预算与身份门禁见包内正式文档 [公司补全：来源编号与公司主体](../../capabilities/company-research/docs/profile-evidence-and-identity.md)。

实现入口：[主题与公司服务](../../capabilities/company-research/application/industry-research-service.ts)、[后台补全](../../capabilities/company-research/application/company-profile-enrichment-service.ts)。

## 输入、模板与两阶段产物

本轮输入为研究方向、可选具体关注范围 `focusScope`、截止日 `asOfDate`；截止日须为真实日期且不晚于启动当天。主题范围与本轮关注范围是不同字段，修改后者不改主题。

四个内置方向分别为产品与技术、市场与商业化、产业链与竞争格局、公司经营与业绩。每个方向使用五个固定模块；模板注册表是 Prompt、校验与呈现的共同来源。运行保存上下文与模板快照，模板更新不能重写历史标题、顺序和语义。

原始阶段允许搜索与网页读取，生成只读 Markdown；结构化阶段关闭网络工具，仍调用远端 LLM，以原报告、冻结证据包、模板及 Schema 整理结构化报告。Harness 校验结构、引用与语义不变量，允许有限确定性修补及有界格式修正，不能凭空添加证据。两阶段由 Application 编排，Worker 只执行阶段调用。

状态为 `researching → structuring → completed`，失败分别进入 `research_failed` 或 `structure_failed`。原始阶段失败不保存残缺正文为正式报告；结构化失败保留原始报告。新运行原报告、证据冻结、证据包状态与阶段转换须在同一事务提交，结构化成功产物与完成状态同样原子保存。

实现入口：[模板](../../capabilities/company-research/contracts/company-research-templates.ts)、[研究服务](../../capabilities/company-research/application/company-research-service.ts)、[Harness](../../capabilities/company-research/application/company-research-harness.ts)。

## 统一队列、恢复与取消

单公司提交、批量提交及失败重试进入同一个全局持久化串行队列；可追加不同主题条目。每条保存输入快照，实际开始时才创建或复用报告，等待条目没有空报告版本。每家公司完成原始与结构化两阶段后再执行下一条；单条失败计入已处理并继续，配置或鉴权问题使队列暂停，避免盲目重试。

同一公司不能同时重复入队：一次批量输入拒绝重复 companyId，追加时拒绝已在全局队列 `pending` 或 `running` 的公司，即使来自不同主题。终态条目不永久占用公司；主题或公司关联的删除也须拒绝与其等待/活动条目冲突的操作。

队列和研究服务共享执行占用；数据库活动运行约束兜底，不能同时存在原始和结构化两个活动运行。后台补全在任务边界检查前台占用，队列保留执行权时不继续派发补全。普通 Chat、公司导航及页面收展可继续；离开页面不会取消研究。

重启把遗留原始/结构化运行恢复为对应失败状态，持久队列恢复为暂停，必须显式继续，不自动重放付费工作。

取消可针对单条或全局队列；全局取消先持久化 `cancelling`，阻止下一条派发，再等待当前任务取消结束后释放占用。主动取消删除当前未完成报告及附属证据，即使该报告来自原地重试；已持久化的终态报告、其他版本继续保留。取消等待条目不创建报告。完成与取消竞争时按持久状态判断，不能删除已提交的终态。

进度是已处理/总条目数，包含失败；失败数另列，不把处理数写成成功数。全局队列可能跨主题，控制入口必须明确队列或条目 ID。

实现与动作：[队列服务](../../capabilities/company-research/application/company-research-batch-service.ts)、[queue.get](../../capabilities/company-research/docs/actions/queue.get.md)、[queue.cancel](../../capabilities/company-research/docs/actions/queue.cancel.md)。

## 版本、失败重试与删除

“新的调研”创建新版本；“重新尝试”复用选中版本，保存最近一次实际提交输入，不堆积重复失败条目。预检失败不改已有版本。

共享 [重试策略](../../capabilities/company-research/contracts/research-retry-policy.ts) 决定普通失败重试路径：

- `research_failed` 重跑原始阶段。
- `structure_failed` 且规范化输入未变、搜索状态不是 `none`、无证据完整性失败时，只重跑结构化，保留原报告与冻结包。
- 输入变化、搜索状态 `none` 或 `evidence_incomplete` 时重跑原始阶段，清理旧证据并建立新 attempt。
- `completed + searchStatus=none` 可原地完整重跑；其他完成报告及旧版自由报告不进入普通失败重试。

专门的 `retryStructuring` 动作只接受结构化失败版本，仍须通过材料完整性与预算检查。不能把它与普通失败重试表单的路径判断混同。

终态版本可二次确认后定向删除；服务再次校验主题、公司、run 归属及执行占用。同一事务清理报告、证据、关联诊断与可追踪的工具审计；不影响其他版本。审计通过诊断 trace 关联，尚未建立独立持久 run/attempt—trace 关系，不能承诺异常退出前所有工具审计均可经该路径清理。

## 搜索状态与来源约束

`searchStatus` 区分历史 `unknown`、本轮初始 `none`、可信原始阶段 canonical `web_search` 成功事件后的 `succeeded`。事件须匹配 request/run/stage；失败、复用、外来及迟到事件不提升状态。零结果可以表示一次调用成功，不能当作获得有效证据；工具终态成功也不能证明网页正文非空或已完整核读。

完整重跑重置搜索状态，仅结构化重试保留。报告及导出对 `none` 给出联网状态提示，不从模型正文网址、调用计数或来源编号推断联网成功。

Prompt 要求来源归属、时间范围与忠实摘录：保留判断主体、型号范围、数字口径、时间、条件和预测语气；摘要同样受限。不得把材料缺口写成现实不存在，或跨片段拼出新关系。

## 证据留存、日期与二轮一致性

证据在实际模型请求边界观察，记录检索片段/网页摘录、原链接与类型、请求及 attempt 关联、时间出处、长度和 hash；不能从模型生成的 Markdown 反推实际检索证据。只下载资源不能冒充已提取网页正文。

模型侧格式化/裁剪、归档侧裁剪、二轮包取舍分别记录。`visibleBytes/visibleHash` 描述模型投影，`savedBytes/savedHash` 描述实际留存；有界保存的前缀不能称为完整模型可见材料。界面“检索依据”可展示同 URL 多个片段及完整/部分留存，不伪造事实与精确引文的一对一证明。

Provider 原始日期字段在规范化前留存，区分发表时间、未知语义、缺失与无法解析；抓取时间不是发表时间，发表时间也不是事件时间。不用 URL 或相对日期补造精确日期。当前只留存日期出处，尚未实现自动按截止日剔除材料。

新运行 `required_v1` 必须具备完整性要求的快照与包；旧运行 `legacy_optional` 允许无证据兼容，继续阅读、导出与既有重试。新材料缺失必须明确失败，不能伪造空快照或回退历史模式。原始失败留存的 staging 材料只用于诊断，不称完整证据集。

首次结构化、自动格式修正和二轮重试复用同一持久化包正文。首次组包可按预算有序缩取，冻结后不得为小上下文重新缩包或无证据发送；仅明确从未建立包的预算失败运行可在配置充足后首次组包。预算以保守 UTF-8 字节代理估算，包含全部文本、输出与修正预留，不声称精确 tokenizer；不足时保留原报告并明确失败。

实现入口：[请求观察](../../apps/desktop/src/shared/model-request-observation.ts)、[证据存储](../../packages/persistence/src/company-research-evidence-repository.ts)、[证据包](../../capabilities/company-research/runtime/company-research-evidence-packet.ts)、[预算](../../capabilities/company-research/runtime/company-research-context-budget.ts)、[日期出处](../../packages/retrieval/src/publication-date.ts)。

## 阅读与 Word 导出

原始报告复用安全 Markdown 呈现；结构化报告使用领域视图。Provider 文本不能注入原始 HTML，HTTP/HTTPS 链接使用安全打开与复制边界。旧 `legacy-freeform-v1` 报告保持只读兼容。

用户可选择已有原始、结构化或两者导出 Word；导出忠实使用保存产物，不再调模型或重新联网。结构化事实按 URL 编号，保留模块资料来源；原始内容保留真实安全链接并形成来源附录。检索依据详情目前在应用内展示，未加入 Word 附录。保存对话框取消返回 `cancelled`，只有 `saved` 表示文件成功保存。

实现与动作：[Word 文档](../../capabilities/company-research/export/company-research-word-document.ts)、[reports.exportWord](../../capabilities/company-research/docs/actions/reports.exportWord.md)。

## 验证与未实现边界

验证按风险覆盖状态/事务、重试与取消竞争、跨轮包一致性、来源类型/日期、预算及关键 UI；使用本地固定工具结果可验证工程契约，不替代真实报告质量评阅。

证据留存不等于自动事实判断、可信度评分或日期准入。报告编辑、人工核验状态、跨版本差异、模板管理及重启自动续跑付费工作不属于当前承诺。

截至 0.1.1 的 [版本收口](../releases/2026-10-12-v0.1.1.md) 记录了局部工程验证及已复现基线失败，不能写成全仓全绿。raw-v3 的完整真实联网流程未在该次收口重跑；固定输入二轮单例与不同历史版本的材料评阅不能汇总为同版本准确率或质量提升。已观察到摘要范围扩大、归属丢失、时间口径及引用错配，仍需人工核验；用户对用途的认可不抵消具体错误，也不是机构背书。
