# 第二批：源码职责归类实施计划

目标：在独立分支分步整理源码，每步必要测试通过后合并 main，不改变已验收行为。

## 全局约束

- 保留公共包入口、现有业务行为、提示词和持久化格式。
- Base 不依赖 Chat、Capability 或应用层；本批不强行迁移 Agent 到 Base。
- 不删除测试、用户材料、数据或当前安装包，不调用付费服务测试。
- 开发交给子 Agent，主 Agent 复核；仅运行受影响测试、类型检查和必要构建。

## Task 1: Application 按职责分目录

- 将 packages/application/src 下 chat-service、chat-service-helpers、chat-session-context、conversation-service、context-builder 及相关测试移入 chat/。
- 将 industry-research-service、company-* 服务、harness、validation 及相关测试移入 capabilities/company-research/。
- 将 tool-audit 和相关测试移入 tools/。
- 将 application-test-helpers 和 company-profile-test-fixtures 移入 testing/。
- ports.ts、index.ts 保留根目录；更新全部生产代码和测试导入，保持公共导出完全一致。
- 更新 docs/README.md 中源码导航，历史文档不做批量改写。
- 验证：typecheck、Application 测试、Base 架构测试、build；不运行 live 测试。
- 复核只发生移动和路径变化后提交，合并 main；作为第二批首个独立验收步骤。

## Task 2: Worker 按职责分目录

- 根目录保留 index、assembly、host-client、message-loop、message-loop-types、usage-runtime 及其测试和 message-loop-test-helpers：它们负责进程入口、装配、传输与消息生命周期。
- `agent/`：pi-chat-agent、agent-run-control、runtime-system-context、runtime-budget-context、tool-batch-admission 及对应测试、pi-chat-agent-test-helpers。保留已有函数名和执行逻辑；它是执行相关代码的归类，不代表已与 Chat 契约解耦。
- `chat/`：fake-chat-agent、select-chat-agent、pi-message-mapper、pi-session-transcript 及相关测试（包括 pi-session-continuity）。
- `capabilities/company-research/`：全部 company-profile-*、company-research-* 与 profile-diagnostic 及其测试、company-research-test-helpers。
- `tools/`：pi-tool-adapter、tool-runtime、tool-activity 及对应测试。
- 移动时同步更新所有相对导入（包括 main、shared 消费方及 vi.mock 路径），不创建旧路径转发层，不改公开符号、提示词、依赖版本或配置。
- 保持 electron.vite.config.ts 的 worker/index.ts 打包入口不变；更新 docs/README.md 的源码导航与残留耦合说明。
- 验证：先在当前基线执行 Worker 测试留下结果；移动后执行同组测试对比，不借此修复既有失败。执行 typecheck、build、Base 架构测试和 main/agent-worker-client、main/profile-diagnose-runner、main/company-profile-completer、shared/usage-collection 的定向测试。
- 复核重命名差异只包含路径改动，确认无新增失败后独立提交、合并 main。

## 后续边界

大型 pi-chat-agent 文件的函数拆分、Chat 契约中立化与 Base.Agent 抽取另作独立步骤，不混入本次目录移动。
