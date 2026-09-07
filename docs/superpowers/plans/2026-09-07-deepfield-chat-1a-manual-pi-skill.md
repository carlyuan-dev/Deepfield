# Deepfield Chat-1A Manual Pi Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有可用 Chat 上接入 Pi 标准 Skill 加载与手动单次调用，让用户可以在 macOS 应用中对比普通回答和 Skill 回答。

**Architecture:** 保留 Electron + React 本地优先架构。Main 和 Utility Process 共用一个轻量 `PiSkillCatalog`：Main 只向 Renderer 暴露名称和描述，Utility Process 按 `skillName` 解析完整 Skill，并用 Pi 官方 `formatSkillInvocation` 生成本轮 Agent 输入。已选 Skill 只作用于当前一次发送。

**Tech Stack:** Electron 43.4.0, React 19, TypeScript, TypeBox, `@earendil-works/pi-agent-core` 0.84.3, Vitest, electron-builder.

**Specs:**

- `docs/superpowers/specs/2026-09-07-deepfield-chat-1-design.md`
- `docs/superpowers/specs/2026-09-07-deepfield-iterative-mvp-design.md`

## Global Constraints

- 当前交付平台保持 Apple Silicon macOS Electron；Windows 是后续增量打包工作。
- Skill 必须使用 Pi 标准 `SKILL.md`、`loadSkills` 和 `formatSkillInvocation`。
- Pi 0.84.3 的 `AgentHarness.skill()` 运行时未实现，本计划沿用现有 Pi `Agent`。
- Renderer 只接收 Skill 名称和描述；完整 Skill 内容留在后端运行边界。
- 发送请求只携带 `skillName`，Utility Process 必须从已加载目录精确解析。
- 已选 Skill 在本轮发送后清除；不改变后续普通对话。
- 现有 SQLite 消息、SecretStore、Utility Process 和 Tool Platform 边界继续使用。
- 每个任务只保留支撑主路径的少量测试；阶段结束时运行一次 typecheck、build 和 Electron Smoke。
- 本计划在用户完成 Chat + Skill 人工验收后结束；DeepSeek 联网搜索由 Chat-1B 单独规划。

---

## File Structure

### New files

- `apps/desktop/src/shared/pi-skill-catalog.ts` — 使用 Pi 加载 Skill，提供摘要列表和精确调用。
- `apps/desktop/src/shared/pi-skill-catalog.test.ts` — 一条标准 Skill 加载与调用主路径测试。
- `apps/desktop/src/main/skill-paths.ts` — 解析开发和打包后的 Skill 目录。
- `packages/contracts/src/skills.ts` — 跨进程共用的 Skill 摘要契约。
- `skills/structured-brief/SKILL.md` — 首个可人工验证的内置 Pi Skill。
- `apps/desktop/src/renderer/components/SkillPicker.tsx` — 手动 Skill 选择器。

### Existing files to modify

- `packages/contracts/src/chat.ts` — Chat 请求选项和 Worker Skill 标识。
- `packages/contracts/src/ipc.ts` — Skill 摘要与 Desktop API。
- `packages/contracts/src/index.ts` — 导出 Skill 契约。
- `electron-builder.yml` — 将 `skills/` 放入打包资源。
- `apps/desktop/src/main/index.ts` — 确定 Skill 路径，启动 Main Skill Catalog，把路径传给 Utility Process。
- `apps/desktop/src/main/ipc.ts` — `skills.list` 和带选项的 `chat.send`。
- `apps/desktop/src/preload/preload-api.ts` — 受控 Skill 列表 API 和 Chat 选项。
- `packages/application/src/chat-service.ts` — 保存原始用户消息，将 `skillName` 传入 Worker 请求。
- `packages/application/src/ports.ts` — 对齐 Chat 请求签名。
- `apps/desktop/src/worker/index.ts` — 读取 Main 传入的 Skill 目录。
- `apps/desktop/src/worker/assembly.ts` — 把延迟加载的 Skill Catalog 注入 Pi Chat Agent。
- `apps/desktop/src/worker/pi-chat-agent.ts` — 解析 Skill、格式化本轮 Prompt、回传实际 Skill 标识。
- `apps/desktop/src/renderer/components/Composer.tsx` — 放置 SkillPicker 和已选标签。
- `apps/desktop/src/renderer/components/ChatView.tsx` — 加载 Skill 摘要并管理单次选择。
- `apps/desktop/src/renderer/components/Messages.tsx` — 在本轮 Assistant 消息上显示 Skill 标签。
- `apps/desktop/src/renderer/state/chat.ts` — 保留流式回答对应的 Skill 名。
- `apps/desktop/src/renderer/state/use-chat.ts` — 将单次 Chat 选项传到 Desktop API。
- `apps/desktop/src/renderer/chat.css` — Skill 选择器和标签的最小样式。

---

### Task 1: Pi Skill Catalog and packaged test skill

**Files:**

- Create: `apps/desktop/src/shared/pi-skill-catalog.ts`
- Create: `apps/desktop/src/shared/pi-skill-catalog.test.ts`
- Create: `apps/desktop/src/main/skill-paths.ts`
- Create: `packages/contracts/src/skills.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `skills/structured-brief/SKILL.md`
- Modify: `electron-builder.yml`

**Interfaces:**

- Consumes: Pi `NodeExecutionEnv`, `loadSkills`, `formatSkillInvocation`, `Skill`.
- Produces:

```ts
export const SkillSummarySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
}, { additionalProperties: false });
export type SkillSummary = Static<typeof SkillSummarySchema>;

export interface PiSkillCatalog {
  list(): SkillSummary[];
  formatInvocation(name: string, instructions: string): string;
}

export class SkillNotFoundError extends Error {}

export async function loadPiSkillCatalog(skillsDir: string): Promise<{
  catalog: PiSkillCatalog;
  diagnostics: string[];
}>;

export function resolveSkillsDir(input: {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}): string;
```

- [ ] **Step 1: Add one focused failing catalog test**

Define and export `SkillSummarySchema` from contracts first. Use a temporary directory containing one valid `structured-brief/SKILL.md`. Assert that `list()` returns only `{name, description}`, `formatInvocation()` contains the Pi `<skill ...>` block plus the user instruction, and an unknown name throws `SkillNotFoundError`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm test -- apps/desktop/src/shared/pi-skill-catalog.test.ts
```

Expected: failure because `pi-skill-catalog.ts` does not exist.

- [ ] **Step 3: Implement the minimal catalog**

Construct `new NodeExecutionEnv({ cwd: skillsDir })`, call `loadSkills(env, skillsDir)`, retain the loaded `Skill[]` privately, and expose copied summaries. Resolve by exact `name`; call `formatSkillInvocation(skill, instructions)` only after a successful lookup.

- [ ] **Step 4: Add the bundled test Skill**

Create `skills/structured-brief/SKILL.md` with this frontmatter and behavior:

```markdown
---
name: structured-brief
description: Turn a topic or rough notes into a concise three-part research brief.
---

Return exactly three sections:

1. 核心结论
2. 关键依据
3. 待核实问题

Keep each section concise. Clearly separate known information from uncertainty.
```

Add this resource mapping to `electron-builder.yml`:

```yaml
extraResources:
  - from: skills
    to: skills
    filter:
      - "**/*"
```

Implement `resolveSkillsDir()` as `join(resourcesPath, "skills")` when packaged and `join(appPath, "skills")` in development.

- [ ] **Step 5: Run the focused test**

Run:

```bash
npm test -- apps/desktop/src/shared/pi-skill-catalog.test.ts
```

Expected: one test file passes.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/desktop/src/shared/pi-skill-catalog.ts apps/desktop/src/shared/pi-skill-catalog.test.ts apps/desktop/src/main/skill-paths.ts packages/contracts/src/skills.ts packages/contracts/src/index.ts skills/structured-brief/SKILL.md electron-builder.yml
git commit -m "feat: add Pi skill catalog"
```

**Task 1 acceptance:** A real Pi loader reads the bundled standard `SKILL.md`; only summary metadata is exposed by `list()`; the invocation text is produced by Pi rather than a Deepfield-specific formatter; packaged resource mapping exists.

---

### Task 2: Skill contracts and backend request path

**Files:**

- Modify: `packages/contracts/src/chat.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `packages/application/src/chat-service.ts`
- Modify: `packages/application/src/ports.ts`
- Modify: `apps/desktop/src/worker/index.ts`
- Modify: `apps/desktop/src/worker/assembly.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent.ts`
- Test: `packages/contracts/src/contracts.test.ts`
- Test: `apps/desktop/src/worker/pi-chat-agent.test.ts`
- Test: `apps/desktop/src/main/ipc.test.ts`

**Interfaces:**

- Consumes: `PiSkillCatalog` from Task 1.
- Produces:

```ts
export const ChatRequestOptionsSchema = Type.Object({
  webSearch: Type.Boolean(),
  skillName: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export interface DesktopApi {
  skills: { list(): Promise<SkillSummary[]> };
  chat: {
    send(
      projectId: string,
      content: string,
      requestId: string,
      options: ChatRequestOptions,
    ): Promise<{ requestId: string }>;
  };
}
```

`AgentWorkerRequestSchema` gains `options: ChatRequestOptionsSchema`. The existing `started` event gains optional `skillName`; no other event shape changes.

- [ ] **Step 1: Add one contract test for the new public shape**

Assert that a request with `{webSearch: false, skillName: "structured-brief"}` is valid, an empty `skillName` is invalid, and `SkillSummarySchema` rejects unexpected fields.

- [ ] **Step 2: Run the contract test and confirm RED**

```bash
npm test -- packages/contracts/src/contracts.test.ts
```

Expected: failure because the new schemas and fields are absent.

- [ ] **Step 3: Add contracts and carry the options through Renderer-to-Worker boundaries**

Add `IPC_CHANNELS.skillsList = "deepfield:skills:list"`. Validate the fourth argument to `chat.send` with `ChatRequestOptionsSchema`. Main returns only `mainSkillCatalog.list()` for `skills.list`.

Resolve the Skill directory once in Main:

```ts
const skillsDir = resolveSkillsDir({
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged,
});
```

Load one catalog for `skills.list`; pass `skillsDir` as the Utility Process's first non-secret argument. In the Worker, create a cached promise with `loadPiSkillCatalog(skillsDir)` so Skill files are loaded at most once per process.

Keep the user message persisted as the original `content`. Add `options` to the `AgentWorkerRequest`; do not persist the formatted Skill block as the user's message.

- [ ] **Step 4: Format the selected Skill inside Pi Chat Agent**

Extend `createPiChatAgent` with a narrow dependency:

```ts
export interface SkillCatalogProvider {
  get(): Promise<PiSkillCatalog>;
}

export function createPiChatAgent(
  runtime?: PiRuntime,
  tools?: AgentTool<any>[],
  skills?: SkillCatalogProvider,
): ChatAgent;
```

Before `agent.prompt`, compute:

```ts
const prompt = request.options.skillName === undefined
  ? request.prompt
  : (await skills.get()).formatInvocation(request.options.skillName, request.prompt);
```

Pass `prompt` to Pi. When Pi emits its first `agent_start`, emit `{type: "started", requestId, skillName}`. Map unknown Skill or Skill-loading failure to a fixed, non-sensitive chat failure.

- [ ] **Step 5: Add two focused path assertions**

In the existing IPC test, assert `skills.list` returns summaries and `chat.send` forwards the exact options. In the existing Pi Agent test, inject a fake catalog and assert the Agent receives the formatted prompt while the ordinary path still receives the original prompt.

- [ ] **Step 6: Run only the affected tests**

```bash
npm test -- packages/contracts/src/contracts.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts
```

Expected: affected contract, IPC and Pi Agent tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/contracts/src packages/application/src apps/desktop/src/preload apps/desktop/src/main apps/desktop/src/worker apps/desktop/src/shared
git commit -m "feat: route manual skills through chat"
```

**Task 2 acceptance:** Renderer cannot submit arbitrary Skill content; Main exposes only summaries; the original user message is persisted; Utility resolves the exact name and Pi formats the actual Agent input; ordinary Chat behavior remains usable.

---

### Task 3: Manual Skill picker and visible invocation

**Files:**

- Create: `apps/desktop/src/renderer/components/SkillPicker.tsx`
- Modify: `apps/desktop/src/renderer/components/Composer.tsx`
- Modify: `apps/desktop/src/renderer/components/ChatView.tsx`
- Modify: `apps/desktop/src/renderer/components/Messages.tsx`
- Modify: `apps/desktop/src/renderer/state/chat.ts`
- Modify: `apps/desktop/src/renderer/state/use-chat.ts`
- Modify: `apps/desktop/src/renderer/chat.css`
- Test: `apps/desktop/src/renderer/App-chat.test.tsx`

**Interfaces:**

- Consumes: `api.skills.list()`, `ChatRequestOptions`, optional `started.skillName`.
- Produces:

```ts
export interface SkillPickerProps {
  skills: SkillSummary[];
  value: string | undefined;
  disabled: boolean;
  onChange(name: string | undefined): void;
}

export interface ChatController {
  state: ChatState;
  submit(content: string, options: ChatRequestOptions): void;
  reload(): void;
}
```

- [ ] **Step 1: Add one user-path renderer test**

Render the existing Chat with a fake API returning the `structured-brief` summary. Select it, send one message, and assert:

- the selected Skill label is visible before send;
- `api.chat.send` receives `{webSearch: false, skillName: "structured-brief"}`;
- the selector returns to the empty state after send;
- a `started` event with that Skill shows the Skill badge on the Assistant draft.

- [ ] **Step 2: Run the renderer test and confirm RED**

```bash
npm test -- apps/desktop/src/renderer/App-chat.test.tsx
```

Expected: failure because the Skill selector and request options do not exist.

- [ ] **Step 3: Implement the minimal selector**

Load summaries when `ChatView` mounts. Show a native `<select>` with `aria-label="Skill"`, an empty option labelled `不使用 Skill`, and one option per summary. A loading or listing failure must leave ordinary Chat usable.

Keep `selectedSkillName` in `ChatView`. On valid submit:

```ts
submit(content, {
  webSearch: false,
  ...(selectedSkillName ? { skillName: selectedSkillName } : {}),
});
setSelectedSkillName(undefined);
```

Store optional `skillName` on the streaming `ChatMessageView` when the `started` event arrives. Render a small `Skill: structured-brief` badge on that Assistant message. Persistence of this display-only badge is outside Chat-1A; message text persistence remains unchanged.

- [ ] **Step 4: Apply minimal layout styling**

Keep the selector next to the composer actions, preserve the existing responsive width and avoid changing the sidebar, Capability canvas or Chat rail layout.

- [ ] **Step 5: Run the focused renderer test**

```bash
npm test -- apps/desktop/src/renderer/App-chat.test.tsx
```

Expected: the manual selection path passes.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/desktop/src/renderer packages/contracts/src
git commit -m "feat: add manual skill picker"
```

**Task 3 acceptance:** The user can see and select the bundled Skill, the selection affects exactly one send, the running response shows which Skill was used, and subsequent ordinary messages are unmodified.

---

### Task 4: Chat-1A packaged functional checkpoint

**Files:**

- Modify only if the functional run exposes a concrete Chat-1A defect.
- Update: `docs/development.md` with the Skill directory and one manual test instruction.

**Interfaces:**

- Consumes: Tasks 1–3 complete user path.
- Produces: a user-testable macOS package and a short factual checkpoint report.

- [ ] **Step 1: Run the stage verification once**

```bash
npm run typecheck
npm run build
npm run test:e2e
```

Expected: typecheck and build succeed; the existing Electron shell starts. If existing E2E assumptions need a small update because `DesktopApi` gained `skills.list`, update only the shared fake API.

- [ ] **Step 2: Build the local Apple Silicon package**

```bash
npm run dist:dir
```

Expected: `release/mac-arm64/Deepfield.app` exists and contains `Contents/Resources/skills/structured-brief/SKILL.md`.

- [ ] **Step 3: Run one Fake-Agent application Smoke**

Launch the packaged app with the existing E2E/Fake-Agent configuration, confirm the brand and project Chat render, then quit through the normal application lifecycle.

- [ ] **Step 4: Perform the real user checkpoint**

With the user's existing DeepSeek Key, manually try:

1. ordinary question: `把人形机器人行业研究目标整理成一个简短清单。`
2. Coding: `用 TypeScript 写一个公司名称去重函数，并解释思路。`
3. office writing: paste a short rough note and ask for a concise internal email;
4. short memory: provide one project rule, ask for it again after two messages;
5. Skill: select `structured-brief`, submit rough research notes, and verify the three required sections;
6. next message: send an unrelated question without selecting Skill and verify the three-section constraint is gone.

Record only whether each path is usable and the concrete problems observed. Add a regression test only for a bug actually found in this run.

- [ ] **Step 5: Document and commit the checkpoint**

```bash
git add docs/development.md
git commit -m "docs: add Chat skill usage"
```

**Task 4 acceptance:** The packaged macOS app loads the bundled Skill, ordinary Chat still works, Skill affects one turn only, message history remains readable after restart, and the user has enough evidence to approve or revise Chat-1A before Chat-1B begins.

---

## Implementation Order and Review Gates

1. Review and execute Task 1 only.
2. Main window verifies the Pi loader and packaged resource boundary.
3. Execute Task 2 only.
4. Main window verifies the backend request path and original-message persistence.
5. Execute Task 3 only.
6. User opens the app and checks the manual interaction.
7. Execute Task 4 once, then stop for Chat-1A acceptance.

Task 1 starts at the Skill Catalog because every later layer depends on a trustworthy answer to two questions: “the application actually loaded which Pi Skills” and “a selected name resolves to which instructions.” Starting from UI would create a selector backed by hard-coded data; starting from Agent prompt assembly would make it impossible to list available Skills safely. The catalog is the smallest reusable boundary for both Chat and later Research Agents.

## Self-Review Result

- Spec coverage: manual Pi Skill loading, metadata listing, exact backend resolution, one-turn selection, visible usage, packaging and limited functional testing are all assigned to Tasks 1–4.
- Type consistency: `SkillSummary`, `ChatRequestOptions`, `PiSkillCatalog`, `SkillCatalogProvider` and `started.skillName` have one definition and one direction of travel.
- Scope: this plan intentionally ends before DeepSeek Responses/web-search implementation so the user can test the base Agent and Skill path first.
- Placeholders: no implementation field or acceptance condition remains unspecified.
