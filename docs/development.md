# Deepfield 开发指南

Deepfield 是面向财经记者的 Apple Silicon macOS 桌面研究工具。本文维护环境、运行、分支与交付约定；功能契约见[文档阅读地图](README.md)，验证路径见[按风险选测指南](testing.md)。项目 Agent 分工、模型与文字约定统一遵循 [AGENTS.md](../AGENTS.md)。

开发与修复按本次任务进入对应正式契约、实现和现有回归保护；正式入口见[文档阅读地图](README.md)。

## 分支与版本管理

三个长期分支按 `develop → staging → main` 流转：

- `develop`：日常开发与修复，只在这里修改代码。
- `staging`：已提交的待验收最新版；按下述批次提交条件从最新 `develop` 合并并推送。
- `main`：稳定版；仅在用户单独验收并授权晋级后从 `staging` 合并，不直接开发。

手测问题回到 `develop` 修复，再按同一路径推进。默认不强推、不覆盖已有提交。每次稳定验收添加可追溯标签。仓库默认分支为 `main`，本地日常工作分支为 `develop`；临时 worktree 按任务建立与整理。

版本事实见 [0.1.2 发布记录](releases/2026-10-21-v0.1.2.md)。日常打包不要求每次提升正式版本号；正式版本发布另行确认。

### 验收批次与提交

同一验收批次在 `develop` 持续开发与修复，通过必要自验后直接打包交用户手测；每次打包或修复不自动提交、推送。用户确认该批次完成或明确要求提交时，将本批已验证修改整理为一个有意义的提交，再将最新 `develop` 合并到 `staging`，推送远端两个分支。提交前应明确批次范围、同步文档并解决相关阻塞。按风险与收益选择验证；关键行为无法由现有证据覆盖时，按[测试指南](testing.md)做针对性真实验证。未验证部分如实说明，存在关键证据缺口时不晋级；构建通过不代替验收。

提交前确认改动归属，只纳入本批内容，保留无关用户改动；其他未完成验收的改动单独保留，不能随约定文档整体提交。确需本地安全检查点时可临时提交，不自动推送；批次结束时将本批未推送检查点合并整理。已有共享或推送提交须先核对影响分支及其他工作窗口，取得具体整理范围的批准后再处理，不默认改写共享历史。合并前核对当前分支及远端差异，采用正常合并、不强推；冲突、权限不足或无法确认提交范围时，停止对应同步并报告。推送后说明提交、分支、验证结果与限制。

`staging` 用于用户体验验收；`main` 不自动更新。关键旅程通过、无已知严重缺陷且迁移／回滚风险可控时，建议用户单独稳定验收并授权晋级 `main`。

## 文档同步

功能、验收或交付状态变化时，同步对应正式设计与必要发布记录，区分实现状态、证据范围与剩余限制。文档归属、过程材料存放和维护规则统一见[文档阅读地图](README.md#文档归属与生命周期)。纯文档改动检查内容、链接与 diff，无需打包；同样按上述验收批次条件提交与同步。

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

统一启动入口为 [electron-launch.ts](../tests/e2e/electron-launch.ts)：先用 `createElectronUserData()` 新建隔离目录，再由 `launchElectronE2E({ userDataDir })` 启动并等待首窗口。默认 Fake，可显式选 real；打包执行文件通过 `executablePath` 或 `DEEPFIELD_E2E_EXECUTABLE` 指定。必须复制应用时使用 `copyElectronAppForE2E()`。调用者关闭 app 后使用 `cleanupElectronUserData()` 清理；进程退出未确认时保留目录供排查。入口检查包内链接与关键资源，首次失败锁止本轮启动并做有界关闭；诊断只报告实际取得的脱敏证据，helper 独立退出信息可能不可用。

优先复用已验证的启动入口；必须复制 `.app` 时保留相对 symlink（如 `fs.cpSync` 设置 `verbatimSymlinks: true`），启动前只读核对 Framework 资源及目标隔离 userData。首次启动失败即停止重试，先收集 main/helper 的 stderr 与退出状态并定位原因，主 Agent 复核依据后才再次启动；不得仅修改日志或猜改包布局后反复启动。

真实端测复用生产 `safeStorage` 密文时，使用同产品身份的打包 app 与独立 userData，发送前确认凭据可解密且能力 ready；未打包 Electron 的设置视图可读不代表运行时凭据可用。

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
