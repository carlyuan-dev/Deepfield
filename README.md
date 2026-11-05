# Deepfield

可扩展的 Apple Silicon macOS 通用 Agent 桌面应用。Chat 提供对话与工具执行，Capability 以独立包扩展业务功能，Base 提供模型、搜索、工具、存储、用量与执行追踪等公共能力。

当前内置公司调研 Capability，支持研究主题与公司管理、联网调研、报告版本和 Word 导出。设置支持独立的 LLM / Search Profile 和用量信息。开发者可按 [Capability 协议与开发指南](docs/capabilities/capability.开发指南.md)接入自己的业务，并通过 [Base.Trace](docs/base/base.trace.设计文档.md)关联和排查执行过程。

## 从这里开始

- [开发指南](docs/development.md)：环境、运行、配置、聚焦验证与本地打包。
- [文档阅读地图](docs/README.md)：当前职责边界、Base 文档与历史决策的阅读顺序。

日常开发、自验和用户手测在 `develop` 完成，通过验收后合入稳定分支 `main`；正式发布以 `vX.Y.Z` 标签标记，详见[分支与版本管理](docs/development.md#分支与版本管理)。

```bash
npm install
npm run dev
```

需要 macOS arm64、Node.js ≥ 24.17 和 npm 11.x。无真实凭据时可用 `DEEPFIELD_AGENT_MODE=fake npm run dev` 检查界面与接线；真实配置和测试范围见开发指南。

桌面源码位于 `apps/desktop/`，共享模块位于 `packages/`，独立能力包位于 `capabilities/`，内置 Skill 位于 `skills/`。开发约定见 [AGENTS.md](AGENTS.md)。
