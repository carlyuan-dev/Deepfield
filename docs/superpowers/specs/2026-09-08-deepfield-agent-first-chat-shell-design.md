# Deepfield Agent-first Chat 与 Capability Shell 修正规格

日期：2026-09-08

状态：已批准，进入分阶段实施

上位设计：`docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`

本规格修正此前“Chat 必须依附行业项目”的设计。凡既有规格、计划或代码注释把 Conversation 定义为 Project 子对象，或要求用户先创建 Project 才能进入 Chat，均以本规格为准。P1/P2 已实现的 Electron、Pi Agent、Tool Platform、密钥存储和网页检索基础继续保留。

## 1. 修正目标

Deepfield 首先是一个通用主 Agent。应用启动后，用户应立即看到可输入和发送消息的 Chat，不需要创建行业研究、选择条目或进入 Capability。

Capability 是主 Agent 可以启动、用户也可以直接打开的业务功能。Capability 与 Chat 同时存在于一个桌面壳层中，但二者没有从属关系。Chat 可以作为一次 Capability Run 的来源，Conversation 本身不因此获得 Capability 或研究条目属性。

本轮先修正通用 Chat 和页面骨架，再继续 Chat 联网、Tool 调用和 Capability A 的业务开发。

## 2. 核心概念

### 2.1 Conversation

Conversation 只表示一段通用 Agent 对话。所有 Conversation 使用同一种结构，不区分“普通对话”“项目对话”或“行业对话”，也不保存 `projectId`、`capabilityId` 或 `itemId`。

Conversation 保存：

- 标识；
- 标题；
- 是否已有用户消息；
- 创建和最近更新时间；
- 关联消息。

### 2.2 Capability

Capability 表示一种可复用业务能力，例如“行业研究”。它定义自己的页面、步骤、状态、可调用 Tool 和验收规则。左侧“工作流”区域展示 Capability 入口，而不是具体业务数据。

### 2.3 Capability Item

Capability Item 是某个 Capability 内长期维护的一条业务记录。例如：

- “人形机器人”是“行业研究”中的一个 Item；
- “半导体监测”可以是未来“每日信息监测”中的一个 Item。

不同 Capability 可以为 Item 定义不同字段。Deepfield 不再使用含义过宽且容易与对话混淆的全局 Project 概念。

### 2.4 Capability Run

Capability Run 表示一次具体执行。未来的 Run 至少记录 `capabilityId` 和目标 `itemId`；从 Chat 启动时可以额外记录 `sourceConversationId`。直接从工作流入口启动时，`sourceConversationId` 可以为空。

因此长期关系是：

```text
Conversation --可选来源--> Capability Run --> Capability Item
```

Conversation 不直接归属于 Capability Item。

## 3. 信息架构

应用采用左、中、右三个区域：

1. 左侧固定导航；
2. 中间 Chat；
3. 右侧 Capability。

左侧当前只保留两个主要分组：

- 对话：新对话入口和最近对话；
- 工作流：当前可用 Capability，例如“行业研究”。

具体 Capability Item 在对应 Capability 页面内展示，不放入左侧总导航。公司库、资料库等以后在真实需求出现时再增加。

## 4. 页面状态与切换

页面只有三个主要布局状态：

### 4.1 Chat 主视图

- 应用默认状态；
- 没有活动 Capability 时，Chat 占满左侧导航之外的主体区域；
- 首次使用显示空白 Chat；已有记录时恢复最近一次对话。

### 4.2 Chat 与 Capability 并排

- 主 Agent 从当前对话启动 Capability 时进入该状态；
- 中间显示当前 Conversation，右侧显示 Capability；
- Chat 右边缘显示向左箭头，用于收起 Chat。

### 4.3 Capability 主视图

- 用户直接点击左侧工作流时进入该状态；
- 当前 Chat 收缩为紧邻左侧导航的窄条，只显示向右箭头；
- Capability 使用其余主体宽度；
- 点击箭头或左侧任一对话，会展开 Chat，同时保留已打开的 Capability。

收起 Chat 只改变页面布局，不中断流式回复、不销毁 Conversation，也不自动把 Conversation 与 Capability Item 绑定。

Chat 内现有“模式”下拉入口删除。工作流统一由左侧入口或主 Agent 发起。

## 5. 独立 Conversation 数据模型

新的 Conversation 表不再含 `project_id`：

```text
conversations
- id
- title
- has_user_message
- created_at
- updated_at
```

Messages 继续通过 `conversation_id` 关联 Conversation。

第一条用户消息写入时，先以清理空白后的消息开头生成 deterministic fallback；随后由 Main 中可注入的 DeepSeek 标题服务异步生成一次轻量中文标题。标题请求失败、超时、为空或处于 Fake 模式时保留 fallback。最近对话只展示已有用户消息的 Conversation，并按 `updated_at` 倒序排列；标题回写只更新 title，不二次刷新排序时间。

启动行为：

- 存在最近对话时，打开最近一条；
- 没有最近对话时，创建或复用一个空白草稿；
- 用户在空白草稿上重复点击“新对话”不产生无意义空记录；
- 当前对话已有消息时，点击“新对话”创建新的空白上下文。

## 6. Chat 请求与上下文

Chat API 以 `conversationId` 为主键，不再接收 `projectId`。Application 根据 Conversation 读取最近消息并构建通用主 Agent 上下文。

普通 System Prompt 只描述 Deepfield 主 Agent 的通用角色和当前可用能力，不自动注入行业、研究范围或 Capability Item 内容。需要业务资料时，Agent 应通过明确的 Capability 或 Tool 获取。

现有能力继续作用于 Conversation：

- 流式回复；
- 消息持久化和重启恢复；
- 手动 Pi Skill；
- 后续 DeepSeek 联网按钮；
- 后续 Tool 调用。

如果 Agent 在 Chat 中启动 Capability，Shell 把当前 `conversationId` 作为来源交给 Capability Run；该关联不反向写回 Conversation 属性。

## 7. Capability Item 过渡边界

当前代码中的 `Project` 是早期“行业研究条目”原型，不再作为通用架构概念，也不再参与 Chat 路由、Chat 上下文或左侧对话导航。

本轮优先修复 Chat，不同时完成 Capability A 的完整数据重构。现有行业研究原型在可见文案中使用“研究条目”，内部 `Project` 类型和存储在正式开发 Capability A 的下一切片中替换为 `CapabilityItem`。在替换完成前，不允许新的通用功能依赖旧 `Project` 接口。

用户已确认当前本地数据全部为测试数据，无需保留。此次 Conversation 结构切换可以清理旧的项目关联对话和消息；从新结构投入实际使用后，后续数据库变更恢复无损迁移要求。

## 8. 错误与降级

- Conversation 列表加载失败时，Chat 显示可重试错误，不自动进入 Capability；
- 创建空白 Conversation 失败时，保留 Chat 页面并给出简洁错误；
- 消息发送失败时保留用户输入或提供可重试状态；
- Capability 页面失败不影响当前 Chat；
- Chat 收起或展开不改变正在进行的请求；
- Skill 列表加载失败仍允许普通 Chat。
- DeepSeek 连接检查只返回 connected/disconnected；Key 缺失、网络失败、超时、认证失败或模型不可用均显示 disconnected，不向 Renderer 暴露 Key、响应体或底层错误。
- Fake Agent 模式禁用 DeepSeek 网络请求，连接灯显示 disconnected，首条标题使用 deterministic fallback。

错误信息不得包含 API Key、完整 Skill 内容或内部文件路径。

## 9. 本轮实施范围

本轮按以下顺序交付：

1. 独立 Conversation 的持久化、上下文和 Chat API；
2. 默认 Chat、新对话和最近对话列表；
3. 三区域 Shell、Chat 收展和工作流入口；
4. 一次 macOS 打包功能检查，随后交给用户测试普通问答、Coding、办公写作、短期记忆和手动 Skill。

本轮不继续实现 Capability A 的公司整理、Research Agent、原子事实验证、报告生成或增量调研，也不实现 DeepSeek 联网按钮。

## 10. 有限功能测试

继续采用已经批准的有限功能测试策略：

- 持久化/Application 只覆盖一条独立 Conversation 主路径；
- Renderer 只覆盖启动进入 Chat、新对话、切换历史对话和三种布局状态；
- 只有发现具体 Bug 时才增加对应回归测试；
- 阶段结束时运行一次类型检查、构建、Electron E2E 和打包 Smoke；
- 不以边界矩阵、覆盖率或测试数量作为本轮验收目标。

本轮 UI 与行为收口继续采用有限功能测试策略：后端只用注入 fake fetch 覆盖连接成功/失败、标题规范化、Fake 禁用和输入限界；Renderer 主路径覆盖连接灯、首条标题回写、三轮消息顺序、历史滚动、Capability 收展/关闭及 Skill 单次选择。Fake/E2E/打包冒烟不访问真实 DeepSeek、网页搜索或付费 API。

## 11. 验收标准

本轮完成时：

1. 用户打开应用即可输入并发送普通 Chat，不需要创建研究条目；
2. 左侧可以创建和切换独立对话，重启后恢复最近对话；
3. Conversation 不含 Project 或 Capability 属性；
4. 左侧“工作流”可以打开行业研究区域；
5. 直接打开工作流会收起 Chat，箭头和对话入口可以重新展开 Chat；
6. Chat 收展不打断正在生成的回复；
7. 普通问答、Coding、办公写作、短期记忆和手动 Skill 可以进入真人测试。

## 12. 阶段一至三落地约定

- Capability 打开时壳层使用稳定分栏：Chat expanded 为 520px，Capability 使用剩余空间且至少保留 420px；Chat collapsed 为 38px 加 Capability；无 Capability 时 Chat 占满主体区域。桌面窗口最小宽度为 1240px。
- Capability 由通用 Shell 管理。右上角关闭按钮执行 `CLOSE_CAPABILITY`，清空 activeCapability 并展开 Chat；关闭行为不写入 Industry Research 组件，也不绑定 Conversation 与研究条目。
- Chat reducer 在 completed 或 failed 终态到达时，都把 Assistant 结果固化到对应用户消息之后，清理 draft/order/request 映射，同时保留失败态与重试提示；迟到事件被丢弃。
- 打开或切换 Conversation 后滚动到最后一条；流式更新仅在用户此前接近底部时跟随，用户主动上翻后不强拉。左侧历史按钮使用稳定矩形选中态和 `aria-current="page"`，`＋ 新对话` 是普通动作按钮。
- 品牌旁连接灯初始为 checking 灰色，成功为绿色，失败或 Fake 模式为红色，并提供中文 aria-label/title。设置页保存新 Key 成功后复用同一检查流程。
- 首条消息启动主 Agent 后并行等待轻量标题生成；标题成功回写 Conversation，失败或 Fake 模式使用 deterministic fallback；后续消息不重复生成标题。
