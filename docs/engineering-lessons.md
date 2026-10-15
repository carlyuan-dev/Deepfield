# 工程经验索引

只收录有复发价值、高影响或难发现的已证实经验，不记录逐次操作或某批测试成绩。先按触发场景选择条目，再读其链接的正式契约；本页不维护第二套接口规则，也不依赖本地忽略的历史材料。

| ID | 触发场景 |
| --- | --- |
| [EL-001](#el-001-electron-启动环境与首次失败) | macOS Electron 启动、端测或首次启动失败 |
| [EL-002](#el-002-app-复制与-framework-资源) | 复制 `.app`、Framework／ICU 资源错误 |
| [EL-003](#el-003-配置快照与身份) | 配置保存、迁移、草稿诊断或运行中切换 Profile |
| [EL-004](#el-004-报告二轮失败与重试) | 报告结构化失败、恢复与联网重试 |
| [EL-005](#el-005-异步导航与人工表单) | Chat／Capability 异步导航、表单锁恢复 |

## EL-001 Electron 启动环境与首次失败

- 触发／根因：macOS Seatbelt 环境下 Electron 启动存在 SIGABRT 风险；仓库启动保护已将该环境列为明确禁止条件，设置 GUI opt-in 也不会解除限制。
- 正确入口：[Electron E2E 规则](development.md#electron-e2e)、[统一 harness](../tests/e2e/electron-launch.ts)及其[启动保护](../tests/e2e/electron-launch-guard.ts)。首次失败收集 stderr 与退出状态、定位并经主 Agent 复核后再启动；无新证据不重复启动。
- 保护／缺口：[保护测试](../tests/electron-launch-guard.test.ts)约束 Seatbelt 拒绝和 GUI opt-in；[harness 测试](../tests/electron-launch.test.ts)保护失败后的有界关闭、退出未确认时保留 userData，以及诊断先脱敏再截断，避免丢失敏感信息上下文后无法可靠脱敏。它们验证启动与清理边界，不证明真实 GUI 可用或解释所有 SIGABRT。

## EL-002 `.app` 复制与 Framework 资源

- 触发／根因：`fs.cpSync` 递归复制 `.app` 时，默认处理可能将相对 symlink 改指原应用，使副本的 Framework 指向原目录，启动资源解析不可靠。已确认的证据是链接被重写及保留链接后恢复启动；不据此推断所有 ICU resource missing 的原因。
- 正确入口：[Electron E2E 规则](development.md#electron-e2e)。复制使用 `verbatimSymlinks: true`，启动前只读核对 Framework 链接、实际资源与隔离 userData；资源错误先查布局及 stderr。
- 保护／缺口：[统一 harness](../tests/e2e/electron-launch.ts)提供 `copyElectronAppForE2E` 保留链接，`validateElectronApp` 检查链接不出 bundle 及 ICU 资源可读；[harness 测试](../tests/electron-launch.test.ts)覆盖这些资源边界。它约束启动前置条件，不证明真实 GUI 启动；不将改日志或猜改包布局视为再次启动的证据。

## EL-003 配置快照与身份

- 触发／根因：配置对象的嵌套引用若在输入、View 与 RuntimeSnapshot 间共享，外部编辑会污染保存状态和 revision 判断。配置内容、持久身份与草稿身份承担不同职责，不能在迁移或诊断中一并重建。
- 正确入口：[Base.Config](base/base.config.设计文档.md)的“现有 LLM／Search 必须保持的行为”“嵌套值隔离”“配置读取时机不变”。执行快照包含凭据，只交可信执行代码；两阶段任务复用启动快照。
- 保护／缺口：[通用配置测试](../packages/base/src/config/config.test.ts)、[ProfileStore 测试](../apps/desktop/src/main/profile-store.test.ts)覆盖嵌套所有权、凭据保留、revision 和迁移身份；[调研服务测试](../capabilities/company-research/application/company-research-service.test.ts)覆盖运行中切换后两阶段仍复用原快照。跨新消费者的接线仍须按影响验证。

## EL-004 报告二轮失败与重试

- 触发／根因：原始调研与结构化是两个持久化阶段；将结构化失败当成全部调研失败会丢失可恢复材料或重复付费联网。重试入口不同，其执行策略也不同。
- 正确入口：[版本、失败重试与删除](capabilities/company-research.设计文档.md#版本失败重试与删除)与[重试策略](../capabilities/company-research/contracts/research-retry-policy.ts)。满足普通结构化重试条件时复用原文与冻结包；输入变化、未成功联网等完整重跑条件沿用正式契约。专门 `retryStructuring` 复用已存原文，仅解析当前 LLM。
- 保护／缺口：[调研服务测试](../capabilities/company-research/application/company-research-service.test.ts)区分普通重跑、两阶段快照和专门结构化重试，并断言专门入口不解析 Search。固定测试证明恢复路由，不证明真实报告质量或 Provider 可用性。

## EL-005 异步导航与人工表单

- 触发／根因：Chat 执行回执和导航异步到达；等待期间用户可能离开页面、编辑表单或由另一写入者替换锁 revision。沿用旧上下文提交会覆盖人工草稿或恢复过期操作。
- 正确入口：[Chat 人机交互](chat/chat.interaction.设计文档.md)中的页面联动、导航 generation 与共同编辑规则；结果导航先确认绑定交互已终结，仍保留其他人工表单的 dirty 保护。
- 保护／缺口：[导航测试](../apps/desktop/src/renderer/App-interaction-navigation.test.tsx)验证后续导航被阻挡时保留旧 dirty 表单；[锁恢复测试](../capabilities/company-research/ui/bound-form-recovery.test.tsx)验证 revision 被替换和无关编辑后不重放旧补丁。新增异步入口仍需验证其上下文接线。

## 维护规则

新条目使用未占用的稳定 ID，写清触发场景、证据支持的根因、正确入口、保护／测试及覆盖缺口；仅凭猜测或单次不明失败先留在对话排查。修复改变结论时更新原条目；重复经验合并并保留旧 ID 指向，失效结论明确淘汰并链接替代项。具体行为契约更新在原正式设计，本索引只保留决策所需经验与入口。条目提及存量测试不表示本轮已运行或通过。
