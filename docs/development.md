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
- 规格：`tests/e2e/foundation.spec.ts`——首启直入 Chat、Enter 发送与 Shift+Enter 换行、
  行业创建/列表编辑/批量删除、公司详情与单条/批量删除确认、Fake 识别导入、Capability 关闭，
  以及优雅退出与同一 userData 重启恢复
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

- `deepfield.sqlite` —— Capability 条目、公司关联、对话、消息与 Tool 审计（SQLite，Node `node:sqlite`）
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
  检查项：启动即进入可输入 Chat；Enter 发送且 Shift+Enter 保留换行；“行业研究”列表中创建、
  编辑行业，独立新增至少三家公司，进入公司详情并返回；公司单条删除和批量删除都先取消再确认；
  用 Fake recognizer 识别、编辑并导入 `Deepfield 演示公司`；列表批量删除行业先取消再确认；关闭
  Capability 后 Chat 仍可用，并在同一 userData 重启后恢复 Conversation。Fake 模式不验证
  DeepSeek 返回质量，也不覆盖真实长文本请求。
- **真实 DeepSeek 模式**：用户先在设置页配置真实 Key，确认连接灯变为“已连接”，然后依次人工验证：
  1. 普通问答（如把人形机器人行业研究目标整理成简短清单）；
  2. Coding（如用 TypeScript 写公司名去重函数并解释思路）；
  3. office 写作（粘贴一段粗略笔记，要求简洁内部邮件）；
  4. 短期记忆（给出一条项目规则，隔两条消息后再询问）；
  5. 手动 Skill：选择 `structured-brief` 并粘贴粗略研究笔记，回复应按
     “核心结论 / 关键依据 / 待核实问题”三节组织；
  6. 随后不选 Skill 发一条普通消息，确认三节约束消失。

行业研究的真实 DeepSeek 长文本识别必须由用户手测：分别粘贴超过 4000 code points 的多块
文本，确认界面只显示通用识别状态、失败时保留已成功候选且重试不重复成功请求；再输入超过 48000
code points 的文本，确认在发出任何识别请求前显示长度错误。单次 DeepSeek 识别请求使用 2048 tokens
输出预算和专用 20 秒超时；连接检查与标题生成仍为 7 秒。自动 E2E 只使用 Fake recognizer，
不会调用真实 DeepSeek。

标题检查：真实模式首条消息应优先显示 DeepSeek 生成的短中文标题；若请求超时、失败或返回空结果，应保留 deterministic fallback，且后续消息不重新生成标题。Fake 模式只验证接线、离线 fallback 和界面状态，不验证答案、标题质量或 Skill 指令效果。

### 单家公司调研真人检查

在真实 DeepSeek 模式下，从“行业研究 → 行业 → 公司列表 → 公司详情”执行：

1. 选择两家真实公司，分别使用默认时间范围完成一次调研；记录报告用途、来源选择、完成耗时、可见长度及是否截断。
2. 对其中一家公司重新调研，改用不同时间范围或补充要求；确认新报告成为默认版本，旧报告仍可从“报告版本”切回。
3. 调研进行中展开 Chat 并发送一条普通消息；确认 Chat 正常返回，研究草稿继续流式更新。
4. 调研进行中关闭 Capability，随后重新进入同一公司；确认任务未被取消，真实耗时与内存草稿能够恢复。
5. 检查报告保持纯文本与换行，完整 HTTP/HTTPS 来源可安全打开；界面不显示百分比、内部 Prompt、模型参数或 Worker 信息。
6. 若调研失败或取消，确认本轮草稿消失、既有成功版本不受影响，并可再次启动。

完成两家公司各一次及其中一家重跑后，将一份代表性报告交给目标记者，仅记录其对实用性、信息密度与来源选择的反馈；本检查不直接发布报告，重要结论仍需人工核实。

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
