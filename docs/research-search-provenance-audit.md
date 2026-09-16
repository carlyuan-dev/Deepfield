# 公司调研联网状态审查

审查范围：当前 worktree 源码；未读取真实凭据或数据库，审查阶段未运行测试。下述“建议”是待实施设计，不是既有功能。

## 已确认事实

事实流为 SearchProvider → SearchWebDefinition → ToolRunner → Pi Agent → CompanyResearchWorker → CompanyResearchService → SQLite report。`search-tool.ts:94` 把鉴权等错误转为稳定错误；`runner.ts:268` 校验输出并完成审计后才返回 completed；`pi-tool-adapter.ts:130` 对非 completed 抛错。canonical web_search 的 completed 可以包含零条结果（`search-tool.ts:47`），表示调用成功，不证明报告充分核验。

`pi-chat-agent.ts:580` 可以复用成功或失败，reused 不能直接视为成功。现有 `pi-chat-agent.ts:917` 的 successfulSearches 只统计 admitted、无 isError 且 results 非空的结果，并参与空批次终止（`agent-run-control.ts:148`）；新调用成功状态不能改变它的含义。

Research Worker 只验证最终文本，不要求搜索成功（`company-research-agent.ts:141`）。Service 只保留最新 activity，raw completed 即持久化并进入结构化（`company-research-service.ts:383`）。所以所有搜索失败仍可生成报告，且模型正文中的链接不是实际搜索成功证据。

空凭据在 `profile-store.ts:81` 被拒绝。Service 已转中文配置提示（`company-research-service.ts:94`），但 IPC（`ipc.ts:452`）和 renderer hook（`use-company-research.ts:169`）再次覆盖为通用失败，丢失可行动信息。

重试资格重复存在于 Panel（`CompanyResearchPanel.tsx:81`）、Service（`company-research-service.ts:117`）、Repository（`company-research-run-repository.ts:216`），均只接受 research_failed/structure_failed，completed 无按钮符合目前代码。

并发由 Service starting/active/durable row 共同保留，SQLite 全局唯一 active 索引兜底（`migrations.ts:460`）。Service 校验 requestId/runId/stage，外来和过期事件被忽略（`company-research-service.ts:373`）。raw 落库后才结构化；启动恢复把遗留 active 转失败（`company-research-run-repository.ts:272`）。这些机制应保留。

## 五条建议

1. **P1：持久化真实搜索调用事实。** 添加 searchStatus unknown/none/succeeded，Service 仅从身份和 schema 校验后的 raw web_search completed 且无 errorCode 单调提升 succeeded，及时落库。零结果算调用成功，reused 不算。迁移历史为 unknown；full retry 清零，structure retry 保留。由持久字段驱动报告警告，避免从模型正文或 searchCalls 猜测。验收覆盖失败、零调用、reused、迟到事件、成功后失败、重启、历史迁移。
2. **P1：安全传播配置错误。** 使用有限公共错误码，经 IPC 和 hook 映射到中文操作提示，保留底层异常脱敏边界；不直接透传 provider error.message。
3. **P2：统一重试政策。** 三层都允许 completed+none 完整重跑；structure_failed+none 必须重新搜索。成功报告不可任意覆盖。中期可抽共享纯策略以减少三处漂移。
4. **P2：完善审计关联生命周期。** `company-research-service.ts:254` 通过 model diagnostics 寻找待删 tool trace。推断：若工具已落库而 worker 在 diagnostic 前退出，可能产生无法经此路径删除的工具审计；尚未实际复现。可增加持久 run/attempt 到 trace 关联，明确取消、删除和保留策略。
5. **P2：分清执行成功与证据命中。** 原 successfulSearches 实际指非空证据（`pi-chat-agent.ts:914`）。保留其策略行为，独立命名新调用成功状态；后续可抽批次证据 reducer，避免模型格式化输出、执行状态和业务可信度混用。

## 边界与验证

上述 completed 判断仅适用于 canonical web_search 的现有适配链。任意自定义工具若返回业务失败对象却不 throw，通用 wrapper 仍可缓存 completed（`pi-chat-agent.ts:594`），不能推广为所有工具的业务成功保证。

现有测试源码覆盖失败重试、ownership、全局占用和删除回滚（`company-research-service.test.ts:257`、`:318`、`:331`、`:462`），以及鉴权关闭工具和失败复用（`pi-chat-agent.test.ts:979`、`:1471`）。审查时未执行，不据此宣称测试通过。

## 本轮落实与后续边界

截至本轮实现，建议1已落实：可选合同字段 searchStatus、migration 14 历史 unknown、新建 none、可信 raw 搜索事件即时持久化 succeeded、原始/结构化共用报告顶部提示。建议3的实际政策已落实到 Panel、hook、Service 和 Repository：completed+none 可原地重新调研，structure_failed+none 必须重跑 raw，unknown/succeeded 的未改输入结构重试保留原语义；共享策略抽取仍是后续建议。

建议2本轮通过 renderer 配置预检改善常见空 Key 提示，预检使用公开 hasCredential，具体错误采用有限本地类型；IPC 稳定错误枚举尚未实现，仍是后续可选改进。建议4的持久审计关联和建议5的批次证据 reducer 重构未实施。原 Agent evidence 策略保持不变；“一次搜索调用成功”仍不等于已获得充分证据。

实现阶段新增定向测试验证可信事件、失败/复用/外来事件排除、单调状态、结构保留、原地全量重试、重启恢复和历史迁移。五文件定向测试157项通过；最后补充 UI 成功态和历史 legacy 断言后，受影响的三个文件101项通过，typecheck通过。源文件行号记录的是审查时位置，新增代码后可能移动，可按所述函数定位。
