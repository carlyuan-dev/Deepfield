# Deepfield 开发文档

Deepfield 是面向财经记者的 Apple Silicon macOS 桌面研究工具。本文档覆盖当前 Agent-first
Chat、Capability 壳层、有限功能测试、E2E 与本地打包流程。

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

> **下载源与信任说明**：默认优先官方 Electron 下载源（GitHub releases）。
> 本机 GitHub 直连不可达（443 连接超时）时，本次恢复使用了用户环境已存在并接受的
> **第三方镜像 npmmirror**（`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
> 传给官方 install.js）。该镜像不是官方来源；使用第三方镜像前需自行评估并接受其
> 供应链信任。如有官方源可达的环境，应优先使用官方源。

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
- 规格：`tests/e2e/foundation.spec.ts`——首启直入 Chat、Fake 连接灯、三轮消息顺序、
  Capability 收展/关闭、历史底部定位、优雅退出与同一 userData 重启恢复
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

## 对话（Conversation-first）与 Chat Skill 手动检查

应用打开即进入独立 Agent Chat：无需创建/选择 Project，左侧按
`对话（＋ 新对话 + 最近标题）/ 工作流（行业研究）/ 设置` 组织；直接点“行业研究”
会把 Chat 收为左侧窄条，箭头或会话点击可展开，收展不中断流式回复。

- Skill 目录解析（`apps/desktop/src/main/skill-paths.ts`）：开发态为
  `app.getAppPath()/skills`（仓库根 `skills/`）；打包态为
  `Contents/Resources/skills`（`electron-builder.yml` 的 `extraResources` 会把
  `skills/**` 带入 Resources）。
- 当前内置：`skills/structured-brief/SKILL.md`（Pi 标准 SKILL.md；打包后位于
  `Deepfield.app/Contents/Resources/skills/structured-brief/SKILL.md`）。

手动检查请区分两种模式，并优先确认消息时间线与滚动行为：

- **Fake Agent（`DEEPFIELD_AGENT_MODE=fake`，含打包 app 冒烟）**：只验证 UI 与
  接线主路径，不验证答案或 Skill 指令效果——Fake Agent 固定回复“测试回复”。
  检查项：启动即进入可输入 Chat；品牌旁连接灯为“未连接”；首条消息后其 deterministic
  fallback 标题进入“对话”；连续发送三轮确认 user/assistant 交错；打开历史后位于底部，
  用户上翻时流式回复不强拉；“行业研究”收展、关闭按钮与箭头往返；重启恢复该 Conversation；Skill 下拉能看到 `structured-brief`，
  选择随本次发送传递并发送后清空（界面收到固定“测试回复”，无 Skill 标记因 Fake
  不回传 skillName）。
- **真实 DeepSeek 模式**：用户先在设置页配置真实 Key，确认连接灯变为“已连接”，然后依次人工验证：
  1. 普通问答（如把人形机器人行业研究目标整理成简短清单）；
  2. Coding（如用 TypeScript 写公司名去重函数并解释思路）；
  3. office 写作（粘贴一段粗略笔记，要求简洁内部邮件）；
  4. 短期记忆（给出一条项目规则，隔两条消息后再询问）；
  5. 手动 Skill：选择 `structured-brief` 并粘贴粗略研究笔记，回复应按
     “核心结论 / 关键依据 / 待核实问题”三节组织；
  6. 随后不选 Skill 发一条普通消息，确认三节约束消失。

标题检查：真实模式首条消息应优先显示 DeepSeek 生成的短中文标题；若请求超时、失败或返回空结果，应保留 deterministic fallback，且后续消息不重新生成标题。Fake 模式只验证接线、离线 fallback 和界面状态，不验证答案、标题质量或 Skill 指令效果。

有限功能测试策略：本阶段只运行与当前切片直接相关的聚焦测试、一次 typecheck、一次 E2E/build、一次 arm64 目录打包和一次 Fake 冒烟；不运行全量测试、覆盖率、重复构建或真实 DeepSeek/Web Search/付费 API。

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

> 默认优先官方 Electron 下载源；GitHub 直连不可达时，可给 electron-builder 传同一
> **第三方镜像**（非官方来源，需自行接受供应链信任）：
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
- **dist 打包 connect ETIMEDOUT 20.205.243.166** → GitHub 不可达；默认应优先官方源，
  确需离线恢复时可使用本机环境已接受的第三方镜像（npmmirror，非官方来源，
  供应链信任自负）经 `ELECTRON_MIRROR` 环境变量重试。
- **DMG 已挂载未卸载** → `hdiutil detach '/Volumes/Deepfield 0.1.0-arm64'`。
- **E2E 失败** → 查看 `test-results/` 下的 error-context；确认网络无关（fake 模式）。
