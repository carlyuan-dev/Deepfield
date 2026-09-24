# Capability 包化第二批实施计划

状态（更新于 2026-09-22）：本批开发、定向验证及独立整体审查完成；后续修复与界面优化经用户手测确认基本稳定，已本地合并 develop → staging → main，稳定标签 `stable-2026-09-22` 指向 `9475b2b`。未推送远端，非正式 1.0 发布。以下实施记录保留当时的验证范围，不追加未经执行的测试结论。

## 本批交付与验收

- 当前唯一安装包：`release/mac-arm64/Deepfield.app`。原独立测试包已迁至该路径；旧稳定包、旧 DMG/ZIP 与重复副本已按用户要求清理。用户数据与独立安装能力包不因清理而删除。
- 已验证：真实生产依赖图不含 A；临时移除全部 Capability 源码仍可构建核心；安装产物可独立加载；禁用、删除包/目录、恢复包后报告 ID/内容不变；两轮调研与 Word 离线流程；隐藏页面草稿保持；退出中断不继续派发队列、不删除报告。
- 最后修复通过真实注册表 + Worker client 退出 + SQLite 回归，31 项覆盖测试通过；类型检查、生产构建与离线打包通过。主协调者另复跑生产边界/产物、批量回归和类型检查。
- 所有任务独立审查及最终整体审查已通过；用户已反馈当前桌面版本基本稳定。开发侧未运行 Electron GUI 或真实付费 API，不将用户整体反馈记作逐项人工测试证据。签名、公证和正式发行不在本批范围。
- 保留的回归手测建议：查看旧报告 → 两轮调研及 Word 导出 → 关闭能力并重启确认入口消失、Chat/设置/用量可用 → 重新启用后旧报告仍在。无需删除真实目录来测试。
- Chat 调用 Capability 的目录/说明/动作工具仍是下一批；旧 SQLite 仓储和迁移作为自足适配暂留宿主，并未宣称完成 Base.Storage/Base.Agent。
- 其他任务原有评测修改保持未提交；测试应用使用当前工作区内容，未私自将这些修改纳入本批提交。

## 实施取舍与代价

按实施顺序记录协调者作出的选择，供后续审阅：

1. 沿用用户指定的 develop 和当前工作区，不另建工作树；仅精确提交本批文件。代价是重叠文件需额外协调与保护。
2. UI SDK 提前定义通信桥类型，后续再实现传输，按真实页面进口确定宿主注入接口。代价是后续适配可能小幅调整。
3. 旧持久层保留冻结的本地业务校验器，而非削弱验证。代价是未来存储抽取前有少量 Schema 重复。
4. UI 桥使用 capabilityId/operation/requestId 信封与包命名空间事件，不缩成 actionId。代价是少量适配代码。
5. 中间提交曾暂留固定 A 激活以保持阶段可运行，后续已清除并验证生产图。代价是必须完成后续移除，不能把中间状态称作可拆卸。
6. 业务恢复在 Worker 确认后执行一次，不在构造时修改数据。代价是显式 ready/recover 生命周期。
7. 激活超时用对应 activation requestId 撤销 Worker 注册，避免误伤替代实例。代价是增加内部控制信封，不提供公开热卸载。
8. 包通过版本化窄宿主服务接口自行组装识别、补全和传输适配。代价是小型绑定接口和后续版本检查。
9. UI 产物声明包内相对 cssPaths，宿主校验同源和扩展名。代价是新增一项 SDK 元数据与校验。
10. 检索结果 Schema 抽成纯入口并保留旧重导出，防止带入 PDF/native 实现。代价是一个共享契约子路径，不复制验证定义。
11. 跨独立 bundle 的 AppError 通过已注册且校验后的元数据归一化，不依赖构造器身份；原始消息/堆栈/原因不公开。代价是一个窄兼容分支。
12. 最终审查在服务级修复后发现生产清理顺序仍有同一队列缺陷，追加一次最小修复及真实退出回归，而非交付已知错误。代价是额外一次定向验证与重打包。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 子 Agent 实现、主 Agent 验收。用户于 2026-09-21 批准持续执行，直至需要用户手测或必要决策。

**Goal:** 把完整公司研究迁入可选包；下次启动禁用或移除该包时，Chat、设置、Usage 正常工作，且不创建公司业务实例。

**Architecture:** 复用第一批 SDK、扫描和装配协调器。宿主保留通用传输、平台文件操作与旧 SQLite 适配；A 拥有业务契约、服务、Agent、页面和 Word 排版。通用入口只认识包和注册项，不再列举公司研究服务。

**Tech Stack:** 沿用 Electron、Vite、React 19、TypeScript、TypeBox、Vitest、现有 Pi 执行器；不添加插件框架或第二套 Agent Loop。

**Spec:** `docs/capabilities/capability.overview.设计文档.md`；第一批验收见 `2026-09-20-capability-packages-phase-1.md`。

**执行状态（2026-09-22）：** Task 1–6 已完成，离线边界验证与用户当前版本手测反馈均已收口，已进入本地稳定检查点。当前安装包见上方交付路径。Chat 能力调用不在本批。

## Global Constraints

- 自有可信预构建包；不做第三方沙箱、热卸载、在线安装更新。
- 单一扫描根为 userData 下 `capabilities/`；启用配置和首次初始化标记放在扫描根之外。删除后不自动恢复。
- 只在 develop 开发；合并与推送需用户授权。2026-09-22 用户已授权并完成本地 main/staging 合并及替换旧包，未授权本次远端推送；不自动启动 Electron。
- 数据库位置、既有表/ID/外键和报告不变。禁用/删除包不删除数据；不实现 Base.Storage 或 Base.Agent。
- Chat 的 Capability 目录/describe/invoke 工具属于第三批，本批不注入模型上下文。
- 每任务只做对应关键功能测试；末尾 typecheck/build、离线业务回归和真实生产依赖图检查，不跑全仓套件或付费 API。
- 发现需求与技术边界不兼容时报告具体问题，不通过关闭 sandbox、webSecurity 或放宽任意脚本来源绕过。

## 开工前并行改动协调

2026-09-21 工作区有其他任务未提交修改：`packages/application/src/capabilities/company-research/company-research-harness.ts`、对应测试、`packages/application/src/index.ts`、根 `package.json`，以及 research-eval/benchmarks 文档与脚本。它们与任务 2、6 重叠。

执行前重新核对所有权及状态。先完成不重叠的加载边界；迁移这些文件前通知原任务暂停重叠编辑并确定包含最新改动的基线。不能覆盖、回退、私自提交其他任务内容，也不能搬走正在写入的文件。无法协调时只暂停重叠任务，明确报告；不把复制旧版文件当作解决办法。

## Review Focus

1. 已初始化用户删除整个扫描目录：下次启动为空，不从安装副本复原（任务 4）。
2. Worker 激活失败或退出：撤销该包 main 注册，不残留可点击导航；Chat 仍可用（任务 3、4）。
3. persistence/preload 的公共总出口偷偷引入业务 schema：物理移除源码及交付目录后仍可构建、启动通用装配（任务 2、6）。
4. React 独立 UI 重复加载 React、CSS 未加载或刷新失去资源：用真实研究页面验证，不以纯 DOM 探针替代（任务 1、5）。
5. 用户更改下次启动配置，当前批量任务正在运行：只更新配置，不取消当前工作；正常退出沿既有中断语义保存状态（任务 4、5）。

## 公共接口与文件分工

新增 SDK `transport.ts`、`host.ts`、`ui.ts`；具体公司字段不能进入 SDK。

```ts
export interface CapabilityCall {
  capabilityId: string;
  operation: string;
  requestId: string;
  input: unknown;
}
export interface CapabilityEvent {
  capabilityId: string;
  topic: string;
  payload: unknown;
}
export interface CapabilityBridge {
  invoke(call: CapabilityCall): Promise<unknown>;
  subscribe(listener: (event: CapabilityEvent) => void): () => void;
}
export interface CapabilityRegistration {
  handle(operation: string, handler: (input: unknown) => Promise<unknown>): () => void;
  emit(topic: string, payload: unknown): void;
}
export interface CapabilityStatus {
  id: string;
  name: string;
  status: 'disabled' | 'loading' | 'ready' | 'incompatible' | 'failed';
  enabledNextStart: boolean;
  errorCode?: string;
}
export interface CapabilityManagementApi {
  list(): Promise<CapabilityStatus[]>;
  setEnabled(id: string, enabled: boolean): Promise<CapabilityStatus[]>;
}
```

此处 `operation` 是受限 UI/Worker 内部传输，不自动成为模型动作。包内输入/输出 Schema 校验保持现有严格度；宿主从可信窗口及注册表决定能力范围，不接受调用者自报已启用/已授权。订阅绑定能力命名空间并可释放，不把 Electron 对象交给包。

目录目标：

```text
capabilities/company-research/
  capability.json
  contracts/                 A 的 schema、模板、业务传输
  application/               当前服务、队列、Harness
  runtime/                   调研、资料补全 Agent 与提示词
  ui/                        当前 industry-research 页面
  export/                    Word 内容与排版
  main.ts / worker.ts / ui.ts 包入口
  host-ports.ts              A 所需的窄适配定义
  build.ts                   独立包构建
apps/desktop/src/main/capabilities/
  installation.ts            首次初始化与标记
  preferences.ts             下次启动启用配置
  runtime.ts                 扫描、快照、装配、退出
  ipc.ts                     管理及通用分发
  resources.ts               受控包资源解析
apps/desktop/src/worker/capabilities/registry.ts
apps/desktop/src/renderer/capabilities/CapabilityHost.tsx
apps/desktop/src/renderer/features/settings/CapabilitiesSettings.tsx
packages/persistence/src/legacy-company-contracts.ts
```

旧数据访问所需最小类型暂留 persistence 内部；运行时 schema、模板、动作协议归 A，不能从 persistence 反向 import A。公共 Markdown、链接复制、Modal 等 UI 可经宿主 UI SDK 注入，不复制业务实现。

## Task 1：真实 React 页面独立加载边界

**Files:** 新增 SDK `ui.ts`、`apps/desktop/src/renderer/capabilities/ui-runtime.ts`、`CapabilityHost.tsx`、主进程 `capabilities/resources.ts`、`tests/capabilities/react-package.test.tsx`；读取现有 `IndustryResearchCapability.tsx` 与公共组件，不先删除旧入口。

**Interfaces:** UI 入口导出组件工厂，接受单一宿主 React/UI runtime；宿主负责挂载。使用现有 React 实例，禁止包捆绑第二份 React。

```ts
export interface CapabilityUiProps {
  bridge: CapabilityBridge;
  onClose(): void;
  onOpenSettings(module: 'llm' | 'search'): void;
}
export interface CapabilityUiModule {
  createView(runtime: CapabilityUiRuntime): React.ComponentType<CapabilityUiProps>;
}
```

`CapabilityUiRuntime` 仅列出实际使用的 React、JSX runtime 和公共组件；`ui-runtime.ts` 负责绑定宿主单例。独立构建把这些依赖变成注入 shim，其他 UI 依赖随包打包；工厂创建前不得求值读取未绑定 runtime。CSS 单独随包交付，按包挂载/卸载，禁止全局覆盖 Chat 样式。

- [x] 写真实现有研究页面离线挂载测试；输入空列表，验证“添加/导入/批量调研”等原交互入口仍在；卸载后无订阅残留。
```ts
expect(screen.getByText('研究主题')).toBeVisible();
unmount();
expect(activeSubscriptions()).toBe(0);
```
- [x] 使用 Vite 独立构建该页面入口，测试加载产物而非源码 alias；React hooks 正常，产物无第二份 React。
- [x] 资源服务只映射本次 ready 包的真实目录与固定 ID，限定 GET、允许扩展名与 MIME；拒绝编码 `../`、绝对路径和包外 symlink。复用第一批真实路径校验，补普通文件检查。
- [x] 离线资源解析测试：合法 JS/CSS 通过，禁用/未知包和越界路径拒绝。开发、打包都使用同一受控资源机制，不依赖 Vite dev server 路径。
- [x] Run `npx vitest run tests/capabilities/react-package.test.tsx apps/desktop/src/main/capabilities/resources.test.ts`；typecheck。若技术验证不成立，停止后续迁移并修订该边界方案。

## Task 2：A 业务包和自足旧存储边界

**Files:** 迁移 application/capabilities/company-research、worker/capabilities/company-research、renderer/features/industry-research 至目标包；迁移 contracts 的 capability-items/research/company-profile/batch-research/company-research-templates/research-retry-policy；迁移 Word document 内容与测试。修改 contracts/application 总出口、persistence 内部类型与 mappers；拆分 `configured-llm-service.ts` 的公司识别与 Chat 标题生成。

**Interfaces:** A `host-ports.ts` 定义仅需的仓储字段、配置解析、模型网关、Worker 请求、诊断、保存文档接口。依照各构造函数实参收敛，禁止注入整个 ApplicationRuntime 或 Repositories；宿主适配保留旧 SQLite 数据访问实现。

- [x] 协调重叠改动后保留最新 Harness 内容与评测调用入口，迁移不修改调研提示词和判断规则。
- [x] 分离 Chat 标题生成和公司识别，通用服务不再实现 CompanyRecognizer。A 包内创建 profile/research/batch/industry 服务；资源一创建即 defer 清理。
- [x] 旧 migration 保持自足；persistence 为遗留行结构保留必要类型，去掉公共总出口对 A schema 的执行式依赖，数据库不迁址。
- [x] 将现有 UI 专用 API 适配成包内 `createCompanyResearchApi(bridge)`，尽量保持页面内部调用形式，避免顺带重写页面。
- [x] 定向验证已有两轮、重试、批量取消和导出代表用例，以及公司唯一身份；旧数据库夹具打开后公司/报告 ID 不变。
```ts
expect(after.companies.map(x => x.id)).toEqual(before.companies.map(x => x.id));
expect(after.reports.map(x => x.id)).toEqual(before.reports.map(x => x.id));
```
- [x] 每次迁移同步改 import/测试定位，运行受影响的测试文件及 typecheck，不删除失败测试来过关。

## Task 3：通用 IPC / Worker 注册与包入口

**Files:** SDK `transport.ts`/`host.ts`；宿主 `main/capabilities/ipc.ts`；修改 `main/ipc.ts`、`preload/index.ts`、contracts/ipc.ts、contracts/worker.ts、main/agent-worker-client.ts、agent-worker-protocol.ts、worker/message-loop.ts、worker/assembly.ts；新增 Worker registry 与 A main/worker 入口。

**Interfaces:** 复用现有 requestId、事件流、取消和终态队列实现，通用信封承载包内业务 payload。注册函数返回解除函数并登记 defer；main/worker 均激活成功才公开 UI 调用。

- [x] 定义上面的 CapabilityCall/Event Schema，沿用可信窗口校验、AppError 与事件订阅清理。预加载只暴露受控 capability bridge 和管理 API，不暴露任意 IPC channel。
- [x] main 的通用注册表按 capabilityId+operation 分发；未知/禁用/未 ready 返回安全不可用错误，包内校验参数与结果。
- [x] Worker 接收主进程可信快照并加载其入口；仅加载时注册 A 请求处理器，迁走 fake research/profile 实现。Chat 与通用工具装配不 import A。
- [x] Worker 激活需应答；失败/超时/退出令 main 回滚该包，释放订阅，不把 ready 留在管理或导航中。Worker 重建只按同一启动快照恢复，不顺带应用新配置。
- [x] 测试空注册表、非法 payload、跨包 topic、main 成功 worker 失败和运行时 worker 退出；验证 Chat handler 仍能响应。
```ts
expect(await registry.call(disabledCall)).toMatchObject({ code: 'capability_unavailable' });
expect(mainCleanup).toHaveBeenCalledTimes(1);
expect(readyIds).toEqual([]);
expect(await sendFakeChat()).toMatchObject({ completed: true });
```
- [x] Run 新增 `capabilities/ipc.test.ts`、Worker `capabilities/registry.test.ts` 及受影响现有 client/message-loop 关键测试；typecheck。

## Task 4：安装、启用快照与真正可选的生产启动

**Files:** 新增 main/capabilities/installation.ts、preferences.ts、runtime.ts 及同名测试；修改 main/index.ts、application-runtime.ts、worker/index.ts、agent-worker-runtime.ts。

**Interfaces:**
```ts
initializeCapabilities({ scanRoot, bundledRoot, statePath }): Promise<void>
readEnabledIds(statePath: string): Promise<readonly string[]>
writeEnabledIds(statePath: string, ids: readonly string[]): Promise<void>
```

输入均由宿主提供，包不决定扫描根。状态 JSON 原子写入，缺失与损坏区分；损坏配置不自动全启用。安装标记含 schemaVersion、initialized，存于扫描根之外。

- [x] 仅首次安装/旧版升级初始化复制随 app 交付的 A 并默认启用；先临时复制完整内容再原子发布，成功后写标记；中断不留下半包为 ready，已存在人工包不覆盖。
- [x] 已 initialized 且扫描根缺失时返回空；不得创建目录/复制副本。未知人工包默认 disabled。
- [x] 主程序先创建纯 Chat/设置/Usage 装配，再扫描/选择/激活包；清除固定 A 初始化与重复 cleanupAbandoned/resume。A 自身负责恢复其业务，禁用不运行恢复逻辑。
- [x] 实现管理 API 的当前状态与 enabledNextStart；setEnabled 不改变当前 registry/队列。
- [x] 测试首次、第二次、删除 A、删除全目录、旧 enabledIds、损坏状态与 Worker 失败；失败不能拖垮通用启动。
```ts
await initializeCapabilities(paths);
await removeOnlyTemporaryScanRoot();
await initializeCapabilities(paths);
expect(await scanCapabilities(paths.scanRoot)).toEqual({ entries: [], issues: [] });
expect(researchFactory).not.toHaveBeenCalled();
```
- [x] 退出通过已注册 dispose 沿用中断语义；禁止按用户取消语义删除已有报告。运行中的批量队列切换启用勾选时应继续运行。
- [x] Run `npx vitest run apps/desktop/src/main/capabilities apps/desktop/src/main/application-runtime.test.ts`；typecheck。

## Task 5：管理界面与动态导航

**Files:** 新增 `CapabilitiesSettings.tsx`、`CapabilityHost.tsx` 测试；修改 SettingsView.tsx、App.tsx、Sidebar.tsx、state/workspace.ts、api.ts；迁出 capability.css 的 A 专属样式。

**Interfaces:** 只消费 CapabilityManagementApi、ready 导航元数据、CapabilityBridge 和 UI runtime。管理页名称“能力”；每项显示当前状态、下次启动勾选；更改后提示“下次启动生效”，不自动重启。

- [x] Sidebar 用 ready 包元数据渲染，不写死 industry-research。将旧 workspace ID 映射为 company-research 的一次性兼容；缺包旧状态回到 Chat，不异常弹窗。
- [x] CapabilityHost 只在打开 ready 包时加载 UI，切换设置保持已有页面状态；退出/装配失败释放 UI 和 CSS。
- [x] 管理页空目录显示空态；不可用包显示安全 code/message，不暴露原始异常或 Key。不把已删除 ID 显示成缺包警报。
- [x] 测试零包导航、禁用下次生效、UI 失败不影响 Chat、设置返回原页面、旧 workspace 状态；确认公司已有按钮与窄窗口布局不被重写。
```ts
expect(screen.queryByText('研究主题')).not.toBeInTheDocument();
await user.click(screen.getByLabelText('下次启动启用公司研究'));
expect(currentReadyIds()).toEqual(previousReadyIds);
expect(screen.getByText('下次启动生效')).toBeVisible();
```
- [x] Run 新增 UI 定向测试与现有 App-settings/Sidebar 相关测试；typecheck。

## Task 6：生产构建、可移除性验收与测试包

**Files:** `capabilities/company-research/build.ts`、electron.vite.config.ts、electron-builder.yml、package.json、tsconfig.base.json、`tests/capabilities/production-boundary.test.ts`、架构文档与本计划。

- [x] 建立独立 A 构建输出 `out/capabilities/company-research/`；electron-builder extraResources 携带初始安装副本。Node 包产物自足或仅使用已定义宿主注入，不从开发目录解析 node_modules。
- [x] 宿主生产构建不得 import A，包括诊断 CLI/总出口/preload 隐式路径；公司诊断代码归包或独立可选构建，不污染主启动图。真实依赖图直接来自生产 Vite 配置，不沿用第一批 synthetic config 作为最终证明。
- [x] 在临时仓库夹具中排除 `capabilities/` 源码，执行主构建并验证无包；独立包构建脚本无源码时正常跳过，不自动恢复。不得删除用户真实包或工作树来测试。
- [x] 隔离数据目录中验证有包/禁用/移除包/移除扫描根，Chat fake 一轮、设置和 Usage 可访问；启用 A 跑离线两轮、重试、批量取消、Word 导出代表流程。（真实产物覆盖两阶段/Word/历史恢复；重试、批量取消沿用 Task 2 已通过的离线回归。）
```ts
expect(hostModuleIds.some(id => id.includes('/capabilities/company-research/'))).toBe(false);
expect(disabledProbe.moduleEvaluations).toBe(0);
expect(disabledProbe.businessInstances).toBe(0);
expect(restoredReport.id).toBe(savedReport.id);
```
- [x] 最终 `npm run typecheck`、`npm run build`、本批关键定向测试；不跑 live API/Electron GUI。
- [x] 生成带本批标识的独立测试包，保留当前稳定 app。给用户手测：启用正常两轮→勾选禁用→重启无研究入口且 Chat 可用→重新启用历史报告仍在。删除目录测试先由离线夹具覆盖；不要求用户拿真实资料冒险。
- [x] 更新文档准确标明已实现/保留耦合/未实现 Chat 调用；独立整体复核后交付，不自动合并推送。

## 自审覆盖与停止条件

协议/基础扫描沿用第一批；React/资源→1；A 归属与旧存储自足→2；IPC/Worker→3；安装与零包启动→4；勾选/导航→5；生产可移除与回归→6。第三批动作说明和 Chat 调用明确不在本批。

任务顺序 1→2→3→4→5→6。只在文件边界明确时并行，不同时修改总出口和装配文件。第一步真实 React 加载不成立或重叠文件无法协调时，不开展破坏性迁移。每一步必须有独立可检查结果，但只有任务 6 完成后才能宣称真实 A 可拆卸。
