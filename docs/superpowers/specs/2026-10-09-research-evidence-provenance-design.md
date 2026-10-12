# 调研证据留存与日期溯源设计

状态：2026-10-09 用户确认设计；2026-10-12 实现已纳入版本收口，当前实现与验证边界见 [0.1.1 收口记录](../../releases/2026-10-12-v0.1.1.md)。下文“当前实现依据”保留设计时基线，不代表最新代码。证据留存不等于事实正确性验收。

## 目标与非目标

把一轮实际获取且传给模型的来源资料独立保留下来，使二轮及失败重试不只依赖模型写出的Markdown，便于核查发表时间、材料类型和证据出处。成功标准是证据可追溯、跨阶段一致、旧报告兼容，不是自动判断事实真伪。

不增加模型调用；不部署自动事实自审；不改历史报告；不重做现有结构化事实Schema或Word排版；不引入通用知识库。首版只记录日期溯源，不启用自动超期剔除。后者必须在日期来源规则验证后单独交付。

## 当前实现依据

- `packages/retrieval/src/search-provider.ts`：NormalizedSearchResult有date/publishedAt，但没有日期依据类型。
- `packages/retrieval/src/providers/tavily.ts`及`doubao.ts`：分别将published_date、PublishTime映射至date。
- `packages/retrieval/src/search-tool.ts`：模型输出有结果数量/字节裁剪。因此保存全部服务商响应不等于保存模型看到的材料。
- `packages/capability-sdk/src/execution.ts`：tool_activity已有sources标题/URL，但没有证据正文；它是进度接口，不宜承担证据存储。
- `capabilities/company-research/runtime/company-research-agent.ts`：原始阶段转发工具活动，结构化阶段调用gateway。
- `capabilities/company-research/runtime/company-research-structuring-prompt.ts`：二轮唯一事实输入为原始Markdown。
- `packages/persistence/src/company-research-run-repository.ts`：completeRaw切换至structuring；retryStructuring保留原始结果，retryResearching重建运行内容。
- 现有Harness检查标题—URL配对，不证明网页支持主张，也不校验事件日期。
- `apps/desktop/src/worker/agent/pi-agent-executor.ts`：prepareNextTurnWithContext将工具文本再次slice至16,000字符，finalizationMessages重组收尾材料，故工具formatOutput不是最终观察点。
- `capabilities/company-research/runtime/company-research-agent.ts`：structureRepairPrompt另建修复输入，当前没有证据包。
- `apps/desktop/src/shared/model-gateway.ts`：按contextWindow设置输出maxTokens，但本次检查未发现完整请求输入Token预算准入机制；本稿新增预算规则，不声称已有实现。

## 方案取舍

采用“通用运行时提供可选结果观察接口，Capability组装并保存证据快照”。不从生成后的Markdown反推证据，不把完整网页/请求头塞入进度事件，也不让Search Provider感知调研截止日。

与只增强Prompt相比，此方案能保留原始依据；与完整证据知识库相比，范围限制在一个调研run及其当前raw attempt，成本较小。通用层只提供观察能力，日期准入与调研持久化属于Capability，依赖方向不倒置。

## 最小证据记录

建议独立version=1的快照，附属run，不改变结构化报告v1字段。

|字段|规则|
|---|---|
|evidenceId|宿主/程序生成，当前raw attempt内唯一，不由模型任意指定|
|requestId、toolCallId、attemptId|关联实际调用；防止旧attempt迟到结果混入|
|kind|search_snippet或page_excerpt；只下载而未提取正文的资源不冒充网页摘录|
|url、title|工具实际返回的原链接及标题；重定向时另保留requestedUrl/finalUrl，不推断URL|
|savedText|由modelVisibleText按归档上限保存的前缀；不得再把savedText无条件称为完整模型可见文本。不存密钥、请求头或整份原始provider响应|
|capturedAt|工具结果采集时间，不冒充发表时间|
|sourceDate|可空：值、精度、日期性质、原字段和依据来源；首版只接已知Provider字段，未知语义记unknown|
|visibleBytes、visibleHash|最终请求中该证据投影的UTF-8字节长度及SHA-256，在归档截断之前计算|
|savedBytes、savedHash|实际落库savedText的UTF-8字节长度及SHA-256；不以此替代visibleHash|
|modelProjection|模型请求ID、阶段（ordinary/synthesis）、消息位置、origin/toolCallId；区分同一工具结果在不同轮次的不同投影|
|modelClipping|工具结果格式化及收尾裁剪的版本、前后长度/hash、可确定的省略条目数；数目不可确定写null，不写0|
|archiveClipping|归档截断/整项省略的原因、省略字节/条目计数；与modelClipping分开|

sourceDate的依据来源至少区分provider_metadata与unknown；日期性质区分published与unknown。**原文由Provider适配层在归一化之前保留**：豆包PublishTime在slice之前保存完整字符串，Tavily保留published_date原字符串；记录provider、fieldName、rawValue、normalizedValue、precision。规范化字段继续兼容现有date，不从截短date反向重建rawValue。无日期或非法值分别记录missing/unparseable，不猜测；字段类型不是字符串时记录类型不保存任意对象。日期原文安全上限2 KiB，超限须标rawValueTruncated及原长度/hash，不声称完整。该元数据通过规范结果与Worker证据协议后传，不改变Provider的业务职责。

只有确定可解析且字段语义明确时写规范日期。不得用抓取日、URL日期或新闻日补事件日；不解析“3天前”等相对时间生成伪精确日期。

首版不新增模型填充eventDate字段：现有timeContext仍为模型陈述，不是已核实时间。将来若增加事件日期，必须关联支持该日期的原文片段，不能简单复制sourceDate。

## 采集与跨阶段流程

1. 调研启动时程序生成attemptId，开启仅本run有效的结果观察。Chat未启用该观察时行为保持不变。
2. 采集只采用成功且通过工具输出校验的结果。明确两处不同职责：工具格式化边界保留来源及裁剪元数据；**实际模型请求装配完成、所有上下文/收尾裁剪及协议转换完成后、网络dispatch之前**记录最终证据文本投影。普通工具轮和synthesis请求均必须观察；后续不得再变换已观察文本，否则必须重建投影与hash。这里“模型可见”仅指客户端实际发出的文本，不证明服务商处理或模型注意到它。未dispatch只记prepared，不计已发送；发出但结果失败记dispatched/响应状态，不推断消费成功。

   保存同一工具结果的不同投影，不用一个hash覆盖所有轮次。收尾投影必须含真实16,000字符裁剪后的文本与程序追加的来源定位内容。用程序侧origin映射追踪，不解析模型生成正文反推来源。来源映射不完整时显式标unmapped，不伪造精确事实映射。仅下载未提取的资源不得记page_excerpt。
3. Capability Worker通过独立、带schema的证据事件传给Application，严格校验run/request/attempt关联。复用现有顺序事件处理，不新增并行写库队列。
4. 以run和attempt保存证据行；证据写入先于raw完成状态。写失败不能假装已经留存：沿用storage_failed路径停止后续结构化，保留可诊断原因。
5. Application确认本attempt的证据事件序号连续、所有写入已完成、完成清单计数/hash吻合后，在**同一数据库事务**内保存原报告、冻结快照、保存首次证据包/组包失败结果，并更新阶段状态。成功路径原子进入structuring；组包预算不足路径原子保存原报告及冻结快照、进入structure_failed且code=context_budget_exceeded，不发送模型请求。事务内校验run/attempt/status，任何条件不符整笔回滚。Worker的completed并不直接触发completeRaw旧路径。

   新建及重新联网attempt持久化evidencePolicy=required_v1；迁移前旧运行明确为legacy_optional，不由“有没有证据行”推断。新运行缺完成清单、缺事件、hash不符均为evidence_incomplete，不能走legacy_missing，也不能进入结构化。零条材料可合法冻结，但必须有完整的0条清单（例如无成功检索）；这与材料丢失不同。

   组包可在事务前以已完成的staging快照计算以缩短锁时间，但事务内必须重新核对attempt、事件末序号和快照hash，不一致则拒绝提交，不能保存过期包。冻结后任何追加证据事件均拒绝；重复事件以相同ID/hash幂等，不同内容同ID报完整性错误。
6. 二轮指令允许用片段核对/缩窄原报告，禁止从片段新增研究结论或借外部知识补齐。继续保留来源标题—URL配对校验；本批不放宽原报告来源白名单，不让证据包扩大可引用来源集合。

## 有界存储与上下文

首版每raw attempt最多200条保存文本、合计512 KiB（UTF-8）、单条最多12 KiB；按成功工具结果的稳定序号归档，截断不得破坏Unicode字符。工具裁剪先于归档裁剪，两者分别记录。文本达上限后仍维护本attempt的总可见/保存字节、条目数及省略计数；元数据也有受限上限（1 MiB），无法记完整清单则以evidence_incomplete失败，不静默省略清单。重复投影可内容寻址复用保存文本，但保留每次请求引用与长度/hash。

完整留存定义为所有已dispatch证据投影都有对应记录，且各visibleHash=savedHash、visibleBytes=savedBytes，无归档省略。模型侧裁剪不等于归档不全，反之亦然。归档少于可见内容时，来源界面明确显示“检索依据部分留存”，展示已存/可见条目和字节及省略原因；单片段标“摘录已截断”。工具侧过滤/裁剪另说明“模型收到的结果已裁剪”，不得宣称保存了完整网页。prepared未发送、归档缺失与日期未知分别展示，不混为同一风险。

### 固定证据包

首次组包仅从冻结快照中选择原报告引用URL对应的savedText，按原报告来源出现顺序、再按稳定采集序号选择；同一工具的不同投影优先原始阶段普通轮已dispatch投影，若仅有synthesis则取该投影，不重复加入相同内容。每片段最多2,000 Unicode字符，包正文最多24,000 Unicode字符，这只是额外产品上限，**不是Token预算**。保留可见/保存/入包三组长度与hash、选中ID、每条包内截取范围、未选原因和数量。

首次组包成功后落库**实际包正文字符串、UTF-8 hash、packetVersion、组包算法版本及参数、快照hash**。首次结构化、自动格式修复和用户二轮重试从数据库取同一正文，不重新执行组包算法。包作为同一受分隔数据块插入，每次dispatch前重算包hash并记录到诊断；请求的其余内容允许因修复或模型配置变化而不同。修复提示同步增加固定证据块，不仅继承“有证据”的系统指令。已经建立包却缺包/hash不符直接拒绝，不退回只用原报告；只有明确记录为首次组包预算失败、从未建立包的运行，允许按下述规则首次建立包。

### 唯一预算规则（新增，非现有能力）

首版采用跨协议统一的**保守字节代理预算v1**，不冒充模型精确Tokenizer：先构造与实际adapter一致的全部文本消息，令E=各文本UTF-8字节数之和＋每条消息256＋固定2048；O沿用网关输出上限min(8192,max(1024,floor(C/8)))并显式传入请求；安全余量S=max(4096,ceil(C×0.1))，C为本次运行模型配置的contextWindow。准入要求E+O+S≤C。工具关闭，不隐藏工具Schema；模板、Schema、上下文、分隔符、原报告、证据包及系统指令全部计入。

该代理偏保守，可能提前拒绝能发送的内容，且不能保证任意兼容服务商的真实Tokenizer/隐藏开销或用户填写的C正确；服务商仍报context limit时记录稳定预算错误，禁止自动改包或无证据重发。界面称“估算上下文预算不足”，不报告虚假的精确Token数。

为覆盖自动修复，首次准入同时检查普通请求及最坏修复请求：按同一规则计完整修复指令、上下文、模板、Schema、原报告、固定包和分隔符，额外预留失败候选16 KiB、校验反馈8 KiB的UTF-8文本预算。实现将现有候选16,384字符截取改为16 KiB安全字符边界截取；反馈过大用固定机器码和有界问题列表降至8 KiB，明示省略数量。此处容量指最终插入消息的文本，JSON转义后计数；超限优先减少候选/问题列表，不破坏JSON，也不裁原报告/证据包。失败候选沿用本地诊断容量上限并标注截断，不承诺完整保存候选。实际修复请求再次准入，超过预留即拒绝，不能在错误处理链路绕过预算。

固定执行顺序：

1. 首次无包时先检查不含证据的完整基础请求和修复预留；已超预算直接structure_failed，保留原报告/快照。
2. 在剩余预算内按既定顺序加入完整元数据＋受限片段；放不下最后片段时按Unicode边界缩该片段，剩余记录不入包，记录原因。这是唯一允许缩包的时点。
3. 有候选证据但连一条带非空文本的记录都放不下，拒绝context_budget_exceeded，不生成空包代替。确实没有匹配证据可保存有明确原因的空包，不能把容量不足伪装成无材料。
4. 冻结包后，每次首次结构化、自动修复、手动重试按当前请求与预留复算准入；不足直接structure_failed，保留同一包，不缩包、不换算法、不自动换模型。用户可选择足够上下文的配置后重试，包正文不变。
5. 从未成功建立包的预算失败运行，可在用户选择足够配置后首次建立包；必须事务性检查packet仍不存在。已有包不允许覆盖。自动修复始终不新增联网调用。

这只是来源级对齐，不证明片段完整支持原子事实。二轮仅补引用而不改事实不能算内容纠错；标题和正文均为待判断资料，不一律视作真值。

## 生命周期与兼容

- 原始阶段失败：保留已采集快照用于诊断，不标记为完整证据集。
- 仅二轮重试及自动格式修复：复用同一raw attempt快照与已持久化包正文，不重算包，不搜索、不补采；预算不足按上述唯一拒绝策略。
- 修改研究条件并重新联网：创建新attempt，当前快照不混入上次资料；旧attempt资料依现有诊断保留策略处理，不另起无限历史系统。
- 用户取消：遵守现有“取消移除当前调研”语义，证据与该运行一起删除；已完成其他报告不受影响。
- 删除报告：在同一事务清理附属证据；不能删除别的报告共享网页资源。
- 旧报告无快照：只对持久化legacy_optional运行使用legacy_missing；继续原链路显示/导出/二轮重试，不给用户增加开发历史造成的警告。任何新required_v1缺失快照都报错，不伪造空快照或降级为旧运行。
- 中断恢复：冻结事务提交前中断，保留researching的staging证据并按现有中断失败语义终止，不启动二轮；提交后中断，原报告/冻结快照/包和状态必须一致，按现有策略转structure_failed供用户重试，不自动发起付费调用。若required_v1已处structuring却缺任一必需材料，按完整性错误隔离，禁止重新组包或legacy回退。取消/迟到事件与冻结事务竞争时，通过run/attempt/status条件阻止复活已删除运行。
- 数据库采用附属表/Capability迁移追加，避免改写历史结构化JSON；不直接使用通用工具日志作为唯一证据存储，避免日志清理破坏报告依据。

## 用户可见范围

首版在报告来源旁增加可展开的“检索依据”，显示本次保存的片段、来源原链接、日期出处与材料类型，复用现有悬停复制链接。明确这是检索依据，不是“已核实”。同URL有多个片段时都可查看，不伪造事实到精确引文的一对一映射。

没有快照的旧报告保持现状。Word导出格式不改；证据详情只在应用内先跑通。不新增显眼的通用警告或自审绿灯。

## 必要验收

1. 使用本地固定搜索结果与网页提取结果，验证实际可见片段保存、类型与日期出处不混淆；无付费调用。
2. 真实Worker协议集成：工具结果→证据事件→保存→二轮请求，断言片段、run/attempt关联和包hash，不只测纯函数。
3. 事务故障注入覆盖原报告保存、冻结、包写入、状态切换每一步：回滚不得留下半提交；提交前/后中断恢复与required_v1缺失分别验证。旧attempt迟到、重复事件、取消竞争不污染或复活运行。
4. 首次结构化、自动格式修复、用户二轮重试实际请求中的证据块逐字/hash相同，均无新增搜索或网页抓取调用（仍允许必要的LLM请求）；升级组包算法及缩小模型上下文后重试分别保持原包、拒绝发送。重新联网不带旧快照；旧报告继续可读可导出。
5. 普通工具轮与真实收尾16,000字符裁剪分别捕获正确投影；叠加12 KiB归档裁剪、总量超限，断言visible/saved/packet长度及hash、全部省略计数、界面“部分留存”。以多字节中文及Unicode边界验证，不用字符数冒充字节数。
6. 豆包PublishTime含时分秒/时区、无效值、缺失值经过Provider→工具→Worker→数据库后原文及出处仍可识别，不从date补造。预算测试覆盖普通/修复最大输入、基础超限、一条证据也放不下、成功缩包、冻结后配置变小；全程无付费API。
7. 手测来源展开、复制原URL、切换版本与二轮重试。功能跑通不等于报告语义质量改善。

## 交付边界

本稿仅设计。下一步先按宿主观察接口、Capability存储/重试、二轮与来源展示拆实施计划；开发交子Agent，主Agent验收。不合并、不推送、不打包，除非后续明确要求。工作区已有实验和其他改动全部保留。
