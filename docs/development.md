# Deepfield 开发文档

Deepfield 是面向财经记者的 Apple Silicon macOS 桌面研究工具。本文档覆盖当前 Agent-first
Chat、Capability 壳层、有限功能测试、E2E 与本地打包流程。

当前阅读顺序与历史文档定位见[文档阅读地图](README.md)。本机正式工作目录为
`/Users/carl/Project/Deepfield`，日常开发使用 `develop`；worktree 是临时隔离目录，完成验证并合并后整理，不把历史 worktree 名称写成固定开发入口。

## 分支与版本管理

三个长期分支按 `develop → staging → main` 流转：

- `develop`：日常开发与修复，只在这里修改代码。
- `staging`：待验收最新版；从 `develop` 合并并完成必要测试后打包，交用户手测。
- `main`：稳定版；仅在用户验收通过后从 `staging` 合并，不直接开发。

手测发现问题回到 `develop` 修复，再按同一路径推进。默认不强推、不覆盖已有提交。
每次稳定验收添加可追溯标签；`stable-2026-09-19` 为三分支建立时的验收基线，
不是正式 1.0 发布。正式版本发布另行确认。仓库默认分支保持 `main`，本地工作分支为 `develop`。

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

真实模式在设置页分别配置 LLM 与 Search Profile。LLM 支持 OpenAI-compatible Chat
Completions 和 Anthropic Messages，可配置 Provider、Base URL、Model ID、Context Window
及凭据；保存与“设为当前”是两个操作。联网功能还需可用的当前 Search Profile。
凭据经 `safeStorage` 加密保存，页面不回显已保存的 key。可先诊断草稿连接，再保存、启用。

“用量信息”展示 Base Usage 采集的 LLM / Search 调用，按 LLM Provider → 模型及
Search Provider 汇总；用量账本不等同于任务额度、业务进度或 Tool 审计。详见
[Base Usage](base/base.usage.设计文档.md)。

## E2E（真实 Electron）

```bash
npm run test:e2e     # 先 build，再 Playwright 驱动真实 Electron（fake agent）
```

macOS E2E 需先确认 GUI 权限，并显式设置 `DEEPFIELD_ALLOW_ELECTRON_E2E=1`；
现有启动保护禁止在 macOS Seatbelt sandbox 内运行，不应绕过或反复重试。

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
- **真实 LLM 模式**：在设置页保存并启用 LLM Profile，确认连接诊断通过；需要联网时另行启用 Search Profile，然后依次人工验证：
  1. 普通问答（如把人形机器人行业研究目标整理成简短清单）；
  2. Coding（如用 TypeScript 写公司名去重函数并解释思路）；
  3. office 写作（粘贴一段粗略笔记，要求简洁内部邮件）；
  4. 短期记忆（给出一条项目规则，隔两条消息后再询问）；
  5. 手动 Skill：选择 `structured-brief` 并粘贴粗略研究笔记，回复应按
     “核心结论 / 关键依据 / 待核实问题”三节组织；
  6. 随后不选 Skill 发一条普通消息，确认三节约束消失。

行业研究的真实 LLM 长文本识别由用户手测：分别粘贴超过 4000 code points 的多块
文本，确认界面只显示通用识别状态、失败时保留已成功候选且重试不重复成功请求；再输入超过 48000
code points 的文本，确认在发出任何识别请求前显示长度错误。单次识别请求使用 2048 tokens
输出预算和专用 20 秒超时；连接检查与标题生成仍为 7 秒。自动 E2E 只使用 Fake recognizer，
不会调用真实 LLM。

标题检查：真实模式首条消息应优先显示当前 LLM 生成的短中文标题；若请求超时、失败或返回空结果，应保留 deterministic fallback，且后续消息不重新生成标题。Fake 模式只验证接线、离线 fallback 和界面状态，不验证答案、标题质量或 Skill 指令效果。

### 单家公司调研真人检查

在真实 LLM / Search 配置下，从“行业研究 → 行业 → 公司列表 → 公司详情”执行：

1. 选择两家真实公司，分别使用默认时间范围完成一次调研；记录报告用途、来源选择、完成耗时、可见长度及是否截断。
2. 对其中一家公司重新调研，改用不同时间范围或补充要求；确认新报告成为默认版本，旧报告仍可从“报告版本”切回。
3. 调研进行中展开 Chat 并发送一条普通消息；确认 Chat 正常返回，研究草稿继续流式更新。
4. 调研进行中关闭 Capability，随后重新进入同一公司；确认任务未被取消，真实耗时与内存草稿能够恢复。
5. 检查原始报告以 Markdown 展示，结构化报告可切换查看，HTTP/HTTPS 来源可安全打开；Word 导出可选择已有的原始报告、结构化报告或两者。界面不显示内部 Prompt、模型参数或 Worker 信息。
6. 调研分为原始调研与结构化整理两阶段。失败记录保留在版本列表并可在当前记录上重试：原始调研失败重新调研；结构化失败且输入未变化时只重试整理，保留原始报告；输入变化时重新调研。
7. 取消新启动的调研会移除本轮未完成记录，既有成功版本不受影响；取消与失败保留的语义不同。
8. 在公司列表选择多家公司发起批量调研，检查逐家公司执行、进度、失败反馈和取消行为；已完成公司的结果保留，并可进入详情查看报告。

完成两家公司各一次及其中一家重跑后，将一份代表性报告交给目标记者，仅记录其对实用性、信息密度与来源选择的反馈；本检查不直接发布报告，重要结论仍需人工核实。

有限功能测试策略：每个小改动只运行直接相关的聚焦测试和必要的 typecheck；文档改动检查链接与 diff 即可。只有涉及桌面集成或交付时才追加 E2E、build、arm64 打包或 Fake 冒烟，不把整套构建作为每个改动的必选步骤，不重复运行已通过的无关验证。

默认 Vitest 仅发现 `apps/`、`packages/`、`scripts/`、`tests/` 下的测试，排除 live、临时 worktree、scratch 和输出目录。真实 Provider / 搜索测试必须显式选择 `vitest.live.config.ts`（或 `test:providers:live` 等专用脚本），并获得相应联网与费用授权；默认测试不调用真实 API。

## 本地打包（arm64）

默认交付约定：每轮功能开发完成并通过必要检查后，直接打包交给用户手测，无需再次询问是否打包。仅在应用仍运行、权限受限或其他明确阻碍时说明原因。打包前确认目标应用已退出；独立安装的 Capability 有更新时，同步更新测试所需能力包并保留可恢复备份，不改动用户数据库、报告、配置和密钥。Capability 更新的暂存目录必须位于扫描根目录之外，成功或失败后都清理空暂存目录，并确认 Capability catalog 没有因暂存产生额外条目。无需为打包扩大无关测试范围。

```bash
npm run dist:dir     # build + electron-builder --mac --arm64 --dir → release/mac-arm64/Deepfield.app
npm run dist:local   # build + electron-builder --mac dmg zip --arm64（identity=null）
```

- 配置：`electron-builder.yml`（appId `com.deepfield.desktop`、asar、产物
  `Deepfield-${version}-${arch}.${ext}`）
- 产物：`release/Deepfield-0.1.0-arm64.dmg` / `release/Deepfield-0.1.0-arm64.zip`
- `release/`、`out/`、`test-results/`、`playwright-report/` 不入库

保留本地最新 release 供使用。`out/`、已确认的缓存、`.pnpm-store/` 和测试输出可重建且已忽略。`.superpowers/` 是已忽略的本地过程材料，可能含独有笔记和快照；只有其中已确认的构建子目录可按可重建输出处理，清理前须先保留或归档独有材料。仓库卫生整理不删除用户私人文件、用户文档、应用 userData 或密钥。

打包后自检：`file release/mac-arm64/Deepfield.app/Contents/MacOS/Deepfield` 应报
`Mach-O 64-bit executable arm64`。开发和测试通过项目脚本及现有 E2E 启动保护运行，
冒烟使用 fake 与独立 userData，避免直接启动 Electron 二进制触及正在使用的应用数据。

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
