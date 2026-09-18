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

## 后续步骤

Worker 按通用执行器、Chat 会话策略和 Capability 适配器归类，先划清接口再抽取大型文件。该步骤在 Task 1 合并后继续细化，不与首次移动混在一个提交。
