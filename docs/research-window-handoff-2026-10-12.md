# 研究评估窗口向主开发窗口同步

同步日期：2026-10-12。以下同步本窗口完成的研究、产品修改与验证结果，供主开发窗口接续。

## 可直接转交的整合说明

本窗口起初为 Agent 开发求职梳理 Deepfield 的实现与贡献，随后将重点转向报告可靠性评估：研究目标不是证明两阶段必然优于单阶段，而是检查事实是否真正得到引用支持、用户问题是否覆盖、不确定性是否被如实表达，以及执行成本。本轮开展小规模探索，使用 deepseek-flash，先后采用 Tavily 和豆包 Custom；对比过一轮联网直接生成结构化 JSON，与一轮联网形成原始报告、二轮关闭网络工具进行结构化的流程。“离线结构化”仍调用远端 LLM，只是不再开放搜索和网页读取工具。用户评阅荣耀、小米报告后，确认了截止日之后的信息进入结论、发布与开售混淆、季度因素解释全年、估算数字写成直接披露、引用未支持完整主张等问题，说明结构合规和引用编号存在不能等同于事实正确。之后围绕荣耀归档材料做日期准入实验：100项材料按保守规则分为19项可用（13项研究期内、6项历史背景）、1项明确超期、80项待核；19项均来自同一官网列表，“可用”仅指准入，并非独立核实或一定切题。IDC博客公开日期证据不足，未进入试验组，不能据此判定其数据错误或已经超期。筛选阻断了明确晚发材料，但削弱市场表现等覆盖，并改变材料数量、来源组成与输入长度，因此不能将报告差异单独归因于日期规则，也不能声称整体质量提高。进一步固定19个片段研究主张支持、摘要与最小修订，发现“输入合格不保证输出合格”“事实行受支持不保证摘要受支持”：模型可能把材料缺口写成现实不存在、把不同片段拼接成没有依据的关系、把发表日当事件日，或在摘要中新增范围和分类。

基于上述问题，本窗口推进的主要产品修改是调研证据留存与二轮输入一致性，而不是自动事实裁判：在实际模型请求边界观察检索工具文本，经 Worker 事件进入持久化，区分模型侧裁剪、归档侧裁剪和省略，保留请求关联、长度及 hash；原报告、冻结快照、二轮证据包及阶段切换原子保存；新运行要求留存证据，不能用旧数据兼容状态掩盖缺失；首次结构化、自动格式修复及用户二轮重试复用持久化证据包正文，并在发送前校验，预算不足时拒绝而不是静默退回无证据模式。预算涵盖指令、模板、Schema、原报告、证据包、修复附加内容及输出预留，首次允许按规则缩包，冻结后不重新拼出另一份包；字节估算不被描述为精确 tokenizer。Provider 层补充原始日期出处留存，特别是豆包 PublishTime 在截取规范日期前保存原字段；界面增加可展开的检索依据，并区分完整、部分留存和旧报告。相关中断、事务回滚、取消删除与跨轮一致性通过对应开发测试验证，不能用本次内容评估代替功能验收，也不声称证据留存本身已经提高事实准确率。

用户随后明确产品定位应是信息收集整理，而不是反复评价证据够不够：因此调整两轮 Prompt，去掉例行的“缺少独立复测、第三方依据、客户案例”等多余评价，但不得顺便加强结论；要求重述事实尽量忠实沿用原文，保留判断主体、型号范围、数字、倍率、时间、条件和预测语气，摘要同样保留限定，不用跨片段拼接新增关系。当前提示词版本为 company-research-raw-v3 与 company-research-structure-v4。阿里产品与技术样例先跑过 raw-v2/structure-v3 的完整流程，之后固定其原始报告、证据包、上下文、模板及 Schema，只重跑 structure-v4；两个已知问题得到定向修正：“提升至三倍”未再改成“提升三倍”，评测提升保留公司披露归属，也没有重新出现例行缺口评价。但新版仍将 Max 型号信息扩大为整个系列，并有事实句未带上旁列元数据中的公司主张限定。后一次是已见问题的单例回归，不是新任务泛化评估，也没有验证 raw-v3 的全流程实际生成效果。

最终按用户要求快速收口，复用四个方向的四份报告：阿里产品与技术、荣耀市场与商业化、小米公司经营与业绩、华海清科产业链与竞争格局。每份定向检查5条完整事实及全部4条核心摘要，合计20条事实、16条核心摘要；由 Agent 检查并复核，部分依据继承用户明确给出的历史核验，不应写成新增人工逐条核验。样本是风险导向选择，版本、输入和 Provider 不同，不能汇总为同一版本准确率；只有阿里属于新版二轮定向回归，其余为历史报告。检查再次确认摘要范围扩大、公司归属丢失、时间和审批阶段混用、指标口径与原引用错配等剩余问题。阿里4次网页读取中有1次空正文，工具终态成功不等于获得有效网页正文；仅搜索片段支持的引用不能宣称已完整核读。本次收口没有新增模型调用或付费搜索调用。用户已接受以“带来源、供记者核验的研究素材整理工具”作为定位，结束探索并转向功能迭代；既有记者现场观看流程及报告后给出的口头可用性认可继续保留，但不是机构背书，也不抵消本轮具体错误。历史错误报告应原样保留作反例，不能当作已修复的交付成品。本次用户确认只针对收口判断；所有“已落地”功能仍以对应开发验收记录为依据。

## 主开发窗口接续注意

- 已归档的摘要范围、时间口径与引用错配反例可用于后续相关功能的回归验证。
- 不回退上述证据契约或忠实摘录要求。尤其不要把“去掉多余评价”理解为删除来源归属、计划语气或事实本身的限制条件。
- 本窗口此前执行过定向测试、类型检查、构建与打包；Prompt 调整有35项定向测试通过记录。此前全量检查仍有已复现的基线失败，不能宣称全仓测试全绿。本同步任务没有重新运行产品测试。
- 当前工作区仍有大量已修改及未跟踪文件，不能把 `git status` 中所有变化都默认归属本窗口，也不能认为已提交或推送。主开发窗口集成前应核对实际 diff、迁移和安装的 Capability 包版本；不要用清理命令移除实验材料或其他窗口修改。此前产物位置为 `release/mac-arm64/Deepfield.app`，产物存在不代表后续源码变化已重新打包。

## 定位入口

以下路径均相对于 `/Users/carl/Project/Deepfield`。归档结果可能不随 Git 自动分发，接收窗口若在另一台机器，应另行确认这些材料可访问。

- 最终收口及四方向逐项依据：`benchmark-results/research-eval/closeout-20261012/结论与核验.md`；同目录的 `product-audit.md`、`market-audit.md`、`finance-audit.md`、`valuechain-audit.md`。结论文件保留当时“待核验”措辞，用户已在本窗口随后明确接受，以本同步记录补充该状态。
- 阿里完整样例：`benchmark-results/research-eval/prompt-clarity-20261012-alibaba/`；固定输入二轮回归：`benchmark-results/research-eval/prompt-faithfulness-20261012-alibaba/`，重点看 `review.md`、`input-manifest.json`、`model-requests.json` 和 `report.md`。
- 证据留存设计契约：`docs/superpowers/specs/2026-10-09-research-evidence-provenance-design.md`；实施计划：`docs/superpowers/plans/2026-10-09-research-evidence-provenance.md`。计划中的任务和命令是验收要求，不应仅凭计划条目认定已完成。
- 请求观察与事件：`apps/desktop/src/shared/model-request-observation.ts`、`apps/desktop/src/worker/agent/pi-agent-executor.ts`、`packages/capability-sdk/src/model-observation.ts`。
- 证据包及预算：`capabilities/company-research/runtime/company-research-evidence-collector.ts`、`company-research-evidence-packet.ts`、`company-research-context-budget.ts`；纵向验证入口为同目录 `company-research-evidence.integration.test.ts`。
- 原子保存及生命周期：`capabilities/company-research/application/company-research-service.ts`、`packages/persistence/src/company-research-evidence-repository.ts`、`company-research-run-repository.ts` 及对应测试。
- 日期及界面：`packages/retrieval/src/publication-date.ts`、`packages/retrieval/src/providers/doubao.ts`、`tavily.ts`；`capabilities/company-research/ui/ResearchEvidenceDetails.tsx`。
- 当前两轮 Prompt：`capabilities/company-research/runtime/company-research-prompt.ts`、`company-research-structuring-prompt.ts`。

成本仅作为具体运行记录：阿里原完整样例148.4秒、9次模型请求、6次搜索／4次读取、148,942 Tokens；固定输入二轮回归25.2秒、1次模型请求、无搜索／读取、21,985 Tokens。二者工作量不同，不能写成提速或降本对比。
