# Chat–Capability 交互闭环实施计划

> For agentic workers: use superpowers:subagent-driven-development. 用户已批准持续实施至打包手测；控制器负责计划、复核，开发由子 Agent 完成。

**Goal:** 修复页面与执行脱节、重复结果、来源引用失败，并增加有界的本次任务确认策略。

**Architecture:** Capability 拥有业务页面、表单、主体识别与来源；Chat 拥有通用交互和授权。使用既有 Pi Loop、Action、ViewRef、DraftRef，不做模拟页面，不在 Chat 写公司业务分支。

**Tech Stack:** Electron、React、TypeScript、SQLite、Pi 0.84.3。

**交付状态（2026-09-23）：** Task 1–4 开发、定向测试、独立复核与打包已完成，待用户按手测文档验收。删除补充复用原 ConfirmModal；任务确认最终统一为批准已展示的完整精确清单（按钮、普通确认和本次任务确认范围一致）。测试与产物证据见 `.superpowers/sdd/2026-09-23-interaction-followthrough/progress.md`。未提交、合并或推送。

**Spec:** `docs/chat/chat.interaction.设计文档.md`、`docs/capabilities/capability.protocol.设计文档.md`，以及本计划的已批准补充约束。

## Global Constraints

- 保留 develop 现有全部未提交工作，不切走丢失未提交实现，不自动提交、合并、推送。
- 仅必要的定向功能测试、typecheck、build；不触发真实付费请求，不修改用户公司数据。
- 无 Capability 或无新可选声明的旧包仍可运行。业务路由与主体字段不进入 Chat 通用层。
- 表单继续复用原组件，右侧局部遮罩，不阻塞 Chat；人工未保存输入、切换会话及主动导航保护继续有效。
- 模型不得自行授予批准；任务授权仅来自真实用户入口，不能跨会话、重启或新任务继承。
- 打包交付至 release/mac-arm64/Deepfield.app；安装的 Capability 必须同步版本后手测，不自动启动运行中应用。

## Review Focus

1. 删除等无表单动作也有业务页面上下文；缺失可选导航声明不阻断调用。
2. 执行结果到达时不会被已完成表单 dirty 状态挡住，也不会拉回用户主动离开的页面。
3. 去重不隐藏失败、后台进度、历史入口；取消不执行。
4. 来源编号只解析本轮真实证据；不能把猜测 URL、摘要升级成已读网页。
5. 自动授权有界且可撤销，拒绝/提问答案/引用文本不能授予授权，删除与额外付费研究不会由添加公司授权放行。

## Task 1: 页面联动与交互展示闭环

**Files:** `apps/desktop/src/main/capabilities/chat-host.ts`、`apps/desktop/src/main/chat/interaction-host.ts`、renderer 的 App/ChatView/Messages/ChatInteractionCard/CapabilityChatCards、`capabilities/company-research/ui/IndustryResearchCapability.tsx`、`CompanyFormView.tsx`、`capability.css`、actions/forms 与必要 SDK 可选声明。

- [ ] 添加失败回归：新建主题从表单到新列表/详情；无草稿删除打开首页；公司操作打开正确主题；完成卡只有一个结果入口。
- [ ] 包内为动作声明/计算业务上下文，打开表单前先导航。通用主程序只消费 ViewRef，不知道公司字段。
- [ ] 完成后接回结果导航与刷新，处理已完成表单的 dirty 释放及当前会话/导航 generation。
- [ ] 局部右侧遮罩，Chat 保持可点击和可输入；用户直接使用同一表单不退化。
- [ ] 合并同一交互的确认及结果卡，等待/运行/完成沿用一条记录；问题选项框及悬停态、紧凑答案回执。
- [ ] 定向测试并报告 changed files、风险和测试证据。更新协议可选导航/展示说明。

## Task 2: 公司补全证据及主体

**Files:** `capabilities/company-research/runtime/company-profile-agent.ts`、`company-profile-prompt.ts`、相关 contracts、application completer 与定向测试。

- [ ] 回归月之暗面带括号 URL 和文心搜索摘要/打开页类型差异。
- [ ] 本轮证据赋稳定 ID，模型选择 ID，程序恢复原 URL/kind；保留业务落盘结构和真实证据规则。不用模糊 URL 匹配绕过验证。
- [ ] 引用错误给予最多一次基于已有证据的修正，和格式修正共享预算，不重新搜索、不追加事实。
- [ ] 明确品牌/产品线与公司主体，资料按已核实公司主体填写，品牌意图保留；不要求凭空补齐法定名称或总部，不混用集团/子公司资料。
- [ ] 确认研究主题仍进入提示词；失败提示区分来源核验与接口失败。更新设计和定向测试。

## Task 3: 本次任务范围授权及表达

实施收敛（2026-09-23）：采用有限的精确 ActionCall 清单，不采用宽泛的动作类别授权。所有输入和操作契约在真实用户批准之前冻结并可见；有界多步操作只能消耗清单内未执行项。已知四家公司可直接准备一次 companies.add，不必再次识别。缺少可执行提案的历史文字建议不能直接授予未来未知调用权限，应先准备清单并请用户明确确认一次。模型不获得批准入口，未知识别结果也不自动扩大清单。

**Files:** `packages/application/src/chat/interaction/`、chat-service、main/chat interaction-host、contracts/SDK 必要可选元数据、worker/chat prompts、公司 actions 声明。

- [ ] 为真实用户明确授权建立任务范围：原始任务链、精确操作及输入清单，禁止永久授权。清单准备只生成待办、不执行。
- [ ] 以通用协议声明可授权动作及作用范围；未声明的包仍单次确认。只在用户明确“本次一路确认/不用逐个确认”时启用；输入含否定、引用、条件不推断授权。
- [ ] 只承接本次已明确的工作；新增删除/研究等范围必须确认。任务结束、取消、新任务、重启撤销。表单编辑竞争仍走现有同版本批准入口。
- [ ] 需要参数选择仍正常提问，不把选项答案当批准；无需模型调用批准工具。
- [ ] 中文直接面向用户，不声称必须点击按钮；问题短、选项短，不擅自扩大地域/业务范围。
- [ ] 必要授权正反例和已有确认回归，更新 Chat/Capability 设计及开发指南。

## Task 4: 复核与交付

- [ ] 控制器逐项核对，独立 Agent 审查改动，不重复跑同一测试；重要问题回交开发修复。
- [ ] 全局 typecheck、定向集成测试、生产 build；不跑无关全量/API 测试。
- [ ] 本地 Electron 打包，核验 app/Capability 产物与实际加载位置；运行中则不覆盖正在加载的包。
- [ ] 更新本轮手测文档，按页面导航→双入口编辑确认→自动授权→公司补全顺序交用户验收。
