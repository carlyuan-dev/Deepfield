# Deepfield

面向财经记者的 Apple Silicon macOS 桌面研究工具，提供通用 Agent Chat、行业与公司管理、两阶段公司调研、报告版本与 Word 导出。设置支持独立的 LLM / Search Profile 和用量信息。

## 从这里开始

- [开发指南](docs/development.md)：环境、运行、配置、聚焦验证与本地打包。
- [文档阅读地图](docs/README.md)：当前职责边界、Base 文档与历史决策的阅读顺序。

本机正式工作目录为 `/Users/carl/Project/Deepfield`，`main` 是当前主线。Worktree 仅用于临时隔离开发，不以某个历史 worktree 名称作为长期入口。

```bash
npm install
npm run dev
```

需要 macOS arm64、Node.js ≥ 24.17 和 npm 11.x。无真实凭据时可用 `DEEPFIELD_AGENT_MODE=fake npm run dev` 检查界面与接线；真实配置和测试范围见开发指南。

源码位于 `apps/desktop/` 与 `packages/`，内置 Skill 位于 `skills/`。本地最新 release 保留供使用；已确认的缓存与构建输出可重建且不入库。`.superpowers/` 是已忽略的本地过程材料，可能含独有笔记和快照，整理前须先保留或归档。仓库整理不删除私人文件、用户文档或应用 userData。
