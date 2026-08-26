# Deepfield 开发文档

Deepfield 是面向财经记者的 Apple Silicon macOS 桌面研究工具。本文档覆盖本阶段（Foundation
Plan P1）的开发、测试、E2E 与本地打包流程。

## 环境要求

- macOS（Apple Silicon / arm64）
- Node.js ≥ 24.17（开发基线 Node 24.18.x），npm 11.x
- 无外部运行时依赖：SQLite 使用 Node 内置 `node:sqlite`，密钥由 Electron `safeStorage`
  （macOS Keychain）保护

## 安装

```bash
npm install
```

### Electron 二进制安装失败的官方恢复

如果 `node_modules/electron` 缺少 `path.txt` 或 `dist/`（报错
“Electron failed to install correctly”），用官方安装脚本恢复，不要更换版本、不要改锁文件：

```bash
node node_modules/electron/install.js
```

验证：

```bash
cat node_modules/electron/path.txt   # 应为 Electron.app/Contents/MacOS/Electron
node_modules/.bin/electron --version # 应为 v43.4.0
```

> 本机 GitHub 直连不通时，可让官方脚本经 npm 配置的 registry 镜像下载：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
> 不使用未批准的第三方镜像。

## 日常开发

```bash
npm run dev          # electron-vite dev（热更新）
npm run typecheck    # tsc --noEmit（全仓）
npm run test         # vitest run（单元/集成，绝不访问网络）
npm run check        # typecheck + test
npm run build        # electron-vite build → out/
```

### Fake Agent 模式

不配置真实 API Key 时，设置 `DEEPFIELD_AGENT_MODE=fake` 让 agent 走内置 fake
（回复固定“测试回复”），便于本地调试与 E2E：

```bash
DEEPFIELD_AGENT_MODE=fake npm run dev
```

真实模式下需要先在设置页保存 DeepSeek API Key（保存在系统 Keychain，页面只显示
“已配置/未配置”，不回显 key）。

## E2E（真实 Electron）

```bash
npm run test:e2e     # 先 build，再 Playwright 驱动真实 Electron（fake agent）
```

- 配置：`playwright.config.ts`（串行 workers=1、retries=0）
- 规格：`tests/e2e/foundation.spec.ts`——首启、设置 key、建项目、流式 Chat、
  优雅退出、同一 userData 重启后项目/密钥/历史仍在、新对话、Chat Rail 收起/展开
- E2E 每次使用全新临时 userData（mkdtemp），结束时只清理自己的目录；
  E2E key 是测试专用假值，生产代码不含该值
- 不访问 DeepSeek/搜索网络

## 数据目录规则

| 环境 | DEEPFIELD_USER_DATA_DIR 是否生效 |
| --- | --- |
| 开发（未打包） | 生效；未设置时用 `app.getPath("userData")` |
| E2E（`DEEPFIELD_E2E=1`，含打包 app） | 生效 |
| 生产（已打包且非 E2E） | 忽略，始终用 `app.getPath("userData")` |

空白 override 视为未设置。数据全部位于 userData 根目录：

- `deepfield.sqlite` —— 项目/对话/消息（SQLite，Node `node:sqlite`）
- `secrets.json` —— 加密的 secrets（内容经 `safeStorage` 加密，对应 macOS Keychain；
  应用从不把 key 写回 UI/日志/错误文案）
- `attachments/` —— 附件目录

## 本地打包（arm64）

```bash
npm run dist:dir     # build + electron-builder --mac --arm64 --dir → release/mac-arm64/Deepfield.app
npm run dist:local   # build + electron-builder --mac dmg zip --arm64（identity=null）
```

- 配置：`electron-builder.yml`（appId `com.deepfield.desktop`、asar、产物
  `Deepfield-${version}-${arch}.${ext}`）
- 产物：`release/Deepfield-0.1.0-arm64.dmg` / `release/Deepfield-0.1.0-arm64.zip`
- `release/`、`out/`、`test-results/`、`playwright-report/` 不入库

打包后自检：`file release/mac-arm64/Deepfield.app/Contents/MacOS/Deepfield` 应报
`Mach-O 64-bit executable arm64`；可用 Playwright `executablePath` 指向
`Deepfield.app/Contents/MacOS/Deepfield` 加 `DEEPFIELD_E2E=1`/fake/隔离 userData 做冒烟。

> GitHub 直连不通时给 electron-builder 加同一镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:dir`

## 签名状态（重要）

本阶段产物是 **unsigned local artifact**（`identity: null`，codesign 仅 adhoc/linker 签名），
**不能作为最终公开分发**。正式交付仍需：

1. Developer ID Application 签名（codesign）
2. 公证（notarization）
3. 自动更新机制（本阶段未实现）

更新安装会保留 userData（数据目录不随 app 更新重建），但**自动更新尚未实现**，不得声称完成。

## Troubleshooting

- **Electron failed to install correctly** → 见上文官方恢复命令。
- **preload 报 module not found: typebox/value** → 重新 `npm run build`；
  preload 构建已强制内联全部依赖（沙箱 preload 无法 require node_modules）。
- **dist 打包 connect ETIMEDOUT 20.205.243.166** → GitHub 不可达，使用
  `ELECTRON_MIRROR` 镜像环境变量重试。
- **DMG 已挂载未卸载** → `hdiutil detach '/Volumes/Deepfield 0.1.0-arm64'`。
- **E2E 失败** → 查看 `test-results/` 下的 error-context；确认网络无关（fake 模式）。
