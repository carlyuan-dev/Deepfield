# 公司资料失败诊断（2026-09-16）

## 本轮边界

只增加安全观测和单次隔离复现入口。首次真实复现前没有修改资料提示词、JSON 提取方式、证据 gate、3 search + 2 read 额度、通用 Agent loop 或自动重试策略。历史三个失败仅凭旧数据库仍不能断言具体根因。

## 实现

- `packages/contracts/src/company-profile.ts`：严格的 diagnostic DTO，关联 requestId/companyId，固定 phase/code、最多 20 个白名单字段路径/expected/actual type、来源与工具调用计数、Pi 固定错误码及已有 model diagnostic 安全计数/stop reason。
- `apps/desktop/src/worker/profile-diagnostic.ts`：屏蔽未知字段名；不复制校验器 message、值或错误对象。
- `apps/desktop/src/worker/company-profile-agent.ts`：原失败门槛附加 json_parse/schema_invalid/source_missing/kind_mismatch/empty_field/identity 等原因，终态前发一次摘要。不保存完整模型回答、来源 URL、页面内容、提示词或凭据。
- `apps/desktop/src/worker/message-loop.ts`：diagnostic 非终态，不提前释放任务。
- `apps/desktop/src/main/company-profile-completer.ts`、`application-runtime.ts`：接收并持久化摘要；内部错误保留 requestId/companyId/worker failureCode，公开 AppError 展示不扩散细节。
- `packages/persistence/src/{migrations,types,repositories,index,company-profile-diagnostic-repository}.ts`：migration 16 增加独立诊断表，requestId 唯一，company 外键级联删除，写入/读取都验证严格 schema。
- `apps/desktop/src/main/profile-diagnose-{runner,cli}.ts`、`electron.vite.config.ts`：正式 profile Agent + tool registry 的单次 stdin harness，no-op audit，不打开生产数据库、不写回公司、不重试。stdout 只发验证后安全诊断与 terminal 摘要。

## 隔离复现调用

开发诊断入口为 `DEEPFIELD_PROFILE_DIAGNOSE_LIVE=1 node out/main/profile-diagnose-cli.js`。stdin 输入完整 `CompanyProfileWorkerRequest` JSON（凭据仅通过合法受控内存管道，禁止 argv/临时明文文件/日志，也不建议用户手工粘贴 key）。原凭据桥方案已停止采用并移除：其入口/身份问题均发生于 API 调用前。真实验证改由主任务在正常 Deepfield 应用内执行，本实施任务未执行真实请求或启动 Electron。

stdout 为 NDJSON：`company-profile.event` 的 `type=diagnostic`，随后 `profile-diagnose.terminal`（requestId/companyId/status，失败时仅固定 code）。退出码 0 成功、2 受控资料失败、1 输入或 harness 失败。stderr 在 1 时仅固定 `profile_diagnose_harness_failed`。成功资料字段也不打印。

## 验证与已知限制

- `npm run typecheck` 通过。
- 最新诊断回归 9 files / 79 tests 通过：profile agent/完整 mock registry run/安全字段摘要、main completer 实际 worker transport、isolated runner、SQLite 诊断仓库与 migration、message loop、worker client。覆盖成功检索后的 JSON 解析失败、fieldEvidence item 类型失败，以及 Pi invalid_final_language 保留具体码。
- `npm run build` 通过，CLI 产物已交主任务。
- 原 model diagnostic 的 fetchCalls 在 mocked registry 完成读取后可能为 0，因此另记本次实际 wrapper 的 searchToolCalls/readToolCalls；来源计数另算成功非空结果，不混淆调用与证据。
- schema union 的错误摘要可能停留在父路径 anyOf（如 identity）；仍无原始值。诊断是可观测性，不证明字段语义真实，也不替代来源 gate。
- schema 安全摘要为诊断依据，不包含失败回答原文；旧历史苹果/荣耀/OPPO 三次失败缺少该摘要，不能逐一断言同因。

## 授权诊断包

隔离凭据桥先遇到 Electron 入口问题，随后遇到开发 Electron 与生产应用的 safeStorage 身份差异；主任务确认尚未发起真实 API。为保持原提示词复现，改由主任务正常应用内重试。

本实施任务按新授权仅生成独立目录包，不安装、不启动应用、不触碰进程：

`CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac --arm64 --dir --config.mac.identity=null --config.electronDist=/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/node_modules/electron/dist --config.directories.output=/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/release/profile-diagnosis-package-20260916-LQoJeU`

打包通过。产物 `/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/release/profile-diagnosis-package-20260916-LQoJeU/mac-arm64/Deepfield.app`；`Contents/Resources/app.asar` SHA-256 为 `b779da7d6b8109811e364a3ea17f0e51da4ffda30bd9bd9100f69d770460ef6f`。主任务负责可恢复备份、安装和真实重试；首次复现原 prompt/gate 保持不变。

## 正式应用真实复现与最小修复

主任务安装诊断包并通过正常应用重试苹果，trace `7cf8846d-f60f-4a8a-8386-ec964f9c3d35` 确证 `phase=schema/code=schema_invalid`：`/fields/stockListings/0` 和多个 `/fieldEvidence/<field>/<index>` 都是 `expected=object/actual=string`。2 次成功搜索、18 个来源、0 次读取、输出 1531 字符、用时约 17.1 秒。此证据明确本次模型输出与严格 schema 不匹配，而不是无检索或凭据预检失败。

仅将原提示词移到 `apps/desktop/src/worker/company-profile-prompt.ts` 并补足完整合法示例/类型说明：股票必须 `{exchange,ticker}` 对象数组；identity.sources 和全部 fieldEvidence 项必须 `{url,kind}` 对象数组；明确引用真实工具返回 URL，不能复制格式示例。matched 示例覆盖所有字段，另外列出不含 matchedName 的 ambiguous/unresolved 形状。未放宽或归一化 evidence gate，未添加整次重试、第二套搜索、模型回答猜测转换。

新增 `company-profile-prompt.test.ts` 的 2 个测试直接用现有 schema 验证输出示例及全部字段来源形状；定向 typecheck 与 4 files / 20 tests 通过。此前新增诊断回归 9 files / 79 tests 通过。

独立只读 review PASS；主任务另跑 typecheck 和 prompt/run/agent 3 files / 19 tests 通过。修复版 build 与同参数本地 Electron 目录打包通过，输出目录 `/Users/carl/Project/Deepfield/.worktrees/chat-markdown-rendering/release/profile-prompt-fix-package-20260916-0VICBd/mac-arm64/Deepfield.app`，app.asar SHA-256 `cc6149ef1f55231d4a0f32e1e6a394bd6fd2aa66f4e2ec11ddbcbf4403fd04fb`。主任务已正常安装到 `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app` 并核对相同 hash。本实施任务仅打包，安装/备份/真实运行由主任务执行。

## 最终真实验收（主任务执行并提供证据）

在修复版正常应用中分别点击三家公司重试，数据库先呈现苹果 enriching、荣耀/OPPO pending，确认串行队列；随后三家均为 ready，诊断均为 ok，资料及来源已落库。

| 公司 / requestId | 搜索 / 读取调用次数 | 有效摘要 / 已打开来源 | 用时 | 保存引用来源 |
| --- | --- | --- | --- | --- |
| 苹果 `aa2898a8-efa9-4710-ae34-69bf75ba7f2a` | 2 / 1 | 18 / 0 | 25.7 秒 | 8 |
| 荣耀 `3c0cb1f9-d0c7-422f-8395-60bc37ab5f10` | 2 / 2 | 20 / 2 | 15.54 秒 | 7 |
| OPPO `d2f3225e-28e6-40cd-b1fc-a1160f82e63c` | 2 / 1 | 18 / 1 | 19.195 秒 | 4 |

调用次数包含尝试，不等同于成功取得内容。苹果的读取尝试没有形成有效 opened_page，但搜索摘要可提供合法证据；官网未知时正确省略，没有为填满表单凑字段。主任务在正式 UI 展开苹果资料和来源，确认 Nasdaq:AAPL 及其他已保存字段、来源展示，完成验收。

本轮确证并修复的是输出提示词未清晰描述对象数组导致的 schema 不匹配。三家公司修复后的真实调用均通过现有严格 gate；不将这一结果扩展为对旧三条失败记录的逐一根因证明，也不宣称来源存在校验能完全证明事实语义。
