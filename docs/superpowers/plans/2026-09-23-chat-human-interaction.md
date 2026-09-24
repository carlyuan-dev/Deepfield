# Chat Human-in-the-loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking. Root 负责规划、逐项复核与交付，子 Agent 负责实现。

**Goal:** Chat 能询问用户、确认操作，并与 Capability 的真实表单双向同步，获得可信回应后继续执行。

**Architecture:** 交互协调器属于 Chat；通用 Pi 执行器只接收中性交接信号。Capability 保留业务草稿、校验和执行，通过可选 SDK 编辑桥接入；无 Capability 时通用询问与工具确认仍工作。

**Tech Stack:** TypeScript、React 19、Electron 43、现有 SQLite persistence、Pi 0.84.3、Vitest。

**Spec:** `docs/chat/chat.interaction.设计文档.md`（已确认）。

## 实施状态（2026-09-23）

任务 1–6 已实现并完成定向联验和独立代码复核，已生成 macOS arm64 手测包；公司调研能力包版本为 2.2.0。实际模型行为及全部表单交互待用户验收，见 [手测清单](../../manual-tests/2026-09-23-chat-human-interaction.md)。下方保留原计划检查项作为设计历史，不以未勾选状态表示重新执行。

验证包含 Pi 交接、可信确认与版本冲突、等待回合历史、恢复队列、真实表单导航、公司字段同步及非公司示例包；未使用真实 API 或用户数据库做自动测试。类型检查、构建及打包通过。打包使用本地同版本 Electron，规避下载代理权限限制；未自动启动应用，未提交/合并/推送。

## Global Constraints

- 每会话一个活动交互；question 与 approval 严格区分；批准仅限本次操作和当前版本。
- 模型不能批准自己；自然语言确认只从真实用户消息进入，不匹配工具结果或历史引用。
- 复用真实表单；不新增 Base.Interaction、不建通用表单生成器。公司调研全部适用表单本次接入，宿主不得存在业务专项适配。
- Pi 复用现有依赖，不升级、不分叉循环；Capability 内部调研不加入 Chat 等待机制。
- 等待不占用悬挂 Promise，不强制总结；正常回答继续流式。
- 保留当前 develop 未提交成果，不重置，不自行 commit/merge/push；执行前记录受影响文件基线。
- 仅必要定向测试、类型检查和构建；不用真实 API、用户数据库或密钥做自动测试。
- 本文是实施计划，不代表功能已完成。实施完成后检查应用已退出再打包，不自动启动 Electron。

## Review Focus

1. 一批内先读、后询问、再写：后续写不得执行，工具历史仍完整（任务 1）。
2. 右侧未同步输入与左侧确认竞争：不得批准旧内容或重复提交（任务 2、4）。
3. “改完再确认”、引用“同意”、问题选项“同意”：均不能成为操作批准（任务 3）。
4. 切会话后回应、执行中重启：归属不能串线，未知写结果不得自动重放（任务 2、3）。
5. 无能力包或旧包无编辑桥：通用交互可用，原调用兼容（任务 3、5）。

## 接口约束与任务顺序

任务 1 与任务 2 可独立实施；任务 3 消费二者。任务 4 先冻结编辑桥，再与任务 5 分文件并行；任务 6 最终复核。共享 contracts、SDK 文件由对应任务单一所有者修改。

下列签名是新增接口约定；若现有类型已能表达同义，优先复用并同步本计划。业务输入使用包内草稿引用，不复制进 Chat 记录。

```ts
interface ExecutionHandoff {
  request(): void;
  isRequested(): boolean;
}
type InteractionStatus = "waiting" | "editing" | "executing" |
  "answered" | "cancelled" | "invalidated" | "submitted" |
  "succeeded" | "failed" | "uncertain";
interface InteractionOwner {
  conversationId: string;
  requestId: string;
  toolCallId: string;
}
interface OperationRef {
  provider: string;
  operationId: string;
  contractVersion: string;
  draftRef?: string;
}
type InteractionPayload =
  | { kind: "question"; question: string;
      options?: { id: string; label: string }[] }
  | { kind: "approval"; summary: string; operation: OperationRef };
type InteractionRecord = InteractionOwner & InteractionPayload & {
  id: string; revision: number; status: InteractionStatus;
};
type InteractionResponse =
  | { kind: "answer"; text: string }
  | { kind: "decision"; decision: "approve" | "cancel" };
interface RespondCommand {
  interactionId: string; expectedRevision: number;
  response: InteractionResponse;
}
```

可信回应来源由主进程各入口添加，不由模型参数或 renderer 自报决定。存储实现另保存创建/更新时间、回应事件与执行回执；以上是最小跨任务契约，不是完整数据库结构。

## Task 1：复用 Pi 的安全交接点

**Files:**
- Create: `apps/desktop/src/worker/agent/execution-handoff.ts`
- Modify: `apps/desktop/src/worker/agent/pi-executor-dependencies.ts`
- Modify: `apps/desktop/src/worker/agent/pi-agent-executor.ts`
- Modify: `packages/capability-sdk/src/execution.ts`
- Test: `apps/desktop/src/worker/agent/pi-interaction-handoff.test.ts`

**Interfaces:** 产出 `createExecutionHandoff(): ExecutionHandoff`；executor options 可选 `handoff?: ExecutionHandoff`；执行事件新增 `{type:"handed_off",requestId:string}`。事件不携带 Chat ID、业务字段或批准状态。

- [ ] 添加假 Pi 流的失败用例：同批 read、等待工具、write；断言 write 未执行，三个调用均有结果，模型请求只有一次。

```ts
expect(writeSpy).not.toHaveBeenCalled();
expect(providerSpy).toHaveBeenCalledTimes(1);
expect(events.at(-1)).toMatchObject({ type: "handed_off" });
expect(toolResults.map(r => r.toolCallId)).toEqual(["read", "ask", "write"]);
```

- [ ] 运行 `npx vitest run apps/desktop/src/worker/agent/pi-interaction-handoff.test.ts`，确认当前实现不能满足交接断言。
- [ ] 实现中性信号；组合原 `beforeToolCall`：一旦交接，只为后续未执行工具返回明确的未执行结果，不计消耗。已开始工具按真实结果结束。

```ts
shouldStopAfterTurn: () => handoff?.isRequested() ?? false
// provider 错误处理后、最终答案校验前：
if (handoff?.isRequested()) {
  emit({ type: "handed_off", requestId: request.requestId });
  return;
}
```

- [ ] 调整事件消费方穷举，使未注入 handoff 的现有执行路径不变；不能用 `abort()` 表示用户等待。
- [ ] 同一测试文件覆盖无 handoff 的普通完成、预算收口、混合批次交接；运行通过后提交差异供 root 复核，不 Git 提交。

## Task 2：Chat 交互状态、版本与可信执行协调器

**Files:**
- Create: `packages/contracts/src/chat-interaction.ts`
- Create: `packages/application/src/chat/interaction/coordinator.ts`
- Create: `packages/application/src/chat/interaction/ports.ts`
- Create: `packages/persistence/src/chat-interaction-repository.ts`
- Modify: `packages/contracts/src/index.ts`、`packages/application/src/index.ts`
- Modify: `packages/persistence/src/migrations.ts`、`repositories.ts`、`types.ts`、`index.ts`
- Test: `packages/application/src/chat/interaction/coordinator.test.ts`
- Test: `packages/persistence/src/chat-interaction-repository.test.ts`

**Interfaces:** `ChatInteractionCoordinator.create(owner,payload)`、`get(id)`、`respond(command,trustedContext)`、`beginEdit(id,revision)`、`recover()`；状态更新返回 `InteractionRecord`。trustedContext 由宿主绑定用户来源及会话。执行端注册 `OperationAdapter`，其 `read(ref)` 返回版本及摘要，`execute(ref,revision,receiptId)` 返回成功/失败/已提交任务回执，`reconcile(receiptId)` 返回已有结果或未知；不把业务执行回调持久化。

- [ ] 在临时数据库写重复回应、过期版本、编辑锁、每会话唯一活动待办的失败用例。

```ts
await Promise.all([coordinator.respond(command, left), coordinator.respond(command, right)]);
expect(executeSpy).toHaveBeenCalledTimes(1);
expect(resumeEvents).toHaveLength(1);
// 旧 revision 或 editing 状态必须拒绝批准，不能调用 execute。
```

- [ ] 运行 `npx vitest run packages/application/src/chat/interaction/coordinator.test.ts packages/persistence/src/chat-interaction-repository.test.ts`。
- [ ] 增量新增下一可用 migration，不改已应用版本。事务内校验 owner/kind/status/revision 并占用执行回执；数据库事务结束后调用业务端，随后持久化真实结果及唯一恢复事件。

```sql
UPDATE chat_interactions SET status = 'executing'
WHERE id = ? AND revision = ? AND status = 'waiting';
-- changes = 1 才能执行；回应事件和占用回执在同一事务写入。
```

- [ ] question 答案只进入 answered；取消释放提供方草稿；删除会话清理关联状态但不删业务成果。恢复事件按 ID 去重，经原会话串行队列处理。
- [ ] 重启时 revalidate 等待批准；executing 先查回执，未知 -> uncertain，不自动重试。记录恢复消费状态，避免重复模型恢复；不声称跨崩溃绝对 exactly-once。
- [ ] 补上述恢复和跨会话测试并运行通过；存储不得包含密钥或短期批准票据。

## Task 3：接通 Chat、工具与 Capability 旧确认入口

**Files:**
- Create: `apps/desktop/src/worker/tools/pi-chat-interaction-tools.ts`
- Create: `packages/application/src/chat/interaction/response-routing.ts`
- Create: `apps/desktop/src/main/chat/interaction-host.ts`
- Modify: `packages/application/src/chat/chat-service.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`、`tool-worker-host.ts`
- Modify: `apps/desktop/src/main/capabilities/chat-host.ts`、`action-confirmations.ts`
- Modify: `apps/desktop/src/worker/assembly.ts`、`host-client.ts`、`agent/pi-chat-agent.ts`
- Modify: `apps/desktop/src/worker/tools/pi-capability-tools.ts`
- Modify: `packages/contracts/src/worker.ts`、`chat.ts`
- Test: `apps/desktop/src/worker/tools/pi-chat-interaction-tools.test.ts`
- Test: `packages/application/src/chat/interaction/response-routing.test.ts`
- Test: `apps/desktop/src/main/chat/interaction-host.test.ts`

**Interfaces:** 模型可用 `request_user_input({question,options?})`，最多六个选项，创建后请求 handoff；`interaction_draft({mode:"read"|"update",expectedRevision?,patch?})` 只处理宿主绑定的当前草稿。模型无批准接口。host 将 Capability 待确认动作转为任务 2 的 OperationAdapter。

- [ ] 添加纯函数 `classifyExplicitDecision(text): "approve" | "cancel" | null` 的失败用例。只允许完整短语与轻量标点归一化，不做包含匹配。

```ts
expect(classifyExplicitDecision("确认无误")).toBe("approve");
for (const text of ["改完再确认", "不同意", "他说‘同意’", "同意，但修改备注"]) {
  expect(classifyExplicitDecision(text)).toBeNull();
}
```

- [ ] 运行三个定向测试文件，确认无 Capability 的提问尚未注册、可信路由尚未具备。
- [ ] 注册 Chat 专用工具与窄 RPC；校验真实 owner、活动请求和允许的操作，不信任模型提供的来源。将 handoff 映射为 awaiting_user，释放当前运行状态但保持可编辑输入。
- [ ] 收到真实用户消息先捕获唯一待办版本：question 按答案处理；approval 仅明确完整短语直达协调器，其余反馈交模型。拒绝不自动重试相同动作。
- [ ] 批准后先直接执行冻结操作，再恢复模型一次；不要求模型重发写调用。沿用原确认网关安全校验，在批准时为最新输入生成短期单次票据；修改后不得复用旧绑定。
- [ ] 保存成对 Pi 工具历史与可信回应事件，必要时接入既有 `worker/chat/pi-session-checkpoints.ts`；后台 accepted 不是 finished，进度不触发额外模型调用。
- [ ] 测试零 Capability、假文件写工具、旧包无编辑桥、会话切换与任务 accepted 各一条关键路径；通过后 root 审查依赖方向。

## Task 4：通用消息卡与可选真实编辑桥

**Files:**
- Create: `apps/desktop/src/renderer/components/ChatInteractionCard.tsx`
- Modify: `apps/desktop/src/renderer/components/Messages.tsx`、`ChatView.tsx`、`CapabilityChatCards.tsx`
- Modify: `apps/desktop/src/renderer/state/chat.ts`、`chat.css`
- Modify: `packages/capability-sdk/src/ui.ts`、`index.ts`
- Modify: `packages/capability-sdk/src/actions.ts`、`interaction.ts`
- Modify: `apps/desktop/src/main/capabilities/registry.ts`、`action-catalog.ts`
- Modify: `apps/desktop/src/renderer/capabilities/CapabilityHost.tsx`、`ui-runtime.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`、`packages/contracts/src/ipc.ts`
- Test: `apps/desktop/src/renderer/components/ChatInteractionCard.test.tsx`
- Test: `apps/desktop/src/renderer/capabilities/interaction-state.test.ts`

**Interfaces:** 可选 `CapabilityUiProps.interactionEditor` 为当前宿主挂载绑定的编辑口，不传任意会话 ID，不暴露票据或 Chat 类型。

先冻结包侧 `CapabilityFormDefinition` 与 `CapabilityFormProvider`，再进行任务 5。目录声明只包含 ID、关联 actionIds、description；具体输入约束/步骤说明按需读取。提供方返回现有 DraftRef/ViewRef，宿主不得 hardcode 业务路由。业务草稿 revision 沿用不透明 string，Chat interaction revision 为 number，宿主保存绑定关系，不直接相互转换。

```ts
interface CapabilityFormDefinition {
  id: string;
  actionIds: readonly string[];
  description: string;
}
interface CapabilityFormSnapshot {
  draft: DraftRef;
  view: ViewRef;
  values: unknown;
  inputSchema: unknown;
  step?: string;
  transitions: readonly { id: string; label: string }[];
  readyToSubmit: boolean;
}
interface CapabilityFormProvider {
  prepare(formId: string, actionId: string, input: unknown): Promise<CapabilityFormSnapshot>;
  read(ref: DraftRef): Promise<CapabilityFormSnapshot>;
  update(ref: DraftRef, patch: unknown): Promise<CapabilityFormSnapshot>;
  transition(ref: DraftRef, transitionId: string): Promise<CapabilityFormSnapshot>;
  validate(ref: DraftRef): Promise<{ valid: boolean; fieldErrors: { path: string; message: string }[] }>;
  release(ref: DraftRef): Promise<void>;
}
```

最终执行仍走绑定 action，不在 form provider 另建提交业务。gateway 在批准时读取、验证并冻结当前草稿的可提交输入，由包内现有输入映射完成；绑定需覆盖 action、草稿版本与对象版本。transition 不允许直接执行最终提交，内部会产生副作用的步骤仍走动作策略。

```ts
interface CapabilityInteractionEditor {
  read(): Promise<{ revision: number; values: unknown; status: string }>;
  beginEdit(expectedRevision: number): Promise<void>;
  update(expectedRevision: number, patch: unknown): Promise<{ revision: number }>;
  respond(expectedRevision: number, decision: "approve" | "cancel"): Promise<void>;
  subscribe(listener: () => void): () => void;
}
```

- [ ] 写 UI 失败测试：question 无预选自动提交；approval 只显示必要确认/取消；卡在原消息后；切会话迟到事件不改变当前会话。
- [ ] 运行 `npx vitest run apps/desktop/src/renderer/components/ChatInteractionCard.test.tsx apps/desktop/src/renderer/capabilities/interaction-state.test.ts`。
- [ ] 实现消息内通用卡，移除旧分析勾选与重复确认显示；既有操作结果入口继续复用。等待隐藏模型转圈，普通回答保持流式。
- [ ] SDK 编辑桥只做代理；宿主严格绑定包及操作。输入事件立即 beginEdit，两边禁用确认；更新完成才恢复确认，点击确认先 flush 未同步字段。
- [ ] 启动注册表按启用包加载表单目录，验证 actionIds 属于本包；describe 按需提供说明/约束。模型的 draft 工具增加受控 transition，右侧表单也用同一转换；确认前检查 readyToSubmit，不能绕过向导步骤。

```ts
await flushPendingEdits();
const latest = await interactionEditor.read();
await interactionEditor.respond(latest.revision, "approve");
```

- [ ] 保留订阅外部版本冲突处理，不能用上述 read 覆盖未同步本地字段；发生冲突保留本地输入并要求核对。测试旧按钮、输入同步失败、双按钮连续点击各一次。

## Task 5：公司调研全部表单统一接入（修订范围）

**Files:**
- Create: `capabilities/company-research/actions/form-bindings.ts`（包内统一注册，不建每表单 Chat adapter）
- Modify: `capabilities/company-research/actions/definitions.ts`、`register.ts`、`business-actions.ts`
- Modify: `capabilities/company-research/ui/ResearchItemModal.tsx`、`IndustryResearchCapability.tsx`
- Modify: `capabilities/company-research/ui/AddCompaniesModal.tsx`、`ImportCompaniesModal.tsx`、`CompanyProfileModal.tsx`、`CompanyIdentityConfirmationModal.tsx`
- Modify: `capabilities/company-research/ui/CompanyResearchModal.tsx`、`BatchCompanyResearchModal.tsx`、`CompanyResearchPanel.tsx`
- Modify: `capabilities/company-research/contracts/api.ts`、`capability.json`
- Test: `capabilities/company-research/actions/form-bindings.test.ts`
- Test: `capabilities/company-research/ui/ResearchItemModal.test.tsx`

**Interfaces:** 包内统一注册已有表单及关联操作，提供 prepare/read/update/validate/release；update 带 expectedRevision。单次/批量调研复用现有草稿，多步骤表单扩展 step 与允许转换。两种入口复用输入模型、校验和业务提交服务，不能复制一套 Chat 专用逻辑。

- [ ] 写失败测试：模型预填名称/备注，用户改名称，模型仅 patch 备注，最终提交保存两者；陈旧版本 patch 不覆盖用户数据。

```ts
expect(finalInput).toMatchObject({ industry: "用户修改的主题", notes: "模型深化后的备注" });
expect(createTopicSpy).toHaveBeenCalledTimes(1);
```

- [ ] 运行 `npx vitest run capabilities/company-research/actions/form-bindings.test.ts capabilities/company-research/ui/ResearchItemModal.test.tsx`。
- [ ] 同一 ResearchItemModal 增加可选关联模式，复用字段和校验；关联时仅调用编辑桥确认，不再直接调用一次 create API。独立手动创建路径保留。
- [ ] 删除 topic-preview 状态与只读页面；自动导航指向真实新建主题表单，遵守当前会话及手动导航保护；旧预览链接显示已失效，不重新创建模拟页。
- [ ] 成功回执同时结束左右状态并进入真实主题；取消释放草稿、不创建主题；绑定旧会话的右侧操作只更新原会话。
- [ ] 按设计 §7.2.2 完成所有表单绑定；按需抽取既有输入控制逻辑供人/模型共用，不新增替代表单。参数化覆盖每项注册可定位已有组件及操作；正文新建主题用例只是先跑通链路。
- [ ] 批量向导共享同一草稿：选择、统一条件、逐条编辑均不提前入队，最终确认才执行；重试沿用用户最新字段；导出选项复用现有弹窗和系统保存入口。
- [ ] 增加普通手动创建、多步骤最终入队、导出选择三条必要回归；更新包版本，缺编辑桥的旧包仍可调用。

## Task 6：必要联验、文档与打包交付

**Files:**
- Modify: `docs/chat/chat.interaction.设计文档.md`
- Modify: `docs/capabilities/capability.protocol.设计文档.md`、`capability.开发指南.md`
- Create: `docs/manual-tests/2026-09-23-chat-human-interaction.md`
- Create: `tests/capabilities/form-protocol.test.ts`（测试内独立登记“便签编辑”能力，不接入生产目录）

- [ ] Root 逐项复核：信任边界、版本占用、无业务反向依赖、完整工具记录、真实表单复用。未达到设计的部分明确保留待实现，不写“全部完成”。
- [ ] 增加不同业务的最小协议包测试：注册便签表单，用相同 registry/gateway/editor bridge 读改交付；不得在宿主添加便签或公司调研判断。验证启用发现、禁用重启不暴露、声明损坏仅影响对应入口。

```ts
expect(discoveredForms.map(form => form.id)).toContain("note-edit");
expect(savedNote).toEqual({ title: "用户标题", body: "模型修改的正文" });
expect(submitSpy).toHaveBeenCalledTimes(1);
```
- [ ] 执行新增测试文件合集和受影响的既有 Capability/Chat 定向测试；执行以下必要构建，不运行全量 live/API 测试。

```sh
npm run typecheck
npm run build
```

- [ ] 手测覆盖询问选择/自由输入、全部表单入口、共同编辑、左右/文字确认、取消、切会话及重启。批量向导只在最终批准时入队，导出保留系统保存对话框。失败说明实际停在哪一步。
- [ ] 更新协议：编辑桥可选、单一业务草稿、版本冲突、无桥降级、可信执行许可，不把主 Agent 的内部 ID 展示给用户。记录实现状态并链接本计划。
- [ ] 检查 Deepfield 已退出，再运行 `npm run dist:dir`。如仍运行先请用户退出，不能杀进程或替换在用程序。
- [ ] 比对 release app 的构建产物与独立能力产物；按既有流程备份用户安装目录下旧能力后更新本次包，权限不足申请授权，不碰用户业务数据；不自动启动。
- [ ] 交付 `/Users/carl/Project/Deepfield/release/mac-arm64/Deepfield.app`、简短手测步骤与真实验证结果。不自行提交或上传 Git。

## 计划自检

- 设计 §4–6：任务 2、3；§7–8：任务 3–5；§9：任务 1、3；§10：任务 2、4；§11–12：任务 5、6。
- 五项 Review Focus 均已分配必要用例；无真实联网测试，无新增无关架构层。
- 全部适用表单接入统一协议；新建主题仅作首个纵向验证，不作为范围收缩。
- 实施方法已确定为子 Agent 开发、root 复核。此计划供审阅；审阅后进入实施，不在规划期间改产品代码。
