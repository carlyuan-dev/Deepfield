# Capability 包化第一批实施计划

当前状态（2026-09-22）：第一批已完成，第二批真实公司调研拆包与管理界面也已完成；用户确认当前版本手测基本稳定后，本地 develop → staging → main 已合并至 `9475b2b`，标签为 `stable-2026-09-22`，未推送远端。第三批 Chat 渐进发现与调用尚未实现。下方首次交付的提交与测试记录为历史记录，不代表当前分支状态。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 用户于 2026-09-21 确认执行；按任务实施并独立复核。本计划不授权第二、三批实现。

**Goal:** 建立可信 Capability 包的协议、无执行扫描和可回收加载机制，用独立探针证明 main/worker/ui 分离交付可行，不改变现有公司调研行为。

**Architecture:** 包清单与源码执行严格分开；宿主提供加载接口及启动快照。第一批以隔离测试中的无业务探针验证机制，第二批才把真实 Capability A 接入生产启动，第三批接入 Chat。

**Tech Stack:** 当前 Node、TypeScript、Electron、Vite、TypeBox、Vitest；不新增插件框架，不使用真实 API。

**Spec:** `docs/capabilities/capability.overview.设计文档.md`（已批准）。

## Global Constraints

- Capability 是完全可选的扩展；最终必须允许全部包及扫描目录缺失，主 Agent 正常运行。
- 开发仅在 develop，必要验证后才合并 staging；用户验收后才合并 main。本计划不自动授权合并、推送。
- 只处理自有可信预构建包，不做第三方安全沙箱、热插拔、在线安装更新。
- 单一扫描根，扫描只读 JSON，不执行入口；用户删除后不自动从内置副本恢复。
- 不修改用户数据库、资料、真实包目录；所有探针使用测试临时目录。
- 用户指定最小必要测试；每个任务先红后绿，运行对应测试和 typecheck，首批末尾 build；不跑全仓套件、付费调用或 Electron GUI。
- 不同时抽取 Base.Storage 或 Base.Agent，不复制 Pi Loop。

## 分批交付路线

| 批次 | 独立交付物 | 完成标志 |
| --- | --- | --- |
| 1（本计划） | 包协议、扫描、加载与构建探针 | 隔离测试中证明零包、禁用包和入口失败均不影响宿主；现有产品不变 |
| 2（另写详细计划） | Capability A 完整拆包与管理界面 | main/worker/ui/业务协议与导出迁入包；窄存储适配保留；生产启动零包可用；禁用不实例化、不恢复队列 |
| 3（另写详细计划） | Chat 渐进发现与统一调用 | 目录→说明→调用→任务/报告闭环；上下文复用、版本失效、授权及幂等 |

第二批必须一并拆除 App.tsx、application-runtime.ts、Worker assembly、IPC 和公共总出口的具体 A 依赖，不能只迁文件或隐藏导航。第三批必须先对照锁定版本 Pi 的公开工具接口，复用现有执行机制。第一批通过不等于 Capability A 已可卸载，不提前增加无效管理开关。

## Review Focus

1. 空目录与权限拒绝不同：不存在正常为空，真实扫描错误可见但不抛到主启动（任务 2）。
2. 相同 ID 与越界路径：不能静默覆盖或通过符号链接逃出包目录（任务 2）。
3. 禁用包顶层有副作用：只能读清单，不能执行入口（任务 3）。
4. Worker 初始化失败：已启动的 main 实例必须释放且没有残留 ready 注册（任务 3）。
5. 仅源码动态 import、产物仍静态混入：以构建依赖与入口探针证明分离（任务 4）。

## 文件职责

新增 `packages/capability-sdk/`：`manifest.ts` 清单与动作声明；`lifecycle.ts` 启停及资源清理接口；`index.ts` 公共导出，不导入任何具体 Capability。

新增 `apps/desktop/src/main/capabilities/`：`catalog.ts` 非执行扫描；`loader.ts` 按快照协调装配；`package-paths.ts` 路径约束。第一批生产 index 不调用这些新模块。

新增 `tests/fixtures/capabilities/probe/`：无业务 main/worker/ui 入口、清单和独立构建配置。新增 `tests/capabilities/package-build.test.ts` 验证交付格式。测试清理只针对自身 mkdtemp 目录。

新增测试与实现同名 colocated；SDK 的 package.json/exports、tsconfig 路径及测试别名随任务 1 最小接入，不重排全仓配置。

## Task 1: 固化最小声明及生命周期接口

**Files:** 新建 SDK 文件与 `manifest.test.ts`，按需要修改根 tsconfig/vitest 别名。

**Interfaces:**

```ts
type PackageEntry = "main" | "worker" | "ui";
type Cleanup = () => void | Promise<void>;
interface CapabilityActionDeclaration {
  id: string; description: string;
  mode: "immediate" | "task";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  documentation: { path: string; version: string };
  permissions: string[]; requiresConfirmation: boolean;
}
interface CapabilityManifest {
  id: string; name: string; description: string; version: string;
  protocolVersion: 1; hostApiVersion: 1;
  entries: { main: string; worker: string; ui?: string };
  navigation?: { title: string; order: number; route: string };
  requirements: string[]; actions: CapabilityActionDeclaration[];
}
type ManifestResult =
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; code: "invalid_manifest" | "incompatible" };
// validateManifest(value: unknown): ManifestResult
```

- [x] 写失败测试：合法 probe 清单通过；协议/host 主版本非 1 返回 incompatible；重复动作 ID、绝对路径、远程 `$ref`、未知字段拒绝。
- [x] Run `npx vitest run packages/capability-sdk/src/manifest.test.ts`，确认失败源自未实现验证。
- [x] 用现有 TypeBox 实现 JSON 数据结构验证，路径语法先拒绝绝对路径和 `..`；真实文件边界留任务 2。Schema 子集限定 type/properties/required/items/enum/description/additionalProperties/minimum/maximum/minLength/maxLength/minItems/maxItems，不支持 `$ref`。
- [x] 定义生命周期资源容器：`defer(cleanup: Cleanup): void`、`dispose(): Promise<void>`；逆序清理、dispose 幂等、一个清理失败不阻断其他清理，返回安全诊断而非泄露原异常。
- [x] 测试验证并 typecheck，提交 `feat: define capability package protocol`。

## Task 2: 无执行扫描与不可变启动快照

**Files:** 新建 `catalog.ts`、`package-paths.ts` 和相应测试。

**Interfaces:**

```ts
interface CatalogEntry { root: string; manifest: CapabilityManifest }
interface CatalogIssue { packageName: string; code: string }
interface Catalog { entries: CatalogEntry[]; issues: CatalogIssue[] }
// scanCapabilities(root: string): Promise<Catalog>
// selectCapabilities(catalog: Catalog, enabledIds: readonly string[]): readonly CatalogEntry[]
```

- [x] 写临时目录测试：缺目录得到 `{entries: [], issues: []}`；空目录同样；两目录同 ID 均不选入；单个损坏清单不影响其他合法包；旧 enabledIds 指向不存在 ID 时忽略。
- [x] 权限错误用受控文件系统依赖模拟 EACCES（不依赖测试机器 root 权限），结果 issues 有 `scan_failed`，不抛出启动异常。
- [x] 路径测试覆盖清单超过 256 KiB、入口不存在、`../`、绝对路径、指向包外的符号链接；读取前限制大小，realpath 后确认包含关系，既校验入口也校验说明路径。
- [x] Run `npx vitest run apps/desktop/src/main/capabilities/catalog.test.ts apps/desktop/src/main/capabilities/package-paths.test.ts`，先确认 RED。
- [x] 实现扫描：fs.readdir/readFile/stat/realpath，只处理一级包目录，不 import。返回安全问题码；重复 ID 从有效集合移除。启动快照深拷贝并冻结，选中配置不能改变运行中的快照。
- [x] 运行同组测试及 typecheck，提交 `feat: discover optional capability packages`。

## Task 3: 可回收加载协调器

**Files:** 新建 `loader.ts` 与 `loader.test.ts`，补 SDK lifecycle 定向测试。

**Interfaces:**

```ts
interface ActivationAdapter {
  activateMain(entry: CatalogEntry, defer: (cleanup: Cleanup) => void): Promise<void>;
  activateWorker(entry: CatalogEntry, defer: (cleanup: Cleanup) => void): Promise<void>;
}
interface ActivationResult {
  ready: readonly CatalogEntry[];
  issues: readonly CatalogIssue[];
  dispose(): Promise<void>;
}
// activateCapabilities(selected: readonly CatalogEntry[], adapter: ActivationAdapter): Promise<ActivationResult>
```

- [x] 先测试零包时 adapter 从不调用；disabled 包经 select 后不执行顶层 marker；main 成功而 worker 失败时逆序清理、包不在 ready；下一合法包仍可激活；dispose 两次只释放一次。
- [x] Run `npx vitest run apps/desktop/src/main/capabilities/loader.test.ts packages/capability-sdk/src/lifecycle.test.ts`，确认 RED。
- [x] 实现逐包隔离激活，main/worker 都成功才发布 ready。部分初始化通过 defer 立即登记已获得资源；activate 抛异常时仍清理。包激活失败不终止整个循环。
- [x] 加载器只消费 entry 和 adapter，不获取 ApplicationRuntime、研究服务或密钥。第二批再实现生产 adapter，第一批不接线到主启动。
- [x] 同组测试/typecheck 通过后提交 `feat: add recoverable capability activation`。

## Task 4: 独立构建交付探针与首批验收

**Files:** 新建 `tests/fixtures/capabilities/probe/{capability.json,main.ts,worker.ts,ui.ts,build.ts}`、`tests/capabilities/package-build.test.ts`。

- [x] probe main/worker 导出异步 activate，向测试注入的记录器写入入口名并 defer 清理；ui 导出 mount(root, { label })，仅向容器写入文字并返回 cleanup。探针不声明真实业务动作。
- [x] 写测试独立构建到临时包目录，清单指向 dist 下三个 ESM 入口；扫描不产生 marker，启用后 Node main/worker 入口才产生 marker；ui 在 jsdom 挂载和清理容器正常。
- [x] Run `npx vitest run tests/capabilities/package-build.test.ts`，确认未构建时失败。
- [x] 使用现有 Vite build API 分别构建三入口，main/worker 不隐式依赖开发目录 node_modules；探针只用标准 JS，UI 首批验证 ESM 边界，不假称已证明真实 React 包加载。
- [x] 产物/依赖图检查：宿主 main、worker、renderer 启动依赖不包含 probe 业务入口；删除交付目录后再 scan/select/activate 正常为空。
- [x] 运行新增相关测试、`npm run typecheck`、`npm run build`，不生成新的用户测试包：此批无用户可见功能，避免覆盖稳定包。
- [x] 更新文档说明“基础机制已验证，真实 A 尚未迁移”，提交 `test: verify capability package build boundaries`，独立审查后向用户汇报进入第二批的条件。

## 第二批开工前必须验证的技术问题

- React UI SDK 的共享依赖及受控资源加载必须用真实 CompanyResearch 页面验证；不能拿纯 DOM probe 成功代替。方案不满足时先修订第二批计划，不修改浏览器安全配置绕过。
- persistence 旧迁移必须自足，不 import 已移入包的业务 schema；同时保持现有 SQLite 兼容。
- capability SDK 的 Agent 接口适配到现有独立执行器，不反向依赖 pi-chat-agent 的 Chat 历史。

这些属于第二批明确交付，不作为本批空白实现项。本批设计只建立可验证基础，不宣称完成整份 Spec。

## 自审与交接

覆盖表：协议/版本→任务1；无执行扫描/缺目录/路径→任务2；失败回收/禁用→任务3；构建边界→任务4。真实 A、管理UI、安装标记与存储过渡→第二批；Chat说明、调用、任务幂等及确认→第三批。

执行方式沿用用户要求：子 Agent 开发，主 Agent 规划与验收。各任务完成记录测试证据与提交，未完成不得以整个 Capability 架构已落地交付。

## 2026-09-21 首批交付记录

### 实施范围

- SDK：清单 v1、有限 Schema 声明、协议与版本校验、可幂等回收的资源容器。
- 宿主基础代码：非执行扫描、大小与真实路径边界、重复 ID 排除、不可变启用快照、逐包 main/worker 激活和失败回收。
- 独立探针：临时目录构建 ESM main/worker/ui，通过顶层可观测标记验证扫描及禁用不执行入口；验证启用、逆序清理、DOM 挂载和包目录移除。
- 生产启动尚未接线：未改变现有公司研究流程，未增加管理开关，未实现 Chat 调用，未打包或覆盖稳定 app。

### 复核与取舍

- 资源释放继续返回 `Promise<void>`，安全错误通过 `issues` 读取；并发释放共用完成 Promise。cleanup 不得等待其自身所属容器的释放，避免循环等待；允许不等待地请求释放。
- 扫描保留 canonical root，后续读取与校验使用同一真实路径。
- 除 256 KiB 清单大小限制外，清单嵌套深度限制为 128；验证异常按损坏清单处理，不影响健康包与启动快照。
- 构建探针只证明纯 DOM ESM 边界；宿主图检查使用真实源码入口的独立 Vite 配置，不等同生产包化完成。真实 React 共享依赖、受控资源加载必须在第二批验证。
- 轻微后续改进：入口/说明路径增加普通文件检查；包含关系判定允许合法的 `..foo` 名称；动作 Schema 完整语义校验留统一调用落地时处理。当前首版只消费可信包的 JSON 清单，不承诺任意 JavaScript 对象校验或恶意代码隔离。

### 提交与验证边界

协议 `848c769` / `4163b58`；扫描 `fca765c` / `c83cb4d`；装配 `8ee7f5c`；独立构建 `5728b90` / `1b55608`；深层清单容错 `63f4197`。各任务经历定向测试及独立复核。

最终定向验证：`npx --no-install vitest run packages/capability-sdk/src apps/desktop/src/main/capabilities tests/capabilities/package-build.test.ts`，6 个测试文件、47 项通过；`npm run typecheck` 通过。`npm run build` 通过（main 514、preload 683、renderer 1006 个模块）；随后仅修正未接入生产的清单校验并重跑上述定向测试与 typecheck，没有重复生产构建。

首次交付时，所有验证均离线；未运行全仓测试、真实 Provider 调用或 Electron GUI。工作区并存其他任务的研究评测改动，未纳入本批提交；typecheck/build 是当时工作区的整体检查，不宣称其他任务已经验收。当时本批保留在 develop，未合并、未推送。后续第二批已完成，见[第二批实施计划](2026-09-21-capability-packages-phase-2.md)；当前合并状态见本文顶部。
