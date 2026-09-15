# Capability A 调研最小收口实施计划

日期：2026-09-15
对应设计：`docs/superpowers/specs/2026-09-15-agent-chat-capability-boundaries-design.md`

## 目标

修复单公司调研在工具额度耗尽后输出 DSML 工具协议、无法保存原始报告的问题。实现共享的、单向的最终成稿入口，不展开全面架构重构。

## Task 1：用测试锁定收口契约

修改：

- `apps/desktop/src/worker/pi-chat-agent.test.ts`
- 必要时 `apps/desktop/src/worker/pi-chat-agent-test-helpers.ts`

先增加失败测试，覆盖：

1. 自然停止工具调用时进入收口。
2. 达到 agent turn、search 或 fetch 上限时进入同一收口。
3. 收口上下文 `tools` 为空，且底层请求的工具选择为 `none`。
4. 收口 system prompt 不含联网工具开放说明。
5. 收口消息不含本轮 assistant tool call 和 tool result 角色，只包含普通文本证据。
6. 达到上限时立即存在用户级成稿指令，不依赖下一次自然停止。
7. 收口后模型即使再次返回工具意图也不会执行工具。
8. 最终文本继续产生流式 delta，并通过现有 final validation。

运行：

```bash
pnpm --filter @deepfield/desktop test -- pi-chat-agent.test.ts
```

预期：新测试先失败，且失败位置对应当前两条不一致的 synthesis 分支。

## Task 2：实现唯一收口入口

修改：

- `apps/desktop/src/worker/pi-chat-agent.ts`
- 若类型需要，`apps/desktop/src/worker/model-gateway.ts`

实施内容：

1. 在单次 `run` 内增加不可逆的 `enterFinalization(reason)`，原因至少区分 `natural_stop` 与 `budget_exhausted`。
2. 两种触发方式都调用该入口，删除当前只有自然停止才 `followUp(SYNTHESIS_USER_PROMPT)` 的分支差异。
3. 从本轮工具结果构建有边界的普通文本证据：保留来源 URL、摘要/正文、工具失败码和裁剪事实；不保留工具调用协议对象。
4. 构建干净的收口上下文：
   - 使用最终成稿专属 system prompt；
   - 带入原任务和必要的普通文本历史；
   - 注入证据与明确的最终回答要求；
   - `tools: []`；
   - 不拼接 `ONLINE_SYSTEM_PROMPT`。
5. 在 stream adapter 层对无工具收口显式发送 `toolChoice: "none"`（按 Pi SDK 的实际类型/字段实现），避免仅凭空数组推断。
6. 状态进入 `synthesizing` 后不再接受工具执行；任何新的工具意图交给现有 `invalid_final_tool_use`/协议校验处理。
7. 保留现有 emitter，使最终答案依然逐段流式显示。

实现约束：

- 不修改 Search Provider。
- 不改变 Chat/Capability 谁决定联网。
- 不添加隐藏自动重试来掩盖协议泄漏。
- 不把 Capability 业务字段下沉到通用收口逻辑。

## Task 3：Capability A 集成回归

修改：

- `apps/desktop/src/worker/company-research-agent.test.ts`
- 仅在集成确有需要时修改 `apps/desktop/src/worker/company-research-agent.ts`

增加场景：

1. 8 次搜索和 8 次网页读取后达到上限，随后输出合法中文原始报告。
2. 最后一个工具失败时，失败原因进入证据，报告仍能基于已有资料成稿。
3. 最终输出包含工具协议标记时，仍映射为 `protocol_leak`，不会保存污染报告。
4. 合法原始报告继续进入既有结构化阶段并保存。

运行：

```bash
pnpm --filter @deepfield/desktop test -- company-research-agent.test.ts
```

## Task 4：最小回归与人工诊断

运行：

```bash
pnpm --filter @deepfield/desktop test -- pi-chat-agent.test.ts company-research-agent.test.ts pi-chat-agent-lifecycle.test.ts
pnpm --filter @deepfield/desktop typecheck
```

人工检查：

- Chat 非联网：有加载状态，最终文本流式显示。
- Chat 联网：工具活动正常，停止搜索后流式成稿，链接可复制。
- 宇树科技重新调研：活动栏显示搜索/访问过程；达到上限后不再调用工具；原始报告保存并继续结构化。
- 诊断中最终阶段只出现一次，最终请求不再报告 `invalid_final_protocol`。

## Task 5：复核、打包与交付

1. 开发 Agent 提交结构化 YAML 总结：改动、测试、已知限制、提交号。
2. 主 Agent 逐项审查 diff、测试证据及架构边界。
3. 通过后构建 macOS arm64 测试包，更新：

```text
/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app
```

4. 提供只覆盖本轮风险点的手测清单。
