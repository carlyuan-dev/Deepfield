# DeepSeek Thinking Toggle 修复与真实调研验证计划

日期：2026-09-16

## 目标

修复 DeepSeek 模型能力 metadata 错误导致 `thinking: disabled` 未发送、最终成稿在 8192 token 内只产生思考而无正文的问题。修复后重新打包，并真实运行一次宇树科技 Capability A 调研。

## Task 1：锁定 Provider 请求契约并修复 Gateway

修改候选：

- `apps/desktop/src/shared/model-gateway.ts`
- 对应 Gateway/配置测试

要求：

1. 先用真实 `PiModelGateway` 和内存 mock fetch 写失败测试，证明当前 DeepSeek 请求缺少 `thinking: { type: "disabled" }` 且输出上限为 8192。
2. 在 ModelGateway/provider capability metadata 层修复，不修改 PiChatAgent、Capability prompt 或 Search Provider。
3. 对受支持 DeepSeek 模型声明可控推理能力与 DeepSeek compat；当前请求策略仍为 off，因此实际请求必须发送 `thinking: disabled`。
4. Chat、Capability raw、`completeText` 共用该行为；非 DeepSeek/OpenAI-compatible Provider 不得收到 DeepSeek 参数。
5. 不单纯提高 maxTokens，不修改预算、报告字段或结构化流程。
6. 用户追加确认后，将默认模型 ID 更新为 `deepseek-flash`，并仅迁移已有 DeepSeek/OpenAI-compatible profile 中精确等于 `deepseek-v4-flash` 的旧值；自定义模型 ID 不变。

验证：Gateway 定向测试、Pi Agent、Capability A、生命周期、service、typecheck、diff-check。

## Task 2：独立审查与重新打包

1. 审查 payload 契约、Provider 隔离和现有 Chat/Capability 回归。
2. 运行定向回归、完整测试（必要时限制 worker 以避免既有并发超时）、typecheck、build。
3. 构建 macOS arm64 directory app，原子更新 `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app`。
4. 验证源/目标 hash、arm64、Info.plist 和 app.asar。

## Task 3：真实宇树科技流程

1. 启动最新测试 app。
2. 找到宇树科技并发起重新调研。
3. 研究方向填写：`最近三个月的人形机器人产品发布、技术进展与量产情况`。
4. 使用当前已保存的 DeepSeek + Tavily 配置，跟踪工具活动、最终成稿、原始报告保存与结构化。
5. 成功则记录报告状态；失败则读取最新脱敏诊断，报告准确失败边界，不连续盲目重试。

## 非目标

- 不新增 Settings 的 Thinking 开关。
- 不扩展到 Qwen 等其他 Provider 的思考能力适配。
- 不重构通用 Agent Runtime。
