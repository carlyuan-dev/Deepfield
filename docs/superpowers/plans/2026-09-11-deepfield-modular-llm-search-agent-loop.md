# Deepfield Modular LLM, Search, and Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DeepSeek-native web search and fixed DeepSeek runtime configuration with user-selectable LLM and Search profiles, then use a request-scoped Agent Loop for web-enabled Chat and first-stage company research.

**Architecture:** Main Process owns validated profile persistence, secrets, active-profile resolution, and draft diagnostics. Each user task receives immutable LLM/Search runtime snapshots. Utility Process turns the LLM snapshot into a Pi model, exposes `web_search` and `fetch_url` only when the caller's access policy permits them, and enforces scenario budgets. The existing two-stage research state machine remains intact: raw research is a multi-turn web Agent run and structuring is a no-tool model call.

**Tech Stack:** TypeScript, TypeBox, Electron Main/Preload/Utility Process, React, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-deepfield-modular-llm-search-agent-loop-design.md`

## Global Constraints

- Work in the existing `codex/tool-platform` checkout. Preserve unrelated user files and never add `docs/material/` or `docs/single-company-key-research-discussion.md` to a commit.
- Optimize for the user's first hand-testable version. Add one representative contract/unit/UI regression for each new boundary; do not build a Cartesian matrix of providers, protocols, failure types, or UI states.
- Run focused tests during Tasks 1–6. Run the full test suite, typecheck, build, and diff check only in Task 7 before handoff.
- There is one active LLM Profile and one active Search Profile. A Profile is one runnable model/provider configuration; do not add provider accounts, model lists, routing, fallback, or automatic provider failover.
- The two supported LLM protocols are exactly `openai_compatible` using Chat Completions/tool calling and `anthropic_messages` using Messages/Tool Use. Do not restore provider-native web search or OpenAI Responses.
- Product Search providers are exactly MetaSo, Baidu, Zhipu, Tavily, and Serper. Brave must not appear in Settings, the production registry, or hand-test instructions. Existing dormant Brave benchmark code may remain.
- Renderer receives `hasCredential`, never a stored plaintext API key. API keys must not enter JSON settings, worker logs, chat/research events, diagnostic errors, or reports.
- Chat/Harness owns network permission. Chat toggle off exposes no network tools; toggle on exposes `web_search` and `fetch_url`. Research raw stage exposes both; research structuring exposes none.
- A Chat send snapshots active LLM and, only when web is enabled, active Search. A complete initial research run snapshots both once and reuses the LLM in both stages. A user-triggered structuring retry is a new task and snapshots only the current LLM.
- Preserve the current research report behavior: original report is the default view, its tab is left of structured report, and the background contains only research topic, research direction, “重点研究范围”, and cutoff date.
- Diagnostics run against the current unsaved form. Editing a relevant field returns the light to idle. UI state is idle/black, running/spinner, success/green, or failure/red. A stale completion must not replace a newer request's result.

---

### Task 1: Profile contracts, presets, and secure persistence

**Files:**
- Create: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `packages/contracts/src/research.ts`
- Modify: `packages/contracts/src/worker.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/main/paths.ts`
- Modify: `apps/desktop/src/main/paths.test.ts`
- Create: `apps/desktop/src/main/profile-store.ts`
- Create: `apps/desktop/src/main/profile-store.test.ts`
- Modify: `apps/desktop/src/main/secret-store-core.ts`
- Modify: `apps/desktop/src/main/secret-store.ts`

**Interfaces:**

```ts
export type LlmProtocol = "openai_compatible" | "anthropic_messages";
export type LlmProviderPresetId = "deepseek" | "qwen" | "openai" | "anthropic" | "custom";
export type SearchProviderId = "metaso" | "baidu" | "zhipu" | "tavily" | "serper";

export interface LlmProfileView {
  id: string;
  name: string;
  provider: LlmProviderPresetId;
  protocol: LlmProtocol;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  hasCredential: boolean;
}

export interface SearchProfileView {
  id: string;
  name: string;
  provider: SearchProviderId;
  baseUrl: string;
  options: Record<string, unknown>;
  hasCredential: boolean;
}

export interface LlmRuntimeSnapshot extends Omit<LlmProfileView, "hasCredential"> {
  apiKey: string;
}

export interface SearchRuntimeSnapshot extends Omit<SearchProfileView, "hasCredential"> {
  apiKey: string;
}

export interface SearchProviderManifest {
  id: SearchProviderId;
  displayName: string;
  defaultBaseUrl: string;
  optionFields: readonly SettingsField[];
  capabilities: {
    timeFilter: "exact_range" | "relative_recency" | "none";
    domainFilter: boolean;
    publishedDate: boolean;
  };
}

export interface ToolAccessPolicy {
  network: "disabled" | "enabled";
  maxAgentTurns: number;
  maxSearchCalls: number;
  maxFetchCalls: number;
}
```

`LlmProfileDraft` and `SearchProfileDraft` carry optional `id` and optional `apiKey`; omitting `apiKey` while editing preserves the saved credential. Persisted profiles replace `hasCredential`/`apiKey` with `credentialRef`. `SettingsView` includes the two profile arrays, their active IDs, and the read-only Search provider manifests used to render draft fields. Add strict TypeBox schemas for every IPC and Worker payload.

- [ ] **Step 1: Add failing profile-store tests**

Cover only these representative cases:

```ts
it("stores non-secret profile data and masks the saved credential in its view", async () => {
  const view = await store.saveLlmProfile({
    name: "DeepSeek Flash",
    provider: "deepseek",
    protocol: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-v4-flash",
    contextWindow: 128_000,
    apiKey: "secret-value",
  });
  expect(view.profiles[0]?.hasCredential).toBe(true);
  expect(await readSettingsFile()).not.toContain("secret-value");
});

it("migrates deepseek.apiKey once when no LLM profile exists", async () => {
  await secrets.set("deepseek.apiKey", "legacy-key");
  await store.initialize();
  await store.initialize();
  expect((await store.getView()).llm.profiles).toHaveLength(1);
});
```

Also assert that deleting the active profile is rejected and that an existing profile keeps its credential when `apiKey` is omitted.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run apps/desktop/src/main/profile-store.test.ts apps/desktop/src/main/paths.test.ts`

Expected: FAIL because settings contracts, `settingsFile`, and `ProfileStore` do not exist.

- [ ] **Step 3: Implement strict contracts and presets**

Define and export:

```ts
export const LLM_PROVIDER_PRESETS = {
  deepseek: { displayName: "DeepSeek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com" },
  qwen: { displayName: "Qwen", protocol: "openai_compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  openai: { displayName: "OpenAI", protocol: "openai_compatible", baseUrl: "https://api.openai.com/v1" },
  anthropic: { displayName: "Anthropic", protocol: "anthropic_messages", baseUrl: "https://api.anthropic.com" },
  custom: { displayName: "Custom", protocol: "openai_compatible", baseUrl: "" },
} as const;
```

Add `AppPaths.settingsFile = join(root, "settings.json")`. Replace literal DeepSeek API-key/model fields in Chat and Research worker requests with `LlmRuntimeSnapshot`, optional `SearchRuntimeSnapshot`, and a required `ToolAccessPolicy`. Do not remove `DEFAULT_DEEPSEEK_MODEL_ID` until all callers have migrated in later tasks.

- [ ] **Step 4: Implement `ProfileStore` and secret deletion**

`ProfileStore` must:

- validate `settings.json` with a strict version-1 schema;
- use temporary-file + rename atomic writes;
- generate IDs with `randomUUID()` in Main;
- store keys under `llm.profile.<id>.apiKey` and `search.profile.<id>.apiKey`;
- use `deepseek.apiKey` as the migrated profile's `credentialRef` instead of copying it;
- resolve active profiles into runtime snapshots only inside Main;
- never import benchmark/search environment credentials;
- expose `getView`, save, activate, delete, `resolveActiveLlm`, and `resolveActiveSearch` methods;
- reject missing active profiles and profiles without credentials with stable domain errors.

Add `SecretStore.delete(name)` so deleting an inactive profile can remove its profile-scoped credential. Do not delete the shared legacy `deepseek.apiKey` during migrated-profile deletion.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run apps/desktop/src/main/profile-store.test.ts apps/desktop/src/main/paths.test.ts apps/desktop/src/main/secret-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the profile boundary**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/index.ts packages/contracts/src/chat.ts packages/contracts/src/research.ts packages/contracts/src/worker.ts packages/contracts/src/ipc.ts apps/desktop/src/main/paths.ts apps/desktop/src/main/paths.test.ts apps/desktop/src/main/profile-store.ts apps/desktop/src/main/profile-store.test.ts apps/desktop/src/main/secret-store-core.ts apps/desktop/src/main/secret-store.ts
git commit -m "feat: add secure model and search profiles"
```

---

### Task 2: Protocol-neutral ModelGateway and configured helper calls

**Files:**
- Create: `apps/desktop/src/shared/model-gateway.ts`
- Create: `apps/desktop/src/shared/model-gateway.test.ts`
- Create: `apps/desktop/src/main/configured-llm-service.ts`
- Create: `apps/desktop/src/main/configured-llm-service.test.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Modify: `apps/desktop/src/main/application-runtime.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Delete: `apps/desktop/src/main/deepseek-service.ts`
- Delete: `apps/desktop/src/main/deepseek-service.test.ts`

**Interfaces:**

```ts
export interface ModelGateway {
  createModel(snapshot: LlmRuntimeSnapshot): Model<any>;
  getApiKey(snapshot: LlmRuntimeSnapshot, providerId: string): Promise<string>;
  completeText(snapshot: LlmRuntimeSnapshot, system: string, prompt: string): Promise<string>;
}
```

The implementation maps `openai_compatible` to `openai-completions` using `openAICompletionsApi`, and `anthropic_messages` to `anthropic-messages` using `anthropicMessagesApi`. Use `createProvider`/`createModels` from `@earendil-works/pi-ai`; do not implement HTTP protocols manually. Use a request-local provider ID derived from the profile ID so concurrently running tasks cannot cross credentials.

- [ ] **Step 1: Add one failing protocol-mapping test and one helper-service test**

The gateway test spies on provider/model construction and verifies both protocol mappings, the editable base URL, model ID, and context window. The helper-service test passes a fake `ModelGateway` and verifies that title generation, company recognition, and company profile completion obtain the current `LlmRuntimeSnapshot` from a supplied resolver.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run apps/desktop/src/shared/model-gateway.test.ts apps/desktop/src/main/configured-llm-service.test.ts`

Expected: FAIL because both modules do not exist.

- [ ] **Step 3: Implement `PiModelGateway`**

Build the Pi `Model` using the snapshot values and conservative defaults:

```ts
{
  id: snapshot.modelId,
  name: snapshot.name,
  provider: requestProviderId,
  baseUrl: snapshot.baseUrl,
  api: snapshot.protocol === "anthropic_messages" ? "anthropic-messages" : "openai-completions",
  reasoning: false,
  input: ["text"],
  contextWindow: snapshot.contextWindow,
  maxTokens: Math.min(8192, Math.max(1024, Math.floor(snapshot.contextWindow / 8))),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
```

`completeText` performs a no-tool call through the same Pi provider/model mapping, collects final assistant text, honors cancellation where the caller supplies a signal, and throws a sanitized error without embedding request headers or keys.

- [ ] **Step 4: Replace `DeepSeekService` with `ConfiguredLlmService`**

Move the existing title/recognition/completion prompts and response parsers into `ConfiguredLlmService`. It takes `resolveActiveLlm(): Promise<LlmRuntimeSnapshot>` and `ModelGateway`; every call resolves the active profile at task start. Preserve existing user-visible fallbacks and JSON parsing behavior.

Wire it in `application-runtime.ts`/`index.ts` as the `ConversationTitleGenerator`, `CompanyRecognizer`, and `CompanyCompleter`. Remove the direct DeepSeek fetch service and its tests.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run apps/desktop/src/shared/model-gateway.test.ts apps/desktop/src/main/configured-llm-service.test.ts apps/desktop/src/main/application-runtime.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit generic model access**

```bash
git add apps/desktop/src/shared/model-gateway.ts apps/desktop/src/shared/model-gateway.test.ts apps/desktop/src/main/configured-llm-service.ts apps/desktop/src/main/configured-llm-service.test.ts apps/desktop/src/main/application-runtime.ts apps/desktop/src/main/application-runtime.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/deepseek-service.ts apps/desktop/src/main/deepseek-service.test.ts
git commit -m "refactor: route llm calls through model profiles"
```

---

### Task 3: Production Search registry, Zhipu adapter, and canonical tool

**Files:**
- Create: `packages/retrieval/src/providers/provider-registry.ts`
- Create: `packages/retrieval/src/providers/provider-registry.test.ts`
- Create: `packages/retrieval/src/providers/zhipu.ts`
- Create: `packages/retrieval/src/providers/zhipu.test.ts`
- Create: `packages/retrieval/src/providers/fixtures/zhipu-success.json`
- Modify: `packages/retrieval/src/providers/provider-catalog.ts`
- Modify: `packages/retrieval/src/providers/provider-catalog.test.ts`
- Modify: `packages/retrieval/src/search-tool.ts`
- Modify: `packages/retrieval/src/search-provider.ts`
- Modify: `packages/retrieval/src/index.ts`
- Modify: `apps/desktop/src/worker/tool-runtime.ts`
- Modify: `apps/desktop/src/worker/tool-runtime.test.ts`
- Modify: `apps/desktop/src/worker/pi-tool-adapter.test.ts`

**Interfaces:**

```ts
export function listSearchProviderManifests(): readonly SearchProviderManifest[];
export function createSearchProvider(snapshot: SearchRuntimeSnapshot): SearchProvider;
```

- [ ] **Step 1: Add failing registry and Zhipu tests**

Assert that the product registry returns exactly `metaso`, `baidu`, `zhipu`, `tavily`, and `serper`, and that each manifest's default URL produces an adapter. Add a single Zhipu success fixture test that verifies:

- `POST <baseUrl>/web_search`;
- `Authorization: Bearer <token>`;
- validated `search_engine` and `search_query` request fields;
- `search_result` maps into normalized title/url/snippet/rank/publishedAt/sourceName.

Do not add live tests or provider-error matrices in this task.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run packages/retrieval/src/providers/provider-registry.test.ts packages/retrieval/src/providers/zhipu.test.ts`

Expected: FAIL because the production registry and Zhipu adapter do not exist.

- [ ] **Step 3: Implement manifests and the factory**

Reuse the existing Baidu, MetaSo, Tavily, and Serper adapters. Add strict option schemas within the registry; unknown options are rejected before adapter construction. Zhipu supports only these engines:

```ts
const ZHIPU_SEARCH_ENGINES = [
  "search_std",
  "search_pro",
  "search_pro_sogou",
  "search_pro_quark",
] as const;
```

Use default base URL `https://open.bigmodel.cn/api/paas/v4` and default engine `search_std`. Keep benchmark/live-acceptance credential assembly separate and unchanged except for any type adjustment required by the expanded shared provider ID. Brave stays benchmark-only/dormant.

- [ ] **Step 4: Rename the model-visible tool and bind request-scoped providers**

Rename the tool definition from `search_web` to `web_search`. Keep the single-query input schema and normalized output.

Add a `SearchSessionRegistry` in `tool-runtime.ts`:

```ts
interface SearchSessionRegistry {
  bind(traceId: string, provider: SearchProvider): void;
  get(traceId: string): SearchProvider;
  release(traceId: string): void;
}
```

Register one `web_search` definition whose executor resolves the provider from the current `traceId`. Extend trace initialization to accept per-request search/fetch limits. Do not implement fallback. Keep tool execution sequential.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/retrieval/src/providers/provider-registry.test.ts packages/retrieval/src/providers/zhipu.test.ts packages/retrieval/src/providers/provider-catalog.test.ts apps/desktop/src/worker/tool-runtime.test.ts apps/desktop/src/worker/pi-tool-adapter.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit production Search adapters**

```bash
git add packages/retrieval/src/providers/provider-registry.ts packages/retrieval/src/providers/provider-registry.test.ts packages/retrieval/src/providers/zhipu.ts packages/retrieval/src/providers/zhipu.test.ts packages/retrieval/src/providers/fixtures/zhipu-success.json packages/retrieval/src/providers/provider-catalog.ts packages/retrieval/src/providers/provider-catalog.test.ts packages/retrieval/src/search-tool.ts packages/retrieval/src/search-provider.ts packages/retrieval/src/index.ts apps/desktop/src/worker/tool-runtime.ts apps/desktop/src/worker/tool-runtime.test.ts apps/desktop/src/worker/pi-tool-adapter.test.ts
git commit -m "feat: add modular production search providers"
```

---

### Task 4: Settings IPC, draft diagnostics, and two-module UI

**Files:**
- Create: `apps/desktop/src/main/configuration-service.ts`
- Create: `apps/desktop/src/main/configuration-service.test.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/ipc.test.ts`
- Modify: `apps/desktop/src/main/ipc-test-helpers.ts`
- Modify: `apps/desktop/src/main/ipc-trusted-adapter.ts`
- Modify: `apps/desktop/src/main/ipc-trusted-adapter.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/preload-api.ts`
- Modify: `apps/desktop/src/preload/preload-api.test.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Rewrite: `apps/desktop/src/renderer/features/settings/SettingsView.tsx`
- Create: `apps/desktop/src/renderer/features/settings/SettingsView.test.tsx`
- Modify: `apps/desktop/src/renderer/App-settings.test.tsx`
- Modify: `apps/desktop/src/renderer/settings.css`

**Desktop API:**

```ts
settings: {
  get(): Promise<SettingsView>;
  saveLlmProfile(input: LlmProfileDraft): Promise<SettingsView>;
  activateLlmProfile(id: string | null): Promise<SettingsView>;
  deleteLlmProfile(id: string): Promise<SettingsView>;
  diagnoseLlm(input: LlmProfileDraft): Promise<DiagnosticResult>;
  saveSearchProfile(input: SearchProfileDraft): Promise<SettingsView>;
  activateSearchProfile(id: string | null): Promise<SettingsView>;
  deleteSearchProfile(id: string): Promise<SettingsView>;
  diagnoseSearch(input: SearchProfileDraft): Promise<DiagnosticResult>;
}
```

`DiagnosticResult` is a strict union:

```ts
type DiagnosticResult =
  | { ok: true; latencyMs: number; summary: string }
  | { ok: false; latencyMs: number; code: "invalid_config" | "unauthorized" | "network" | "provider_error"; message: string };
```

- [ ] **Step 1: Add failing service, preload, and UI tests**

Use representative assertions only:

- LLM draft diagnostics resolve an omitted key from the existing profile and call a minimal no-tool completion without saving the draft.
- Search draft diagnostics create the selected provider and issue one fixed `Deepfield connection test` query with `maxResults: 1`, without saving the draft.
- Preload exposes only the new typed `settings` methods; remove `hasDeepSeekKey`, `setDeepSeekKey`, and separate `llm.checkConnection`.
- Settings renders only `LLM` and `Search` navigation, Provider/Base URL/API Key/model/context fields for LLM, provider-specific fields for Search, and the four diagnostic visual states.
- If two diagnostic promises finish out of order, only the latest request ID updates the UI.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run apps/desktop/src/main/configuration-service.test.ts apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/renderer/features/settings/SettingsView.test.tsx apps/desktop/src/renderer/App-settings.test.tsx`

Expected: FAIL against the legacy DeepSeek-only settings surface.

- [ ] **Step 3: Implement `ConfigurationService` and IPC**

`ConfigurationService` delegates CRUD/activation to `ProfileStore`. Diagnostics merge the unsaved draft with its saved credential when `id` exists; a new profile without a draft key returns `invalid_config`. LLM diagnostics call `ModelGateway.completeText` with a minimal prompt. Search diagnostics use `createSearchProvider`, one real query, and no fallback. Measure elapsed milliseconds and sanitize all errors into the fixed codes/messages.

Register and validate one IPC channel per API method. Update the trusted IPC adapter and preload bridge. Keep raw `credentialRef` and resolved runtime snapshots out of Renderer contracts.

- [ ] **Step 4: Implement the Settings UI**

Build a single Settings surface with exactly two primary modules:

- shared left Profile list and right editor pattern;
- local `Save` and separate `Set active` actions;
- active profile marker and disabled active-profile delete;
- Provider selection auto-fills protocol/base URL only when the user changes the preset; every field remains editable;
- password field shows blank for a saved credential with “已保存” helper text; blank save preserves it;
- Search fields are rendered from `SearchProviderManifest`, not hardcoded per provider in React;
- changing any diagnostic-relevant field resets its result to idle;
- each module owns a monotonically increasing diagnostic request ID.

Use the existing Deepfield visual language and CSS. Do not copy the reference project's global Tour, Save Draft, Apply, Status, Network, Embedding, Capabilities, Memory, MCP, or Tools navigation.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run apps/desktop/src/main/configuration-service.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/renderer/features/settings/SettingsView.test.tsx apps/desktop/src/renderer/App-settings.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Settings and diagnostics**

```bash
git add apps/desktop/src/main/configuration-service.ts apps/desktop/src/main/configuration-service.test.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/ipc-test-helpers.ts apps/desktop/src/main/ipc-trusted-adapter.ts apps/desktop/src/main/ipc-trusted-adapter.test.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/preload-api.ts apps/desktop/src/preload/preload-api.test.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/features/settings/SettingsView.tsx apps/desktop/src/renderer/features/settings/SettingsView.test.tsx apps/desktop/src/renderer/App-settings.test.tsx apps/desktop/src/renderer/settings.css
git commit -m "feat: add modular llm and search settings"
```

---

### Task 5: Request-scoped Chat Agent Loop and network policy

**Files:**
- Modify: `packages/application/src/ports.ts`
- Modify: `packages/application/src/chat-service.ts`
- Modify: `packages/application/src/chat-service.test.ts`
- Modify: `packages/application/src/chat-service-failures.test.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent.test.ts`
- Modify: `apps/desktop/src/worker/pi-chat-agent-test-helpers.ts`
- Modify: `apps/desktop/src/worker/assembly.ts`
- Modify: `apps/desktop/src/worker/assembly.test.ts`
- Modify: `apps/desktop/src/worker/select-chat-agent.ts`
- Modify: `apps/desktop/src/worker/select-chat-agent.test.ts`
- Delete: `apps/desktop/src/worker/deepseek-web-search-agent.ts`
- Delete: `apps/desktop/src/worker/deepseek-web-search-agent.test.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`

**Application ports:**

```ts
export interface RuntimeProfileResolver {
  resolveActiveLlm(): Promise<LlmRuntimeSnapshot>;
  resolveActiveSearch(): Promise<SearchRuntimeSnapshot>;
}
```

**Chat policies:**

```ts
const OFFLINE_CHAT_POLICY = {
  network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0,
} as const;
const WEB_CHAT_POLICY = {
  network: "enabled", maxAgentTurns: 6, maxSearchCalls: 4, maxFetchCalls: 3,
} as const;
```

- [ ] **Step 1: Add failing snapshot and tool-visibility tests**

Verify:

- `ChatService.send` resolves the LLM exactly once per message and Search exactly once only when the submitted Chat mode enables web;
- offline Pi Chat receives no `web_search`/`fetch_url` tool definitions;
- web Pi Chat receives both tools, can perform two model turns around one tool result, and stops at six turns;
- Search/fetch budget exhaustion returns a tool error to the model and permits a final answer from gathered material;
- the legacy native-web agent is never selected.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run packages/application/src/chat-service.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/assembly.test.ts apps/desktop/src/worker/select-chat-agent.test.ts`

Expected: FAIL because Chat still injects a DeepSeek key/model and web mode selects the native Responses agent.

- [ ] **Step 3: Snapshot profiles in `ChatService`**

Replace `SecretReader`/hardcoded model use with `RuntimeProfileResolver`. Resolve immutable snapshots before submitting the Worker request. If no active LLM exists, return a user-actionable configuration error. If web is enabled but no active Search exists, return a user-actionable Search configuration error before starting the worker.

Do not add a second “web model” field. The selected LLM is identical in offline and web Chat; only the tool policy differs.

- [ ] **Step 4: Make Pi Chat protocol-neutral and policy-driven**

Use `ModelGateway.createModel(request.llm)` and a request-scoped `Agent.getApiKey`. Create tool definitions from policy:

```ts
const toolNames = request.toolAccess.network === "enabled"
  ? ["web_search", "fetch_url", ...offlineUtilityTools]
  : offlineUtilityTools;
```

When network is enabled, construct and bind the selected Search provider to the request trace before `Agent.prompt`; initialize the trace ledger with request budgets; always release both in `finally`. Use `shouldStopAfterTurn` to cap the Pi loop at `maxAgentTurns`. On the final allowed turn, prevent further tool execution and request a final answer with available evidence.

Delete the production DeepSeek native-web agent and collapse agent selection to the single Pi path plus existing fake/test paths.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/application/src/chat-service.test.ts packages/application/src/chat-service-failures.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/assembly.test.ts apps/desktop/src/worker/select-chat-agent.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the Chat Agent Loop**

```bash
git add packages/application/src/ports.ts packages/application/src/chat-service.ts packages/application/src/chat-service.test.ts packages/application/src/chat-service-failures.test.ts apps/desktop/src/worker/pi-chat-agent.ts apps/desktop/src/worker/pi-chat-agent.test.ts apps/desktop/src/worker/pi-chat-agent-test-helpers.ts apps/desktop/src/worker/assembly.ts apps/desktop/src/worker/assembly.test.ts apps/desktop/src/worker/select-chat-agent.ts apps/desktop/src/worker/select-chat-agent.test.ts apps/desktop/src/worker/deepseek-web-search-agent.ts apps/desktop/src/worker/deepseek-web-search-agent.test.ts apps/desktop/src/main/application-runtime.ts
git commit -m "feat: run web chat through standard agent tools"
```

---

### Task 6: Two-stage company research on the generic runtime

**Files:**
- Modify: `packages/application/src/company-research-service.ts`
- Modify: `packages/application/src/company-research-service.test.ts`
- Rewrite: `apps/desktop/src/worker/company-research-agent.ts`
- Modify: `apps/desktop/src/worker/company-research-agent.test.ts`
- Modify: `apps/desktop/src/worker/company-research-test-helpers.ts`
- Modify: `apps/desktop/src/worker/company-research-prompt.ts`
- Modify: `apps/desktop/src/worker/company-research-structuring-prompt.ts`
- Modify: `apps/desktop/src/worker/assembly.ts`
- Modify: `apps/desktop/src/main/application-runtime.ts`
- Modify: `apps/desktop/src/renderer/features/industry-research/ResearchReportContext.tsx`
- Modify: `apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`

**Research policies:**

```ts
const RAW_RESEARCH_POLICY = {
  network: "enabled", maxAgentTurns: 12, maxSearchCalls: 8, maxFetchCalls: 8,
} as const;
const STRUCTURE_RESEARCH_POLICY = {
  network: "disabled", maxAgentTurns: 1, maxSearchCalls: 0, maxFetchCalls: 0,
} as const;
```

- [ ] **Step 1: Add failing stage-boundary tests**

Verify:

- starting research resolves LLM and Search once, sends the raw stage with both snapshots, then sends the structure stage with the same LLM snapshot and no Search snapshot;
- raw research sees `web_search`/`fetch_url` and can loop, while structuring sees no tools;
- raw Markdown is persisted before the structure request starts;
- a user-triggered `retryStructuring` resolves the current LLM once and does not resolve Search;
- rendered background uses exactly 研究主题、研究方向、重点研究范围、截止日期, and original report remains the default left tab.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run packages/application/src/company-research-service.test.ts apps/desktop/src/worker/company-research-agent.test.ts apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`

Expected: FAIL because research still calls DeepSeek Responses directly and embeds native `web_search`.

- [ ] **Step 3: Snapshot profiles at the service boundary**

At initial run start, resolve active LLM and Search once and retain them in the in-memory orchestration context through raw + structure submission. Do not persist secrets or runtime snapshots in `ResearchRun`. Persist the raw report before stage two as the existing state machine requires.

At user retry, resolve current active LLM only and send `STRUCTURE_RESEARCH_POLICY`. Preserve raw report and existing structure-failure behavior.

- [ ] **Step 4: Rebuild research agents using Pi and standard tools**

Raw research uses the same generic Pi model/tool assembly as Chat, with the research system prompt, `RAW_RESEARCH_POLICY`, and actor `capability`. Keep the prompt requirement to search more than once when needed, open relevant pages with `fetch_url`, include direct URLs, and finish within budget.

Structuring uses `ModelGateway.completeText` or a one-turn no-tool Pi agent with the existing strict structuring prompt and Harness validation. It must never receive a Search snapshot or network tool definitions. Remove direct requests to `https://api.deepseek.com/responses` and all built-in web-search payloads.

- [ ] **Step 5: Keep report-view regressions explicit**

Ensure the background renderer displays only:

```text
研究主题
研究方向
重点研究范围
截止日期
```

Do not show company aliases, stock codes, source metadata, template version, or Harness version in that block. Preserve the original-report-first view and left/right tab order.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run packages/application/src/company-research-service.test.ts apps/desktop/src/worker/company-research-agent.test.ts apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit generic company research**

```bash
git add packages/application/src/company-research-service.ts packages/application/src/company-research-service.test.ts apps/desktop/src/worker/company-research-agent.ts apps/desktop/src/worker/company-research-agent.test.ts apps/desktop/src/worker/company-research-test-helpers.ts apps/desktop/src/worker/company-research-prompt.ts apps/desktop/src/worker/company-research-structuring-prompt.ts apps/desktop/src/worker/assembly.ts apps/desktop/src/main/application-runtime.ts apps/desktop/src/renderer/features/industry-research/ResearchReportContext.tsx apps/desktop/src/renderer/features/industry-research/CompanyResearchPanel.test.tsx
git commit -m "feat: run company research through standard web tools"
```

---

### Task 7: Focused integration verification and hand-test startup

**Files:**
- Create: `docs/manual-tests/2026-09-11-modular-llm-search-smoke.md`

If an integration command reveals a defect, return to the responsible Task 1–6 boundary,
add a focused regression to that task's named test file, fix only that task's named source
files, rerun its focused command, and make a separate `fix:` commit with those explicit
paths before continuing Task 7.

- [ ] **Step 1: Scan out deprecated production paths**

Run:

```bash
rg 'deepseek-web-search-agent|api\.deepseek\.com/responses|web_search_20250305|hasDeepSeekKey|setDeepSeekKey|llm\.checkConnection|search_web' apps packages --glob '!**/*.snap'
```

Expected: no production matches. A dormant benchmark filename or historical test fixture is acceptable only if it is unreachable from Settings and Worker assembly.

- [ ] **Step 2: Verify focused integration suites**

Run:

```bash
npx vitest run apps/desktop/src/main/profile-store.test.ts apps/desktop/src/main/configuration-service.test.ts apps/desktop/src/renderer/features/settings/SettingsView.test.tsx packages/application/src/chat-service.test.ts apps/desktop/src/worker/pi-chat-agent.test.ts packages/application/src/company-research-service.test.ts apps/desktop/src/worker/company-research-agent.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the final project checks once**

Run:

```bash
npm run typecheck
npm test -- --maxWorkers=1
npm run build
git diff --check
```

Expected: all commands exit 0. Do not add extra stress/permutation suites unless one of these checks reveals a concrete regression.

- [ ] **Step 4: Write the concise manual smoke checklist**

The checklist must ask the user to verify:

1. migrate/use DeepSeek LLM, edit it, diagnose unsaved draft, save, and activate;
2. create one Anthropic-protocol or Qwen OpenAI-compatible LLM profile and diagnose it;
3. create and diagnose each of MetaSo, Baidu, Zhipu, Tavily, and Serper Search profiles;
4. Chat with web off: no search activity; Chat with web on: visible multiple search/fetch tool activity and linked answer;
5. company research: raw report succeeds with links, opens by default, and structuring follows without additional web calls;
6. change the active profile and confirm only the next new task uses it.

Do not include Brave or native-model search in this checklist.

- [ ] **Step 5: Commit the checklist**

```bash
git add docs/manual-tests/2026-09-11-modular-llm-search-smoke.md
git commit -m "test: verify modular llm and search flow"
```

- [ ] **Step 6: Start the development build for hand testing**

Run `npm run dev` in a persistent terminal session. Wait until the Renderer and Electron Main report ready, then provide the session ID and any non-fatal startup warnings. Do not stop the process before user hand testing unless startup fails.

## Completion Criteria

- Settings has exactly LLM and Search modules, both with multi-profile CRUD, one active profile, preset-filled editable connection fields, secure credential handling, and unsaved-draft diagnostics.
- OpenAI-compatible and Anthropic Messages LLM profiles reach the same runtime gateway.
- MetaSo, Baidu, Zhipu, Tavily, and Serper are production-selectable Search providers; no automatic fallback exists.
- Chat network permission follows the Chat web toggle and uses only Deepfield `web_search`/`fetch_url` tools.
- Company research raw stage uses the bounded web Agent Loop; structuring is no-tool and preserves the approved report UI/state behavior.
- All auxiliary production LLM calls use the active LLM Profile.
- Full tests, typecheck, build, and diff check pass; the dev app remains running for user hand testing.
