# Deepfield

面向财经记者的 Apple Silicon macOS 桌面研究工具，提供通用 Agent Chat、研究主题与公司管理、两阶段公司调研、报告版本与 Word 导出。设置支持独立的 LLM / Search Profile 和用量信息。

## 从这里开始

- [开发指南](docs/development.md)：环境、运行、配置、聚焦验证与本地打包。
- [文档阅读地图](docs/README.md)：当前职责边界、Base 文档与历史决策的阅读顺序。

日常开发在 `develop`，经 `staging` 验收后进入稳定分支 `main`，详见[分支与版本管理](docs/development.md#分支与版本管理)。

```bash
npm install
npm run dev
```

需要 macOS arm64、Node.js ≥ 24.17 和 npm 11.x。无真实凭据时可用 `DEEPFIELD_AGENT_MODE=fake npm run dev` 检查界面与接线；真实配置和测试范围见开发指南。

桌面源码位于 `apps/desktop/`，共享模块位于 `packages/`，独立能力包位于 `capabilities/`，内置 Skill 位于 `skills/`。开发约定见 [AGENTS.md](AGENTS.md)。
