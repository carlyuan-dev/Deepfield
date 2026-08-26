# Deepfield Foundation and Agent Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable Apple Silicon desktop slice: local projects and lazy conversations, encrypted DeepSeek configuration, Pi-powered pure Chat in a utility process, and an Agent-native shell that supports direct Capability entry or a docked Chat rail.

**Architecture:** Electron owns the trusted macOS boundary; its sandboxed Renderer uses a typed preload API. SQLite and application services live in the main process, while Pi Agent Core runs in a utility process behind a request/event bridge. Direct Capability project creation never invokes the main Agent; Chat constructs a fresh project context from SQLite and streams worker events back through IPC.

**Tech Stack:** Node.js 24.18.x, Electron 43.4.0, React 19.2.7, TypeScript ESM, electron-vite 5.0.0, Vite 7.3.6, Pi Agent Core/Pi AI 0.84.3, `node:sqlite`, TypeBox, Vitest, React Testing Library, Playwright Electron.

**Spec:** `docs/superpowers/specs/2026-08-25-deepfield-agent-native-research-design.md`

## Global Constraints

- Target Apple Silicon (`arm64`) macOS only; the reference machine is an M3 Mac.
- Use npm workspaces and commit `package-lock.json`; all installed dependencies use `--save-exact`.
- Development Node.js must be `>=24.17.0`; Pi AI requires `>=22.19.0` and Electron 43 embeds Node 24.
- Use `@earendil-works/pi-agent-core@0.84.3` and `@earendil-works/pi-ai@0.84.3` as dependencies; do not fork Pi.
- Use Electron context isolation and sandboxing; the Renderer must never receive a DeepSeek API key, database handle or arbitrary filesystem/network primitive.
- Put mutable data under the injected Electron `userData` directory, never inside the app bundle or repository.
- Store the encrypted DeepSeek key outside SQLite; production encryption uses Electron `safeStorage` backed by macOS Keychain.
- The first slice implements pure Chat and project creation only. It must not add web search, arbitrary Tools, child Agents or Capability A research logic.
- Direct Capability project creation must make zero model calls and zero Agent worker requests.
- Every source file has one responsibility; prefer files below 200 lines and split before they exceed 300 lines.
- Unit and component tests must run without network access or real credentials.
- Preserve user-owned untracked files, including `.DS_Store` and `docs/架构图/`; do not stage them.

---

## Planned File Structure

```text
package.json                         npm workspace scripts and pinned dependencies
package-lock.json                    exact dependency graph
tsconfig.base.json                   strict shared TypeScript options
electron.vite.config.ts              main/preload/worker/renderer build entries
vitest.config.ts                     unit and component test projects
playwright.config.ts                 Electron end-to-end configuration
electron-builder.yml                 arm64 app/DMG packaging metadata

apps/desktop/package.json            desktop workspace identity
apps/desktop/src/main/index.ts       Electron lifecycle and composition root
apps/desktop/src/main/window.ts      hardened BrowserWindow construction
apps/desktop/src/main/ipc.ts         typed IPC handler registration
apps/desktop/src/main/paths.ts       injected user-data paths
apps/desktop/src/main/secret-store.ts macOS-backed encrypted secret persistence
apps/desktop/src/main/agent-worker-client.ts utility process request/event bridge

apps/desktop/src/preload/index.ts    minimal contextBridge API
apps/desktop/src/worker/index.ts     utility process message loop
apps/desktop/src/worker/pi-chat-agent.ts Pi Agent Core adapter

apps/desktop/src/renderer/index.html renderer document
apps/desktop/src/renderer/main.tsx   React bootstrap
apps/desktop/src/renderer/App.tsx    route and workspace composition
apps/desktop/src/renderer/app.css    shell layout and tokens
apps/desktop/src/renderer/api.ts     typed `window.deepfield` access
apps/desktop/src/renderer/state/workspace.ts workspace state reducer
apps/desktop/src/renderer/components/Sidebar.tsx
apps/desktop/src/renderer/components/Composer.tsx
apps/desktop/src/renderer/components/ChatView.tsx
apps/desktop/src/renderer/components/ChatRail.tsx
apps/desktop/src/renderer/features/projects/ProjectForm.tsx
apps/desktop/src/renderer/features/projects/ProjectWorkspace.tsx

packages/contracts/package.json      contracts workspace exports
packages/contracts/src/ids.ts        branded entity identifiers
packages/contracts/src/projects.ts   project and conversation schemas
packages/contracts/src/chat.ts       chat request and streaming event schemas
packages/contracts/src/ipc.ts        Desktop API contract
packages/contracts/src/index.ts      public contract exports

packages/persistence/package.json    persistence workspace exports
packages/persistence/src/database.ts SQLite connection and pragmas
packages/persistence/src/migrations.ts ordered transactional migrations
packages/persistence/src/repositories.ts project/conversation/message/event repositories
packages/persistence/src/index.ts    persistence public API

packages/application/package.json    application workspace exports
packages/application/src/project-service.ts direct project use cases
packages/application/src/context-builder.ts main Agent context assembly
packages/application/src/chat-service.ts chat persistence and worker orchestration
packages/application/src/index.ts    application public API

tests/e2e/foundation.spec.ts          packaged process and persistence journey
tests/fixtures/fake-agent.ts          deterministic streamed Agent responses
```

---

### Task 1: Workspace Scaffold and Shared Contracts

**Files:**
- Create: `package.json`
- Create: `apps/desktop/package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/persistence/package.json`
- Create: `packages/application/package.json`
- Create: `tsconfig.base.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/projects.ts`
- Create: `packages/contracts/src/chat.ts`
- Create: `packages/contracts/src/ipc.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.test.ts`

**Interfaces:**
- Consumes: approved design only.
- Produces: `ProjectId`, `ConversationId`, `MessageId`, `Project`, `Conversation`, `ChatMessage`, `CreateProjectInput`, `AgentWorkerRequest`, `AgentWorkerEvent`, and `DesktopApi`.

- [ ] **Step 1: Write the failing contract test**

```ts
// packages/contracts/src/contracts.test.ts
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { CreateProjectInputSchema, AgentWorkerEventSchema } from "./index.js";

describe("shared contracts", () => {
  it("accepts a required industry and optional structured scope", () => {
    expect(Value.Check(CreateProjectInputSchema, {
      industry: "人形机器人",
      scope: { focus: "整机与核心零部件", exclusions: ["工业机械臂"] },
      launchSource: "direct-ui",
    })).toBe(true);
    expect(Value.Check(CreateProjectInputSchema, { scope: {} })).toBe(false);
  });

  it("rejects malformed worker stream events", () => {
    expect(Value.Check(AgentWorkerEventSchema, {
      requestId: "req_1",
      type: "text_delta",
      delta: "你好",
    })).toBe(true);
    expect(Value.Check(AgentWorkerEventSchema, {
      requestId: "req_1",
      type: "text_delta",
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Create the npm workspace and install exact dependencies**

Create a root `package.json` with `type: "module"`, `engines.node: ">=24.17.0"`, workspaces `apps/*` and `packages/*`, and these scripts:

```json
{
  "name": "deepfield",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.17.0" },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.base.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "check": "npm run typecheck && npm run test"
  }
}
```

Create the workspace manifests before installing dependencies so npm can resolve every declared workspace. The desktop package is private and has no exports. Each library package is private, uses ESM, and exports its TypeScript source during development:

`apps/desktop/package.json`:

```json
{ "name": "@deepfield/desktop", "private": true, "type": "module" }
```

`packages/contracts/package.json`:

```json
{
  "name": "@deepfield/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/persistence/package.json`:

```json
{
  "name": "@deepfield/persistence",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/application/package.json`:

```json
{
  "name": "@deepfield/application",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Run:

```bash
npm install --save-exact electron@43.4.0 react@19.2.7 react-dom@19.2.7 @earendil-works/pi-agent-core@0.84.3 @earendil-works/pi-ai@0.84.3 typebox@1.3.7
npm install --save-dev --save-exact electron-vite@5.0.0 vite@7.3.6 @vitejs/plugin-react@5.2.0 typescript vitest jsdom @testing-library/react @testing-library/user-event @types/node @types/react @types/react-dom @playwright/test@1.62.1 electron-builder
```

Expected: `package-lock.json` is generated and all packages resolve on Node 24.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- packages/contracts/src/contracts.test.ts`

Expected: FAIL because `packages/contracts/src/index.ts` and schemas do not exist.

- [ ] **Step 4: Implement branded IDs and the exact contracts**

```ts
// packages/contracts/src/ids.ts
export type Brand<T, TName extends string> = T & { readonly __brand: TName };
export type ProjectId = Brand<string, "ProjectId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type RequestId = Brand<string, "RequestId">;
```

```ts
// packages/contracts/src/projects.ts
import { Type, type Static } from "typebox";

export const ProjectScopeSchema = Type.Object({
  focus: Type.Optional(Type.String()),
  geography: Type.Optional(Type.String()),
  timeRange: Type.Optional(Type.String()),
  exclusions: Type.Optional(Type.Array(Type.String())),
  customRequirements: Type.Optional(Type.Array(Type.String())),
});

export const CreateProjectInputSchema = Type.Object({
  industry: Type.String({ minLength: 1 }),
  scope: ProjectScopeSchema,
  launchSource: Type.Union([Type.Literal("chat"), Type.Literal("direct-ui")]),
});
export type CreateProjectInput = Static<typeof CreateProjectInputSchema>;

export interface Project {
  id: import("./ids.js").ProjectId;
  industry: string;
  scope: Static<typeof ProjectScopeSchema>;
  status: "draft";
  createdAt: string;
  updatedAt: string;
}
```

```ts
// packages/contracts/src/chat.ts
import { Type, type Static } from "typebox";

export const AgentWorkerEventSchema = Type.Union([
  Type.Object({ requestId: Type.String(), type: Type.Literal("started") }),
  Type.Object({ requestId: Type.String(), type: Type.Literal("text_delta"), delta: Type.String() }),
  Type.Object({ requestId: Type.String(), type: Type.Literal("completed"), text: Type.String() }),
  Type.Object({ requestId: Type.String(), type: Type.Literal("failed"), code: Type.String(), message: Type.String() }),
]);
export type AgentWorkerEvent = Static<typeof AgentWorkerEventSchema>;

export interface AgentContextSnapshot {
  projectId: string;
  conversationId: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
}

export interface AgentWorkerRequest {
  requestId: string;
  kind: "chat.prompt";
  prompt: string;
  context: AgentContextSnapshot;
  apiKey: string;
  modelId: "deepseek-chat";
}
```

Define `DesktopApi` in `ipc.ts` with only these methods:

```ts
export interface DesktopApi {
  projects: {
    create(input: CreateProjectInput): Promise<Project>;
    list(): Promise<Project[]>;
  };
  settings: {
    hasDeepSeekKey(): Promise<boolean>;
    setDeepSeekKey(value: string): Promise<void>;
  };
  chat: {
    send(projectId: string, content: string): Promise<{ requestId: string }>;
    subscribe(listener: (event: AgentWorkerEvent) => void): () => void;
  };
}
```

- [ ] **Step 5: Add strict build configuration and minimal build entries**

Set `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: "NodeNext"`, and path aliases for `@deepfield/contracts`, `@deepfield/persistence`, and `@deepfield/application`. Configure electron-vite with main inputs `index` and `agent-worker`, the preload entry, and React Renderer root.

```ts
// electron.vite.config.ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: {
    index: resolve("apps/desktop/src/main/index.ts"),
    "agent-worker": resolve("apps/desktop/src/worker/index.ts"),
  } } } },
  preload: { build: { rollupOptions: { input: resolve("apps/desktop/src/preload/index.ts") } } },
  renderer: { root: "apps/desktop/src/renderer", plugins: [react()] },
});
```

- [ ] **Step 6: Run contract tests and type checking**

Run: `npm test -- packages/contracts/src/contracts.test.ts && npm run typecheck`

Expected: PASS with no type errors.

- [ ] **Step 7: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.base.json electron.vite.config.ts vitest.config.ts apps/desktop/package.json apps/desktop/src/renderer/index.html packages/*/package.json packages/contracts/src
git commit -m "build: scaffold desktop workspace and contracts"
```

---

### Task 2: SQLite Persistence and Transactional Project Records

**Files:**
- Create: `packages/persistence/src/database.ts`
- Create: `packages/persistence/src/migrations.ts`
- Create: `packages/persistence/src/repositories.ts`
- Create: `packages/persistence/src/index.ts`
- Test: `packages/persistence/src/persistence.test.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectId`, `ConversationId`, `MessageId`, `CreateProjectInput`.
- Produces: `openDatabase(path)`, `migrate(database)`, `ProjectRepository`, `ConversationRepository`, `MessageRepository`, and `ActivityRepository`.

- [ ] **Step 1: Write failing persistence tests**

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase, migrate, createRepositories } from "./index.js";

describe("project persistence", () => {
  it("creates one project conversation and one activity atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepfield-db-"));
    const db = openDatabase(join(dir, "deepfield.sqlite"));
    migrate(db);
    const repos = createRepositories(db);

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "direct-ui",
    });

    expect(repos.conversations.listByProject(project.id)).toHaveLength(1);
    expect(repos.activities.listByProject(project.id)[0]?.type).toBe("project.created");
    expect(repos.messages.listByConversation(
      repos.conversations.listByProject(project.id)[0]!.id,
    )).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- packages/persistence/src/persistence.test.ts`

Expected: FAIL because persistence exports do not exist.

- [ ] **Step 3: Implement database opening and migration 001**

Use `DatabaseSync` from `node:sqlite`, enable foreign keys and WAL, and apply migrations in a transaction.

```ts
// packages/persistence/src/database.ts
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return db;
}
```

Migration 001 creates:

```sql
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE projects(
  id TEXT PRIMARY KEY, industry TEXT NOT NULL, scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE conversations(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
  has_user_message INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE messages(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE project_activity_events(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  type TEXT NOT NULL, source TEXT NOT NULL, importance TEXT NOT NULL,
  summary TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

- [ ] **Step 4: Implement repositories and atomic project creation**

`ProjectRepository.createWithConversation()` must use one explicit transaction and `crypto.randomUUID()` IDs. It creates the project, its empty conversation, and a `project.created` silent activity. Roll back all rows on any insert failure.

```ts
createWithConversation(input: CreateProjectInput): Project {
  this.db.exec("BEGIN IMMEDIATE");
  try {
    const project = insertProject(this.db, input);
    insertConversation(this.db, project.id);
    insertActivity(this.db, project.id, "project.created", "silent", `创建项目：${project.industry}`);
    this.db.exec("COMMIT");
    return project;
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 5: Add duplicate-conversation and restart tests**

Open the same database twice and assert `getOrCreateForProject(projectId)` returns the original conversation ID. Assert messages written before close are visible after reopening.

- [ ] **Step 6: Run tests and type checking**

Run: `npm test -- packages/persistence/src/persistence.test.ts && npm run typecheck`

Expected: PASS; no duplicate conversation rows.

- [ ] **Step 7: Commit persistence**

```bash
git add packages/persistence
git commit -m "feat: persist projects and lazy conversations"
```

---

### Task 3: Encrypted DeepSeek Secret Storage

**Files:**
- Create: `apps/desktop/src/main/secret-store.ts`
- Test: `apps/desktop/src/main/secret-store.test.ts`

**Interfaces:**
- Consumes: injected secret file path and Electron `safeStorage` adapter.
- Produces: `SecretStore.has(name)`, `SecretStore.set(name, value)`, and `SecretStore.get(name)` for the key name `deepseek.apiKey`.

- [ ] **Step 1: Write a failing encryption test**

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SecretStore } from "./secret-store.js";

const crypto = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
  decrypt: (value: Buffer) => value.toString().replace("encrypted:", ""),
};

it("never writes the plaintext API key", () => {
  const file = join(mkdtempSync(join(tmpdir(), "deepfield-secret-")), "secrets.json");
  const store = new SecretStore(file, crypto);
  store.set("deepseek.apiKey", "sk-private-value");
  expect(readFileSync(file, "utf8")).not.toContain("sk-private-value");
  expect(store.get("deepseek.apiKey")).toBe("sk-private-value");
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- apps/desktop/src/main/secret-store.test.ts`

Expected: FAIL because `SecretStore` does not exist.

- [ ] **Step 3: Implement the injectable store**

Define `SecretCrypto` with `isAvailable`, `encrypt`, and `decrypt`. Store a JSON object of base64 ciphertext. Write to `secrets.json.tmp`, `fsync`, then rename to avoid partial writes. Reject empty keys and throw `SecretEncryptionUnavailableError` when encryption is unavailable.

Production composition adapts Electron APIs:

```ts
const cryptoAdapter: SecretCrypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
};
```

- [ ] **Step 4: Test overwrite, missing key and corrupted ciphertext**

Assert overwrite returns only the new key, missing returns `undefined`, and invalid base64/decryption throws `SecretStoreCorruptError` without deleting the file.

- [ ] **Step 5: Run tests**

Run: `npm test -- apps/desktop/src/main/secret-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit secret storage**

```bash
git add apps/desktop/src/main/secret-store.ts apps/desktop/src/main/secret-store.test.ts
git commit -m "feat: add encrypted local secret storage"
```

---

### Task 4: Utility Process Bridge and Hardened Electron Boundary

**Files:**
- Create: `apps/desktop/src/main/paths.ts`
- Create: `apps/desktop/src/main/window.ts`
- Create: `apps/desktop/src/main/agent-worker-client.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/worker/index.ts`
- Test: `apps/desktop/src/main/agent-worker-client.test.ts`

**Interfaces:**
- Consumes: `AgentWorkerRequest`, `AgentWorkerEvent`, `DesktopApi`.
- Produces: `AgentWorkerClient.send(request): AsyncIterable<AgentWorkerEvent>`, hardened `BrowserWindow`, and typed preload event forwarding.

- [ ] **Step 1: Write a failing bridge-order test**

Create an in-memory `MessageEndpoint` fake and assert two interleaved request IDs produce two isolated async event streams in original order; a `failed` or `completed` event closes only its matching stream.

```ts
const first = client.send(request("req-1"));
const second = client.send(request("req-2"));
endpoint.emit(event("req-2", "text_delta", "B"));
endpoint.emit(event("req-1", "text_delta", "A"));
endpoint.emit(event("req-1", "completed", "A"));
expect(await collect(first)).toEqual(["A", "completed:A"]);
expect(await collectUntilDelta(second)).toEqual(["B"]);
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- apps/desktop/src/main/agent-worker-client.test.ts`

Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Implement `AgentWorkerClient`**

Abstract the Electron child behind:

```ts
export interface MessageEndpoint {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}
```

Validate every incoming event with `Value.Check(AgentWorkerEventSchema, value)`. On worker exit, close all streams with `AgentWorkerExitedError`. Bound each request queue to 1,000 events to prevent unbounded memory growth.

- [ ] **Step 4: Create the utility process and worker message loop**

In `main/index.ts`, call `utilityProcess.fork(join(__dirname, "agent-worker.js"), [], { serviceName: "Deepfield Agent" })` after `app.whenReady()`. Adapt `child.postMessage` and `process.parentPort` to `MessageEndpoint`.

The worker validates a request, delegates to a `ChatAgent` supplied in Task 5, and posts only schema-valid events. It never opens SQLite and never writes the API key to disk or logs.

- [ ] **Step 5: Harden the BrowserWindow and preload**

Create the window with:

```ts
new BrowserWindow({
  width: 1440,
  height: 900,
  minWidth: 1100,
  minHeight: 700,
  webPreferences: {
    preload: join(__dirname, "../preload/index.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
```

Deny new windows and navigation away from the app. Expose only `DesktopApi` methods through `contextBridge`; do not expose raw `ipcRenderer`, channel names or generic invoke/send functions.

- [ ] **Step 6: Run bridge tests and build**

Run: `npm test -- apps/desktop/src/main/agent-worker-client.test.ts && npm run build`

Expected: PASS; build emits `out/main/index.js`, `out/main/agent-worker.js`, preload and Renderer assets.

- [ ] **Step 7: Commit the process boundary**

```bash
git add apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/worker/index.ts electron.vite.config.ts
git commit -m "feat: isolate agent runtime in utility process"
```

---

### Task 5: Pi-Powered DeepSeek Pure Chat Adapter

**Files:**
- Create: `apps/desktop/src/worker/pi-chat-agent.ts`
- Create: `tests/fixtures/fake-agent.ts`
- Test: `apps/desktop/src/worker/pi-chat-agent.test.ts`

**Interfaces:**
- Consumes: `AgentContextSnapshot`, API key, `modelId: "deepseek-chat"`.
- Produces: `ChatAgent.run(request, emit, signal): Promise<void>` and `createPiChatAgent()`.

- [ ] **Step 1: Write a failing event-mapping test**

Inject a fake Pi-like runner that emits `agent_start`, two `message_update` text deltas, `message_end`, and `agent_end`. Assert the adapter emits exactly `started`, two `text_delta`, and one `completed` event; internal reasoning and tool events are not exposed as text.

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- apps/desktop/src/worker/pi-chat-agent.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the Pi adapter with dependency injection**

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export function createPiChatAgent(): ChatAgent {
  return {
    async run(request, emit, signal) {
      const models = createModels();
      models.setProvider(deepseekProvider());
      const model = models.getModel("deepseek", request.modelId);
      if (!model) throw new Error(`DeepSeek model not found: ${request.modelId}`);

      const agent = new Agent({
        initialState: {
          systemPrompt: request.context.systemPrompt,
          model,
          messages: request.context.messages,
          tools: [],
        },
        streamFn: models.streamSimple.bind(models),
        getApiKey: async (provider) => provider === "deepseek" ? request.apiKey : undefined,
        sessionId: request.context.conversationId,
        toolExecution: "sequential",
      });

      let finalText = "";
      const unsubscribe = agent.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          finalText += event.assistantMessageEvent.delta;
          emit({ requestId: request.requestId, type: "text_delta", delta: event.assistantMessageEvent.delta });
        }
      });
      const abort = () => agent.abort();
      signal.addEventListener("abort", abort, { once: true });

      emit({ requestId: request.requestId, type: "started" });
      try {
        await agent.prompt(request.prompt);
        emit({ requestId: request.requestId, type: "completed", text: finalText });
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
  };
}
```

The current prompt travels separately from the immutable prior-message context snapshot. Map only assistant `text_delta` events, and convert thrown provider/abort errors into one schema-valid `failed` event in the worker message loop. The unit test must also assert that `unsubscribe` and the abort listener cleanup execute on both success and failure.

- [ ] **Step 4: Add deterministic fake mode**

`tests/fixtures/fake-agent.ts` emits three timed deltas for `测试回复` and then `completed`. Worker composition selects it only when `DEEPFIELD_AGENT_MODE=fake`; production defaults to Pi. The fake must never accept or log a credential.

- [ ] **Step 5: Add an opt-in real-provider smoke test**

Create a skipped-by-default test guarded by `DEEPSEEK_API_KEY`. It sends “只回复 OK” with no Tools and asserts a non-empty completion. Default `npm test` must not execute network calls.

- [ ] **Step 6: Run tests**

Run: `npm test -- apps/desktop/src/worker/pi-chat-agent.test.ts`

Expected: PASS without `DEEPSEEK_API_KEY`.

- [ ] **Step 7: Commit Pi Chat**

```bash
git add apps/desktop/src/worker/pi-chat-agent.ts apps/desktop/src/worker/pi-chat-agent.test.ts tests/fixtures/fake-agent.ts
git commit -m "feat: stream pure chat through Pi and DeepSeek"
```

---

### Task 6: Project and Chat Application Services

**Files:**
- Create: `packages/application/src/project-service.ts`
- Create: `packages/application/src/context-builder.ts`
- Create: `packages/application/src/chat-service.ts`
- Create: `packages/application/src/index.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `packages/application/src/application.test.ts`

**Interfaces:**
- Consumes: persistence repositories, `SecretStore`, `AgentWorkerClient`, shared contracts.
- Produces: `ProjectService.create(input)`, `ProjectService.list()`, `ContextBuilder.build(projectId)`, and `ChatService.send(projectId, content, onEvent)`.

- [ ] **Step 1: Write the direct-Capability no-Agent test**

```ts
it("creates a direct project without touching the Agent worker", async () => {
  const worker = { send: vi.fn() };
  const service = makeProjectService({ worker });
  const project = await service.create({
    industry: "人形机器人",
    scope: {},
    launchSource: "direct-ui",
  });
  expect(project.industry).toBe("人形机器人");
  expect(worker.send).not.toHaveBeenCalled();
  expect(repos.conversations.listRecent()).toEqual([]);
});
```

`listRecent()` excludes conversations where `has_user_message = 0`.

- [ ] **Step 2: Write the Chat context and persistence test**

Use a fake worker that emits `started`, `text_delta("测试")`, `text_delta("回复")`, and `completed("测试回复")`. Assert:

- the user message is stored before worker invocation;
- the worker receives project industry/scope and recent messages;
- the assistant final is stored exactly once;
- the conversation becomes visible in recent Chat history;
- a `chat.message.completed` normal activity is written.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- packages/application/src/application.test.ts`

Expected: FAIL because services do not exist.

- [ ] **Step 4: Implement `ContextBuilder`**

Build this deterministic system prompt:

```text
你是 Deepfield 的主 Agent。
当前项目：{industry}
项目范围：{scopeJson}
你当前处于普通 Chat，不得声称已经联网搜索或执行行业研究。
需要持久化行业研究时，应建议用户进入“行业研究” Capability。
```

Load at most the 40 newest Chat messages in chronological order. Do not inject silent activity events in this phase.

- [ ] **Step 5: Implement project and Chat services**

`ProjectService.create()` validates input and delegates to the atomic repository method only. `ChatService.send()` must:

1. reject blank content;
2. require a configured DeepSeek key;
3. append the user message and set `has_user_message = 1`;
4. build context from SQLite;
5. send one worker request;
6. forward deltas without persisting partial text;
7. persist the assistant message only on `completed`;
8. emit a structured failure event without inventing an assistant answer.

- [ ] **Step 6: Register typed IPC handlers**

Create exact handlers for the `DesktopApi` methods. Validate Renderer inputs again in main. Maintain a subscription registry by `webContents.id`; remove it when the Renderer is destroyed. Never return the secret value from any handler.

- [ ] **Step 7: Run application and IPC tests**

Run: `npm test -- packages/application/src/application.test.ts apps/desktop/src/main && npm run typecheck`

Expected: PASS; direct project creation records no Agent request.

- [ ] **Step 8: Commit application services**

```bash
git add packages/application apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts
git commit -m "feat: add direct projects and lazy project chat"
```

---

### Task 7: Agent-native Renderer and Adaptive Chat Rail

**Files:**
- Create: `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/app.css`
- Create: `apps/desktop/src/renderer/api.ts`
- Create: `apps/desktop/src/renderer/state/workspace.ts`
- Create: `apps/desktop/src/renderer/components/Sidebar.tsx`
- Create: `apps/desktop/src/renderer/components/Composer.tsx`
- Create: `apps/desktop/src/renderer/components/ChatView.tsx`
- Create: `apps/desktop/src/renderer/components/ChatRail.tsx`
- Create: `apps/desktop/src/renderer/features/projects/ProjectForm.tsx`
- Create: `apps/desktop/src/renderer/features/projects/ProjectWorkspace.tsx`
- Test: `apps/desktop/src/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `DesktopApi`, `Project`, `AgentWorkerEvent`.
- Produces: `WorkspaceState`, direct Capability journey, Chat journey, and docked Chat rail behavior.

- [ ] **Step 1: Write failing layout-state tests**

```tsx
it("opens direct research without a Chat rail", async () => {
  render(<App api={fakeApi()} />);
  await user.click(screen.getByRole("button", { name: "行业研究" }));
  await user.type(screen.getByLabelText("行业名称"), "人形机器人");
  await user.click(screen.getByRole("button", { name: "创建项目" }));
  expect(screen.getByTestId("capability-canvas")).toBeVisible();
  expect(screen.queryByTestId("chat-rail")).not.toBeInTheDocument();
});

it("docks Chat when research is launched from the composer", async () => {
  render(<App api={fakeApi()} />);
  await user.click(screen.getByRole("button", { name: "选择模式" }));
  await user.click(screen.getByRole("option", { name: "行业研究" }));
  expect(screen.getByTestId("capability-canvas")).toBeVisible();
  expect(screen.getByTestId("chat-rail")).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- apps/desktop/src/renderer/App.test.tsx`

Expected: FAIL because Renderer components do not exist.

- [ ] **Step 3: Implement the workspace reducer**

```ts
export type WorkspaceState =
  | { mode: "chat"; projectId?: string }
  | { mode: "capability"; projectId?: string; launchSource: "chat"; chatRail: "open" | "collapsed" }
  | { mode: "capability"; projectId?: string; launchSource: "direct-ui"; chatRail: "hidden" | "open" | "collapsed" };
```

Reducer actions are `OPEN_CHAT`, `OPEN_CAPABILITY_DIRECT`, `OPEN_CAPABILITY_FROM_CHAT`, `OPEN_PROJECT_CHAT`, `COLLAPSE_CHAT`, and `EXPAND_CHAT`. Do not encode workflow steps in this shell reducer.

- [ ] **Step 4: Implement the shell and direct project form**

Use a 240px left navigation, fluid central canvas, and 360px default Chat rail. The direct Capability form requires only industry; scope fields remain optional. After create, render the project title, scope summary, status `项目已创建`, and an `打开项目 Chat` button.

- [ ] **Step 5: Implement streaming Chat**

Subscribe once on mount and unsubscribe on unmount. Correlate events by `requestId`, append deltas only to the active assistant draft, and replace the draft with final text on completion. Disable duplicate send while the current request is active; expose a visible retry message on failure.

- [ ] **Step 6: Add accessibility and visual-state tests**

Assert keyboard access to mode selection, visible focus, labels for form fields, `aria-live="polite"` for streamed output, and a named button for collapsing/expanding Chat. Assert no API key value is rendered.

- [ ] **Step 7: Run component tests and build**

Run: `npm test -- apps/desktop/src/renderer && npm run build`

Expected: PASS; the Renderer build contains no import of `electron`, `node:*`, SQLite, Pi, or secret-store modules.

- [ ] **Step 8: Commit the Agent-native shell**

```bash
git add apps/desktop/src/renderer
git commit -m "feat: add agent-native shell and adaptive chat rail"
```

---

### Task 8: End-to-End Persistence and Apple Silicon Package Smoke Test

**Files:**
- Create: `playwright.config.ts`
- Create: `electron-builder.yml`
- Create: `tests/e2e/foundation.spec.ts`
- Create: `docs/development.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: built Electron app and fake Agent mode.
- Produces: repeatable E2E launch with isolated `userData`, unsigned local arm64 package smoke artifact, and developer setup documentation.

- [ ] **Step 1: Write the failing Electron E2E journey**

Use Playwright’s `_electron.launch` with environment `DEEPFIELD_AGENT_MODE=fake` and a unique `DEEPFIELD_USER_DATA_DIR`. Test:

1. direct “行业研究” entry;
2. create “人形机器人” project;
3. verify Capability canvas and hidden Chat rail;
4. open project Chat and send “你好”;
5. verify streamed fake response “测试回复”;
6. close and relaunch with the same data directory;
7. verify the project still exists and Chat history is visible;
8. launch research from Chat mode and verify the right rail is docked.

- [ ] **Step 2: Run E2E to verify failure**

Run: `npm run build && npm run test:e2e`

Expected: FAIL until Playwright launch configuration and test data-path override are implemented.

- [ ] **Step 3: Add isolated test paths and deterministic startup**

In `paths.ts`, use `DEEPFIELD_USER_DATA_DIR` only when `app.isPackaged === false` or `DEEPFIELD_E2E === "1"`. Create required directories before opening SQLite or secrets. Never accept a data directory from Renderer IPC.

- [ ] **Step 4: Configure arm64 packaging**

```yaml
# electron-builder.yml
appId: com.deepfield.desktop
productName: Deepfield
asar: true
directories:
  output: release
files:
  - out/**
  - package.json
mac:
  target:
    - target: dmg
      arch: [arm64]
    - target: zip
      arch: [arm64]
  category: public.app-category.productivity
artifactName: Deepfield-${version}-${arch}.${ext}
```

Add scripts:

```json
{
  "scripts": {
    "dist:dir": "npm run build && electron-builder --mac --arm64 --dir",
    "dist:local": "npm run build && electron-builder --mac dmg zip --arm64 --config.mac.identity=null"
  }
}
```

`dist:local` is an unsigned development artifact only; signing, notarization and auto-update are Plan 6.

- [ ] **Step 5: Make the E2E test pass**

Run: `DEEPFIELD_E2E=1 npm run test:e2e`

Expected: PASS twice consecutively, proving restart persistence and no duplicate conversation.

- [ ] **Step 6: Run the complete verification set**

Run:

```bash
npm run check
npm run build
DEEPFIELD_E2E=1 npm run test:e2e
npm run dist:dir
file release/mac-arm64/Deepfield.app/Contents/MacOS/Deepfield
```

Expected:

- typecheck and all tests PASS;
- Electron build succeeds;
- E2E passes;
- packaged executable reports `arm64` or `Mach-O 64-bit executable arm64`;
- no real DeepSeek or search request occurs.

- [ ] **Step 7: Document exact local setup**

`docs/development.md` must contain Node 24.18.x, npm install, development launch, fake Agent mode, unit tests, E2E tests, local packaging, data directory and secret-storage behavior. It must explicitly state that the local DMG is unsigned and not a final distribution artifact.

- [ ] **Step 8: Commit the verified vertical slice**

```bash
git add package.json package-lock.json playwright.config.ts electron-builder.yml tests/e2e docs/development.md
git commit -m "test: verify foundation desktop vertical slice"
```

---

## Final Review Gate

Before writing Plan 2, run the complete verification set from Task 8 and review these invariants manually:

- direct Capability creation caused no worker request and no model cost;
- exactly one project conversation exists;
- the conversation is hidden from recent Chat until the first user message;
- Renderer cannot access secrets, SQLite, Node APIs or generic IPC;
- Pi runs in the utility process, not main or Renderer;
- app restart rebuilds Chat context from SQLite;
- direct Capability and Chat-launched Capability produce the specified shell layouts;
- no user-owned architecture image or untracked `.DS_Store` was committed.

Only after this gate passes should `docs/superpowers/plans/2026-08-25-deepfield-tool-platform.md` be written from the validated interfaces.
