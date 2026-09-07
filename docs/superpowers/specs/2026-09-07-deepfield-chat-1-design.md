# Deepfield Chat-1 设计

日期：2026-09-07

状态：部分有效；手动 Pi Skill 已实现，项目绑定 Chat 设计已被取代

上位设计：`docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`

> 2026-09-08 修正：Conversation 不再拥有 Project 属性，应用默认入口改为独立通用 Chat，页面采用“左侧导航 / Chat / Capability”Shell。相关数据模型、上下文和交互以 `docs/superpowers/specs/2026-09-08-deepfield-agent-first-chat-shell-design.md` 为准。本文件中手动 Pi Skill 的格式、加载和单轮选择设计继续有效。

## 1. 目标

Chat-1 交付一个可以由用户真实体验的通用主 Agent。用户既能进行普通问答、Coding 和办公写作，也能通过输入框旁的按钮发起 DeepSeek 联网搜索，并手动选择一个 Pi Skill 用于本轮消息。用户在这个版本中先判断模型表现、联网效果、Skill 效果、提示词、来源质量和交互体验。

## 2. 用户体验

Chat 输入区增加“联网搜索”按钮：

- 新会话默认关闭；
- 开启状态在当前会话中保持，用户可以随时切换；
- 应用重新启动时按钮恢复为默认关闭；
- 开启后发送的消息必须执行 DeepSeek 内置联网搜索；
- 消息区域展示“正在联网搜索”等清晰状态；
- 回答保持流式显示；
- Provider 返回的来源网址以可点击形式展示，并由系统默认浏览器打开；
- 本轮回答保存在现有项目会话中，重启后仍可查看。

普通模式继续使用相同的Chat界面、项目上下文和消息历史。联网模式是主Agent的一种请求方式，不创建另一套用户可见会话。

Chat 输入区同时提供 Skill 选择器：

- 列出项目内由 Pi 加载成功的 Skill 名称和描述；
- 用户可以为当前消息手动选择一个 Skill；
- 已选 Skill 以可见标签显示；
- 发送后自动取消选择，不影响后续无关消息；
- 普通 Chat、联网搜索与 Skill 可以使用同一套会话历史。

## 3. 请求与运行路径

Renderer 在每次发送消息时附带明确的联网模式字段。Main/Application 保存用户消息并构建现有项目上下文，再把请求交给 Utility Process。

```text
Chat 输入
  → 当前项目与最近消息上下文
  → 可选：按 skillName 解析 Pi Skill 并生成本轮 Skill 调用内容
  → 普通模式：现有 Pi Chat 路径
  → 联网模式：DeepSeek Responses API + 内置 web_search
  → 文本、联网状态和来源事件
  → Chat 展示并持久化最终回答
```

当前 `@earendil-works/pi-ai` 的 DeepSeek Provider 使用 Chat Completions。Chat-1 先用一次受控的真实调用确认 DeepSeek Responses API 返回的搜索事件、文本和来源结构，再决定复用 Pi 的 OpenAI Responses 适配器，或增加一个窄的 DeepSeek Responses Chat 适配器。两条路径都实现同一个 Deepfield `ChatAgent` 接口，因此 Renderer 和 Application 不感知 Provider 细节。

联网按钮关闭时，请求沿用现有 Pi Chat。联网按钮开启时，请求中的工具选择强制为 DeepSeek `web_search`，使按钮行为明确可预测。

## 4. Pi Skill 最小接入

Chat-1 使用 `@earendil-works/pi-agent-core` 正式导出的 `Skill`、`loadSkills` 和 `formatSkillInvocation`：

1. 应用后端从受控的项目 Skill 目录加载标准 `SKILL.md`；
2. Renderer 只获取 Skill 的名称和描述；
3. 发送时只提交 `skillName`，Worker 从已加载清单精确解析；
4. Worker 用 Pi `formatSkillInvocation` 组装 Skill 内容和用户本轮指令，交给现有 Pi Agent 执行；
5. 回传本轮实际使用的 Skill 标识，供界面显示和故障排查。

当前 Pi 0.84.3 的 `AgentHarness.skill()` 仅有公开类型声明，运行时仍返回 `AgentHarness.skill is not implemented yet`。因此 Chat-1 不迁移整套 Chat 到 AgentHarness，但使用 Pi 的真实 Skill 文件格式、加载器和调用格式。未来 Pi 实现完整 Harness Skill 后，可保留同一批 `SKILL.md` 并替换运行层。

第一版随应用提供一个真实测试 Skill，用于人工对比普通回答和 Skill 回答。

## 5. 上下文和记忆

Chat-1 沿用当前 SQLite 会话和最近消息上下文：

- 用户与Assistant消息继续写入同一项目会话；
- 普通模式和联网模式共享历史；
- 重启应用后从SQLite恢复；
- 当前项目行业和范围继续进入System Prompt。

本阶段通过真实对话验证短期记忆是否达到基本可用水平。更长历史、摘要记忆和项目长期记忆将在实际使用暴露需求后设计。

## 6. 来源展示

来源以DeepSeek Responses API实际返回的结构为准。系统保存和展示必要的来源元数据，例如标题、网址和与回答的关联位置；不把模型联网回答视为 Capability A 的已验证证据。

Chat回答中的来源用于用户浏览和公司候选发现。以后从Chat导入公司名单时，导入结果仍进入人工候选确认页面。

如果Provider只返回正文中的网址，第一版可以将合法的HTTP(S)网址转换为可点击链接。真实调用确认存在结构化引用时，优先使用结构化引用。

## 7. 状态与错误

Chat界面至少区分：

- 正在生成；
- 正在联网搜索；
- 已完成；
- 用户取消；
- 联网失败。

联网失败时保留用户消息，显示简洁错误，并允许用户重试。API Key继续由Main中的加密存储读取，Renderer和持久化消息只接收回答、状态和来源信息。

## 8. 有限功能测试

Chat-1 采用小规模功能验收。开发阶段只为请求模式传递、后端路由和联网事件映射保留少量自动测试；真实效果由以下代表性问题人工验证。

### 普通推理

> 我准备研究人形机器人行业，请帮我把研究目标拆成一个简短清单。

### Coding

> 用 TypeScript 写一个函数，把包含中文名和英文名的公司名单去重，并解释思路。

### 办公写作

> 把一段口语化采访记录整理成一封简洁的内部邮件。

### 短期记忆

先告诉Agent：

> 这个项目的重点是人形机器人，公司名单由记者最终确认。

间隔两三轮后询问：

> 我刚才确定的项目重点和名单确认规则是什么？

### 联网搜索

> 查找中国人形机器人行业的重要公司和近两年新起公司，说明入选原因并提供网址。

### 手动 Skill

选择内置测试 Skill 后发送与该 Skill 相符的代表性任务，确认：

- Skill 可以从标准 `SKILL.md` 被 Pi 加载；
- 选择后界面显示 Skill 标签；
- 回答明显遵循 Skill 的处理方法或输出结构；
- 本轮完成后 Skill 选择自动清除；
- 不选 Skill 时仍能正常对话。

功能验收关注：回答能完成、上下文能记住、历史能恢复、联网按钮确实触发搜索、来源可点击、手动 Skill 确实影响本轮回答、失败后可以重试。模型答案质量记录为后续Prompt和Agent优化输入，不在Chat-1设置准确率Benchmark。

自动验证控制为：

- 一组请求模式和路由测试；
- 一组联网事件到UI状态/来源的映射测试；
- 一条 Pi Skill 加载、手动选择和本轮调用的功能路径；
- 一次经用户授权的DeepSeek联网真实Smoke；
- 阶段结束时一次类型检查、构建和Electron启动Smoke。

Bug驱动后续测试：真实体验发现具体问题时，先复现该问题，再添加对应的最小回归测试。

## 9. 验收结果

Chat-1完成时，用户能够在Mac应用中切换普通与联网Chat，手动选择一个 Pi Skill 用于本轮消息，完成上述代表性问题，看到流式回答和可点击来源，并在重启应用后继续查看历史。用户体验结果决定Chat-2的Tool接入设计。
