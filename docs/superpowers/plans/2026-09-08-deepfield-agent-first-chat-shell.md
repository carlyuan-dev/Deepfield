# Deepfield Agent-first Chat Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deepfield open directly into a persistent standalone Agent conversation, list conversations above workflows, and support full Chat, split Chat/Capability, and collapsed Chat layouts without binding Conversation to Project.

**Architecture:** Rebuild the development Conversation schema without `project_id`, route Chat by `conversationId`, and keep the existing Pi Agent/Skill/Worker path unchanged above the context boundary. Renderer owns one active Conversation and one independent Capability-pane state; collapsing Chat changes layout only. The current `Project` implementation remains isolated inside the Industry Research prototype until Capability A replaces it with `CapabilityItem`.

**Tech Stack:** Electron 43, React 19, TypeScript 7, SQLite (`node:sqlite`), TypeBox, Pi Agent Core 0.84.3, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-deepfield-agent-first-chat-shell-design.md`

## Global Constraints

- Conversation has no Project, Capability, or Item property.
- Existing local Project/Conversation data is test data and may be cleared by this schema change.
- Existing encrypted DeepSeek credentials, Tool Platform, Pi Agent, and bundled Skill behavior remain intact.
- Visible product language uses “研究条目” inside Industry Research; no new generic feature may depend on the legacy Project API.
- Each task runs only its named focused test plus typecheck where specified; no full test suite, coverage run, mutation test, or repeated verification.
- The stage checkpoint runs build, Electron E2E, and packaging once.
- Use Node 24 from `/opt/homebrew/opt/node@24/bin` when the default shell runtime is older than the repository engine requirement.

---

### Task 1 (P3-T5): Standalone Conversation persistence and Chat backend

**Files:**

- Create: `packages/contracts/src/conversations.ts`
- Modify: `packages/contracts/src/projects.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/mappers.ts`
- Modify: `packages/persistence/src/conversation-repository.ts`
- Modify: `packages/persistence/src/project-repository.ts`
- Modify: `packages/application/src/project-service.ts`
- Create: `packages/application/src/conversation-service.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/application/src/context-builder.ts`
- Modify: `packages/application/src/chat-service.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Test: `packages/persistence/src/persistence.test.ts`
- Test: `packages/application/src/chat-service.test.ts`
- Test: `apps/desktop/src/main/ipc.test.ts`
- Modify only shared typed fixtures required by the new signatures.

**Interfaces:**

- Produces:

```ts
export interface Conversation {
  id: ConversationId;
  title: string;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRepository {
  create(): Conversation;
  getOrCreateDraft(): Conversation;
  getById(conversationId: ConversationId): Conversation | undefined;
  listRecent(): Conversation[];
  activate(conversationId: ConversationId, title: string): Conversation;
}
```

```ts
export interface ConversationService {
  create(): Conversation;
  openInitial(): { active: Conversation; recent: Conversation[] };
  listRecent(): Conversation[];
}

export interface ChatSendResult {
  requestId: string;
  conversation: Conversation;
}

export interface DesktopApi {
  conversations: {
    create(): Promise<Conversation>;
    openInitial(): Promise<{ active: Conversation; recent: Conversation[] }>;
    listRecent(): Promise<Conversation[]>;
  };
  chat: {
    send(
      conversationId: string,
      content: string,
      requestId: string,
      options: ChatRequestOptions,
    ): Promise<ChatSendResult>;
    listMessages(conversationId: string): Promise<ChatMessage[]>;
  };
}
```

- `ProjectRepository.createWithConversation()` becomes `ProjectRepository.create()` and continues its existing Project/activity transaction without creating a Conversation. Update `packages/application/src/project-service.ts` to call the renamed method.
- Migration 3 deliberately replaces only the old `messages` and `conversations` tables. It recreates `conversations(id, title, has_user_message, created_at, updated_at)` and `messages(... FOREIGN KEY(conversation_id) ...)`. Existing secrets and Tool audit tables are untouched.
- `AgentContextSnapshotSchema` contains `conversationId`, `systemPrompt`, and `messages`; remove `projectId`. `ContextBuilder.build(conversationId)` reads only that Conversation and uses a general Deepfield main-Agent system prompt.
- Add IPC channels `deepfield:conversations:create`, `deepfield:conversations:openInitial`, and `deepfield:conversations:listRecent`.

- [ ] **Step 1: Add one focused persistence test**

Add one path to the existing persistence test that migrates a temporary database, asserts `PRAGMA table_info(conversations)` has no `project_id`, creates a blank Conversation titled `新对话`, appends one user message, activates it, reopens the database, and confirms `listRecent()` returns it first. Also assert creating a legacy Project does not create a Conversation.

Update one Chat service path to create a standalone Conversation and send its first message. Assert the raw message is persisted, the deterministic title is returned, the Worker context has no Project field, and existing `{webSearch:false, skillName?}` options reach the Worker. Update one IPC path for Conversation create/open/list and send by Conversation ID.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
npm test -- packages/persistence/src/persistence.test.ts packages/application/src/chat-service.test.ts apps/desktop/src/main/ipc.test.ts
```

Expected: the focused paths fail because persistence, Chat, and IPC still require Project-bound Conversations.

- [ ] **Step 3: Implement the contracts, migration, mapper, and repositories**

Use a destructive development migration for the two Chat tables because the user approved discarding current test conversations. `create()` returns a blank Conversation with title `新对话`; `getOrCreateDraft()` returns the newest blank row or creates one; `activate()` sets `has_user_message = 1`, updates title and timestamp, and returns the updated row. `listRecent()` excludes blank drafts and orders by `updated_at DESC`.

- [ ] **Step 4: Implement Conversation-first Chat and IPC**

`openInitial()` returns the newest recent Conversation or `getOrCreateDraft()` when none exists. Generate the first-message title deterministically:

```ts
export function titleFromFirstMessage(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length <= 28 ? normalized : `${characters.slice(0, 28).join("")}…`;
}
```

Within the existing Chat transaction, append the raw user content and activate only a Conversation with no prior user message. Return the updated Conversation with the request ID. On completion, persist the assistant message without writing a Project activity event, because standalone Chat has no Project. Validate exact IPC arity and non-empty Conversation IDs. Keep Worker streaming, API-key handling, and Skill formatting unchanged.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
npm test -- packages/persistence/src/persistence.test.ts packages/application/src/chat-service.test.ts apps/desktop/src/main/ipc.test.ts
npm run typecheck
```

Expected: all three focused paths pass and existing typed callers compile after minimal fixture updates.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src packages/persistence/src packages/application/src apps/desktop/src/main apps/desktop/src/preload
git commit -m "refactor: make chat conversation-first"
```

**Task acceptance:** Conversation rows contain no Project reference; Project creation no longer creates a Chat; standalone Chat survives database reopen, sends by Conversation ID with a general Agent prompt, returns its activated title, and preserves the existing Pi Skill request path.

---

### Task 2 (P3-T6): Default Chat and recent Conversation sidebar

**Files:**

- Create: `apps/desktop/src/renderer/state/use-conversations.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/components/ChatView.tsx`
- Modify: `apps/desktop/src/renderer/state/use-chat.ts`
- Modify: `apps/desktop/src/renderer/state/chat.ts`
- Modify: `apps/desktop/src/renderer/state/chat-event-hub.ts`
- Modify: `apps/desktop/src/renderer/renderer-test-helpers.ts`
- Test: `apps/desktop/src/renderer/App-chat.test.tsx`

**Interfaces:**

- Consumes: `api.conversations` and Conversation-first Chat from Task 1.
- Produces:

```ts
export interface ConversationController {
  conversations: Conversation[];
  activeConversation: Conversation | undefined;
  loading: boolean;
  error: string | undefined;
  open(id: string): void;
  newConversation(): Promise<void>;
  acceptUpdated(conversation: Conversation): void;
  retry(): void;
}
```

- `ChatEventHub` maps `requestId -> conversationId`; all previous routing guarantees remain unchanged.

- [ ] **Step 1: Add one renderer user-path test**

Render the application with two recent Conversations. Assert the newest is open immediately and accepts input without creating/selecting a Project; click the older title and observe its messages; click `＋ 新对话` and observe an empty usable Chat. Send the first message and assert the new deterministic title appears in the sidebar.

- [ ] **Step 2: Run the focused renderer test and confirm RED**

```bash
npm test -- apps/desktop/src/renderer/App-chat.test.tsx
```

Expected: failure because Sidebar still lists Projects and Chat blocks on missing Project.

- [ ] **Step 3: Implement Conversation controller and sidebar**

On mount, call `openInitial()` and use its `active` and `recent` values. `newConversation()` does nothing when the active Conversation is already blank; otherwise it creates and opens a new blank Conversation. Only Conversations with user messages appear under “对话”.

Sidebar order is:

```text
＋ 新对话
对话
  <recent conversation titles>
工作流
  行业研究
设置
```

Remove the global Project list. Keep Project data internal to the existing Industry Research prototype.

- [ ] **Step 4: Make ChatView unconditional**

Remove the “请先创建或选择项目” gate and the Chat mode selector. Route `useChat`, message listing, event mapping, and sends with `conversationId`. After `chat.send` resolves, call `acceptUpdated(result.conversation)` so the first-message title appears without another model request.

- [ ] **Step 5: Run the focused test and typecheck**

```bash
npm test -- apps/desktop/src/renderer/App-chat.test.tsx
npm run typecheck
```

Expected: the application starts in a usable Chat and the recent/new Conversation path passes.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "feat: make standalone chat the default"
```

**Task acceptance:** Opening Deepfield shows a usable Agent Chat; recent Conversations and new Chat work without a Project; Skill selection still affects exactly one message.

---

### Task 3 (P3-T7): Three-pane Chat and Capability shell

**Files:**

- Modify: `apps/desktop/src/renderer/state/workspace.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/features/projects/CapabilityView.tsx`
- Modify: `apps/desktop/src/renderer/features/projects/ProjectForm.tsx`
- Modify: `apps/desktop/src/renderer/features/projects/ProjectWorkspace.tsx`
- Modify: `apps/desktop/src/renderer/app.css`
- Modify: `apps/desktop/src/renderer/chat.css`
- Test: `apps/desktop/src/renderer/App-shell.test.tsx`

**Interfaces:**

- Consumes: active standalone Conversation from Task 2.
- Produces:

```ts
export type ChatPaneState = "expanded" | "collapsed";

export interface WorkspaceState {
  activeCapability: "industry-research" | undefined;
  chatPane: ChatPaneState;
}

export type WorkspaceAction =
  | { type: "OPEN_CONVERSATION" }
  | { type: "OPEN_CAPABILITY_DIRECT"; capabilityId: "industry-research" }
  | { type: "OPEN_CAPABILITY_FROM_CHAT"; capabilityId: "industry-research" }
  | { type: "COLLAPSE_CHAT" }
  | { type: "EXPAND_CHAT" };
```

- [ ] **Step 1: Replace the workspace test with one three-state path**

Assert: initial Chat fills the workspace; direct click on “行业研究” opens Capability and collapses Chat to a right-arrow rail; clicking the arrow expands Chat beside Capability; clicking a Conversation also expands Chat while Capability remains mounted; collapsing during a fake streaming reply and re-expanding retains the draft.

- [ ] **Step 2: Run the focused workspace test and confirm RED**

```bash
npm test -- apps/desktop/src/renderer/App-shell.test.tsx
```

Expected: failure because the current shell swaps Chat and Capability views and ties its rail to Project state.

- [ ] **Step 3: Implement one persistent Chat pane**

Keep `ChatView` mounted whenever a Conversation exists. With no active Capability it fills the workspace. With a Capability active, CSS grid renders either `Chat + Capability` or `38px Chat rail + Capability`. The arrow changes direction and only dispatches layout state; it never cancels an Agent request or changes Conversation data.

- [ ] **Step 4: Isolate legacy Project wording**

Inside the existing Industry Research prototype, replace visible “项目” copy with “研究条目”. Replace “打开项目 Chat” with an “展开 Chat” action that expands the current standalone Conversation without binding it to the research entry. Keep the internal Project types for this slice only.

- [ ] **Step 5: Run the focused test and typecheck**

```bash
npm test -- apps/desktop/src/renderer/App-shell.test.tsx
npm run typecheck
```

Expected: all three layout states and streaming preservation pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "feat: add agent-first capability shell"
```

**Task acceptance:** Direct workflow entry collapses Chat; arrow and Conversation clicks re-expand it; the Capability stays open; an in-flight Chat remains mounted and visible after expansion.

---

### Task 4 (P3-T8): Packaged functional checkpoint

**Files:**

- Modify only if a concrete main-path defect is found.
- Modify: `docs/development.md`
- Modify: `tests/e2e/foundation.spec.ts`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: a user-testable Apple Silicon `.app` and a concise manual test note.

- [ ] **Step 1: Run the stage checks once**

```bash
npm run typecheck
npm run test:e2e
```

`test:e2e` already runs `npm run build`; do not run a second standalone build.

Update the existing E2E to cover only: app opens into Chat, first message succeeds in Fake Agent mode, title appears in “对话”, direct Industry Research click collapses Chat, arrow re-expands it, and restart restores the Conversation.

- [ ] **Step 2: Build the unpacked application once**

```bash
npx electron-builder --mac --arm64 --dir
```

Use the `out/` produced by `test:e2e` rather than rebuilding it through `npm run dist:dir`. Confirm `release/mac-arm64/Deepfield.app` exists and still contains `Contents/Resources/skills/structured-brief/SKILL.md`.

- [ ] **Step 3: Run one packaged Fake Agent Smoke**

Use the existing isolated E2E userData convention. Launch the packaged app, send one message without selecting a Project, select `structured-brief` for one fake message, exercise the workflow collapse/expand arrow, then quit normally.

- [ ] **Step 4: Update the manual checkpoint**

Document the new Conversation-first entry and ask the user to try ordinary question, Coding, office writing, two-turn memory, one `structured-brief` message, and one following ordinary message. State that Fake Agent verifies UI wiring only; real DeepSeek verifies answer and Skill quality.

- [ ] **Step 5: Commit documentation or a concrete checkpoint fix**

```bash
git add docs/development.md tests/e2e/foundation.spec.ts
git commit -m "docs: add agent-first chat checkpoint"
```

**Task acceptance:** The packaged macOS app opens directly into standalone Chat, restores recent history, preserves one-shot Skill behavior, and supports the three Capability-shell layouts. Stop for user testing before Chat-1B or Capability A development.

---

## Review Gates

1. Review and execute P3-T5 only; verify standalone persistence and one Chat request by Conversation ID.
2. Execute P3-T6 only; let the user inspect the default Chat and recent Conversation behavior.
3. Execute P3-T7 only; let the user inspect the three-pane shell behavior.
4. Execute P3-T8 once; stop for the real DeepSeek user checkpoint.

The first task starts at persistence because every usable Chat action currently requires a Project-backed Conversation. Changing only the Renderer would reproduce the same failure behind a different screen. Once Conversation is independently durable, the service, sidebar, and shell can be changed in small reviewable slices without inventing a hidden Project.
