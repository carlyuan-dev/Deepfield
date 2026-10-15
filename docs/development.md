# Deepfield 开发指南

Deepfield 是面向财经记者的 Apple Silicon macOS 桌面研究工具。本文维护环境、运行、分支与交付约定；功能契约见[文档阅读地图](README.md)，验证路径见[按风险选测指南](testing.md)。项目 Agent 分工、模型与文字约定统一遵循 [AGENTS.md](../AGENTS.md)。

## 分支与版本管理

三个长期分支按 `develop → staging → main` 流转：

- `develop`：日常开发与修复，只在这里修改代码。
- `staging`：待验收最新版；阶段验证通过后自动从最新 `develop` 合并并推送，功能交付默认打包，交用户体验验收；阻碍另行说明。
- `main`：稳定版；仅在用户验收通过后从 `staging` 合并，不直接开发。

手测问题回到 `develop` 修复，再按同一路径推进。默认不强推、不覆盖已有提交。每次稳定验收添加可追溯标签。仓库默认分支为 `main`，本地日常工作分支为 `develop`；临时 worktree 按任务建立与整理。

版本事实见[发布记录](releases/2026-10-12-v0.1.1.md)。正式版本发布另行确认。

### 阶段自动交付

本阶段范围明确、实际影响路径已有足够验证证据、文档已同步且无本改动相关未解决错误后，自动提交本阶段可交付内容到 `develop`，将最新 `develop` 合并到 `staging`，推送远端两个分支，无需再次询问。按风险与收益选择验证；关键行为无法由现有证据覆盖时，按[测试指南](testing.md)做针对性真实验证。未验证部分如实说明，存在关键证据缺口时不自动晋级；构建通过不代替验收。

提交前确认改动归属，只纳入本阶段内容，保留无关用户改动；已有未完成验收的改动单独保留，不能随约定文档整体提交。合并前核对当前分支及远端差异，采用正常合并、不强推；冲突、权限不足或无法确认提交范围时，停止对应同步并报告。推送后说明提交、分支、验证结果与限制。

`staging` 用于用户体验验收；`main` 不自动更新。关键旅程通过、无已知严重缺陷且迁移／回滚风险可控时，建议用户稳定验收并晋级 `main`。

## 文档同步

功能、验收或交付状态变化时，同步对应正式设计与必要发布记录，区分实现状态、证据范围与剩余限制。文档归属、过程材料存放和维护规则统一见[文档阅读地图](README.md#文档归属与生命周期)。纯文档改动检查内容、链接与 diff，无需打包；满足阶段自动交付条件后按上述授权提交与同步。

## 环境与安装

- macOS（Apple Silicon / arm64）。
- Node.js ≥ 24.17（`package.json` 的 engines 要求），npm 11.x。
- SQLite 使用 Node 内置 `node:sqlite`；凭据由 Electron `safeStorage`（macOS Keychain）保护。

在仓库根目录运行：

```bash
npm install
npm run dev
```

若 Electron 安装缺少 `path.txt` 或 `dist/`，可运行其官方安装脚本恢复：

```bash
node node_modules/electron/install.js
```

优先使用官方 Electron 下载源；使用第三方镜像前须评估其供应链信任。

## 开发与验证命令

```bash
npm run dev          # electron-vite dev
npm run typecheck    # 全仓 TypeScript 检查
npm run test         # 默认 Vitest 单元／集成测试
npm run check        # typecheck + test
npm run build        # 桌面构建 + Capability 构建 → out/
```

无需真实凭据的界面调试：

```bash
DEEPFIELD_AGENT_MODE=fake npm run dev
```

Fake Agent 固定回复“测试回复”，适合验证界面与接线。真实模式在设置页分别配置、保存并启用 LLM / Search Profile；联网功能需要可用的当前 Search Profile。凭据加密保存，页面不回显已保存的 key。配置与连接诊断契约见 [Base.Config](base/base.config.设计文档.md)，用量口径见 [Base.Usage](base/base.usage.设计文档.md)。

默认 Vitest 发现 `apps/`、`packages/`、`capabilities/`、`scripts/`、`tests/` 下的测试，排除 live 与构建输出等目录。真实 Provider / 搜索测试显式使用 `vitest.live.config.ts` 或 `test:providers:live` 等专用脚本，在测试指南的每轮额度内已获费用授权；联网与系统权限仍按实际环境执行。

### Electron E2E

macOS 运行前确认 GUI 权限，并显式启用：

```bash
DEEPFIELD_ALLOW_ELECTRON_E2E=1 npm run test:e2e
```

脚本先构建，再由 Playwright 驱动真实 Electron；配置在 `playwright.config.ts`，串行运行且不重试。启动保护禁止在 macOS Seatbelt sandbox 内运行，不能绕过或反复重试。测试使用 Fake Agent 和独立临时 userData，只清理自身目录。规格与覆盖范围以 `tests/e2e/` 为准；手动补验路径见[测试指南](testing.md)。

## 数据与资源目录

| 环境 | `DEEPFIELD_USER_DATA_DIR` |
| --- | --- |
| 开发（未打包） | 非空时生效，否则用 `app.getPath("userData")` |
| E2E（`DEEPFIELD_E2E=1`，含打包 app） | 非空时生效 |
| 生产（已打包且非 E2E） | 忽略，始终用 `app.getPath("userData")` |

userData 包含 `deepfield.sqlite`、`secrets.json`、`settings.json`、`attachments/` 和宿主管理的 `capability-config/`。普通配置与内部凭据引用存入配置目录，凭据仍由加密 SecretStore 保存；包通过 `config.v1` 访问，禁用／移除包保留配置。详细契约见 [Base.Config](base/base.config.设计文档.md)。

内置 Skill 在开发态从仓库 `skills/` 读取，打包态位于 `Deepfield.app/Contents/Resources/skills/`，由 `electron-builder.yml` 的 `extraResources` 携带。当前包含 `structured-brief`。

## 本地打包（arm64）

每轮功能开发通过必要检查后，直接打包交用户手测；应用仍运行、权限受限等阻碍需说明。打包前确认目标应用已退出。独立安装的 Capability 有更新时同步测试所需能力包并保留可恢复备份；暂存目录须在扫描根目录之外，结束后清理空暂存目录并确认 catalog 无额外条目。保留用户数据库、报告、配置与密钥。

```bash
npm run dist:dir     # build + arm64 app → release/mac-arm64/Deepfield.app
npm run dist:local   # build + arm64 dmg / zip，identity=null
```

配置见 `electron-builder.yml`：appId 为 `com.deepfield.desktop`，启用 asar，安装包命名为 `Deepfield-${version}-${arch}.${ext}`。

若构建成功但下载 Electron 受阻，仅当 `node_modules/electron/dist` 与声明版本、目标 arm64 架构一致时，可复用已安装的 Electron 和当前构建输出：

```bash
node_modules/.bin/electron-builder --mac --arm64 --dir --config.electronDist=node_modules/electron/dist
```

检查产物架构：

```bash
file release/mac-arm64/Deepfield.app/Contents/MacOS/Deepfield
```

预期包含 `Mach-O 64-bit executable arm64`。冒烟通过现有启动保护，使用 Fake Agent、`DEEPFIELD_E2E=1` 与独立 userData，避免触及正在使用的应用数据。

保留本地最新 release 供使用。`release/`、`out/` 与测试输出已忽略；清理前区分可重建输出与独有笔记、快照，后者先保留或归档。清理范围不得包含私人文件、用户文档、应用 userData 或密钥。

## 签名与更新

当前产物为未正式签名的本地构建（`identity: null`，仅 adhoc/linker 签名）。公开分发需完成 Developer ID Application 签名与公证。自动更新尚未实现；手动更新安装保留 userData。
