import { createSqliteMemory } from "@deepfield/base/memory/sqlite";
import { ChatMemoryHost } from "./memory/host.js";
import { memoryPolicyDefinition } from "./memory/policy.js";
import { registerMemoryIpc } from "./memory/ipc.js";
import { createMemoryLearning } from "./memory/learning.js";
import { createCapabilityMemoryService } from "./memory/capability-service.js";
import { MEMORY_CHANNELS } from "@deepfield/contracts";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { registerNavigationIpc } from "./capabilities/navigation-ipc.js";
import { createCapabilityHostServices } from "@deepfield/capability-sdk";
import { capabilityPaths } from "./capabilities/installation.js";
import { prepareCapabilities, createCapabilityRuntime, type CapabilityRuntime } from "./capabilities/runtime.js";
import type { TrustedCapabilityEntry } from "../shared/capability-entry.js";
import { withUsageContext } from "../shared/usage-collection.js";
import { configureTraceCollector, createTraceCollector, createTracePort, configureTraceLookup, createTraceContentCollector, configureTraceContent } from "@deepfield/base/trace/runtime";
import { openTraceContentStore } from "./trace-content-store.js";
import { traceContentPolicyFromEnvironment } from "../shared/trace-content.js";
import { openTraceStore } from "./trace-store.js";
import { createHash, randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, utilityProcess, protocol } from "electron";
import { registerCapabilityManagementIpc } from "./capabilities/management-ipc.js";
import { createCapabilityResourceHandler } from "./capabilities/resource-handler.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRepositories, migrate } from "@deepfield/persistence";
import { openDatabase } from "@deepfield/base/database/runtime";
import { createUsageRepository } from "@deepfield/base/usage/sqlite";
import { createMainUsageRuntime } from "./usage-runtime.js";
import { configureUsageRecorder } from "../shared/usage-collection.js";
import type { Repositories } from "@deepfield/persistence";
import { SqliteToolAudit } from "@deepfield/application";
import { createAppPaths, resolveUserDataRoot } from "./paths.js";
import { SecretStore } from "./secret-store.js";
import { createAgentWorkerRuntime, type AgentWorkerRuntime } from "./agent-worker-runtime.js";
import { createToolWorkerHost, type ToolWorkerHost } from "./tool-worker-host.js";
import {
  createApplicationRuntime,
  type ApplicationRuntime,
} from "./application-runtime.js";
import { registerIpcHandlers } from "./ipc.js";
import { createTrustedIpcMainAdapter } from "./ipc-trusted-adapter.js";
import { createWindow } from "./window.js";
import { resolveSkillsDir } from "./skill-paths.js";
import { ProfileStore } from "./profile-store.js";
import { createConfigRuntime } from "@deepfield/base/config/runtime";
import { createScopedConfigFileStore } from "./config-file-store.js";
import { ConfiguredLlmService } from "./configured-llm-service.js";
import { loadPiSkillCatalog, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import { PiModelGateway } from "../shared/model-gateway.js";
import { listSearchProviderManifests } from "@deepfield/base/config";
import { ConfigurationService } from "./configuration-service.js";
import { CapabilityChatHost } from "./capabilities/chat-host.js";
import { ChatInteractionHost } from "./chat/interaction-host.js";
import { InteractionResponseClassifier } from "./chat/response-intent.js";
import { registerChatInteractionIpc } from "./chat/interaction-ipc.js";
import { registerCapabilityChatIpc } from "./capabilities/chat-ipc.js";
import { availableChatTools } from "../worker/tools/tool-runtime.js";

protocol.registerSchemesAsPrivileged([{ scheme: "deepfield-capability", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.platform === "darwin" && process.env.DEEPFIELD_E2E === "1" && process.env.DEEPFIELD_E2E_BACKGROUND === "1") {
  app.setActivationPolicy("prohibited");
}

let memoryHost: ChatMemoryHost | undefined;
let mainWindow: BrowserWindow | undefined;
let agentRuntime: AgentWorkerRuntime | undefined;
let toolHost: ToolWorkerHost | undefined;
let appRuntime: ApplicationRuntime | undefined;
const capabilities = new CapabilityRegistry();
let capabilityRuntime: CapabilityRuntime | undefined;
let chatHost: CapabilityChatHost | undefined;
let interactionHost: ChatInteractionHost | undefined;
let capabilitySnapshot: readonly TrustedCapabilityEntry[] = Object.freeze([]);
const configurationListeners = new Set<() => void>();
let ipcDispose: (() => void) | undefined;
let database: ReturnType<typeof openDatabase> | undefined;
let mainSkillCatalog: PiSkillCatalog | undefined;
let usageRuntime: ReturnType<typeof createMainUsageRuntime> | undefined;
let traceStore: ReturnType<typeof openTraceStore> | undefined;
let contentStore: ReturnType<typeof openTraceContentStore> | undefined;
let contentCollector: ReturnType<typeof createTraceContentCollector> | undefined;
const contentModeFor = traceContentPolicyFromEnvironment(process.env.DEEPFIELD_TRACE_CONTENT_POLICY);
let traceCollector: ReturnType<typeof createTraceCollector> | undefined;

const ipcMainAdapter = createTrustedIpcMainAdapter(
  ipcMain,
  () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined,
  process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, "../renderer/index.html")).href,
);

function startAgentWorker(
  repositories: Repositories,
  secrets: SecretStore,
  skillsDir: string,
): AgentWorkerRuntime {
  const child = utilityProcess.fork(join(__dirname, "agent-worker.js"), [skillsDir, JSON.stringify(capabilitySnapshot)], {
    serviceName: "Deepfield Agent",
  });
  let runtimeRef!: AgentWorkerRuntime;
  const host = createToolWorkerHost({
    memory: { call: (id, call, command) => memoryHost?.call(id, call, command) ?? Promise.resolve({ status: "unavailable" }) },
    chatInteraction: { call: (requestId, toolCallId, operation, args) => {
      if (!interactionHost) return Promise.reject(new Error("Interaction unavailable"));
      return interactionHost.call(requestId, toolCallId, operation, args);
    } },
    capabilityChat: { call: (chatRequestId, toolCallId, operation, args) => chatHost?.call(chatRequestId, toolCallId, operation, args) ?? Promise.resolve({ status: "error", error: { code: "capability_unavailable", message: "capability_unavailable", retryable: false } }) },
    ...(usageRuntime ? { usage: usageRuntime.worker } : {}),
    audit: new SqliteToolAudit(repositories.toolExecutions),
    secrets: { get: (name) => secrets.get(name) },
    conversationRepositories: {
      conversations: repositories.conversations,
      messages: repositories.messages,
    },
    postMessage: (value) => runtimeRef.postMessage(value),
  });
  toolHost = host;
  const runtime = createAgentWorkerRuntime(child, { host, ...(contentStore ? { traceContent: { modeFor: contentModeFor, record: (serialized: string) => contentStore?.record(serialized) ?? false } } : {}), trace: event => traceCollector?.emit(event), traceHealth: health => traceStore?.deliveryHealth("worker", health), onTraceRejected: () => traceCollector?.emit(undefined) });
  runtimeRef = runtime;
  child.on("exit", () => {
    void usageRuntime?.workerExited(!usageShutdownComplete);
    // Unexpected worker exit must also dispose the host so no reply can land
    // on a dead transport or against a closed database.
    toolHost?.dispose();
    toolHost = undefined;
    if (agentRuntime === runtime) {
      agentRuntime = undefined;
    }
  });
  agentRuntime = runtime;
  return runtime;
}

void app.whenReady().then(async () => {
  const userDataRoot = resolveUserDataRoot({
    defaultRoot: app.getPath("userData"),
    override: process.env.DEEPFIELD_USER_DATA_DIR,
    isPackaged: app.isPackaged,
    isE2E: process.env.DEEPFIELD_E2E === "1",
  });
  const paths = createAppPaths(userDataRoot);
  if (process.env.DEEPFIELD_TRACE !== "0" && process.env.DEEPFIELD_TRACE_CONTENT_POLICY) {
    try {
      contentStore = openTraceContentStore(join(userDataRoot, "trace-content.sqlite"));
      contentCollector = createTraceContentCollector(serialized => contentStore?.record(serialized) ?? false);
      configureTraceContent(contentCollector);
    } catch { console.warn("[trace-content] initialization_failed"); }
  }
  database = openDatabase(paths.database);
  if (process.env.DEEPFIELD_TRACE !== "0") {
    try {
      traceStore = openTraceStore(join(userDataRoot, "trace.sqlite"));
      traceCollector = createTraceCollector(event => traceStore?.record(event), { onHealth: health => traceStore?.deliveryHealth("main", health) });
      const metadata = traceCollector;
      configureTraceCollector({ ...metadata, emit(value) {
        const event = value as { type?: string; requestId?: string; rootTraceId?: string } | undefined;
        if (event?.type === "span.start" && event.requestId && event.rootTraceId) {
          const mode = contentModeFor(event.requestId);
          if (mode) contentCollector?.authorize(event.requestId, event.rootTraceId, mode);
        }
        metadata.emit(value);
      } });
      configureTraceLookup(ref => traceStore?.find(ref));
    } catch { console.warn("[trace] initialization_failed"); }
  }
  database.legacy(migrate);
  usageRuntime = createMainUsageRuntime(createUsageRepository(database.database), () => agentRuntime);
  configureUsageRecorder(usageRuntime.recorder);
  const repositories = createRepositories(database.database, { beforeConversationDeleteInTransaction: id => memoryHost?.invalidateConversationInTransaction(id) });
  interactionHost = new ChatInteractionHost(repositories, capabilities, () => capabilityRuntime,
    conversationId => appRuntime?.chatService.interactionChanged(conversationId),
    (owner, invocationId, result, generation) => chatHost?.interactionOutcome(owner, invocationId, result, generation),
    (conversationId, target, generation) => chatHost?.autoOpenEditor(conversationId, target, generation) ?? Promise.resolve({ status: "blocked" }),
    (conversationId, target) => chatHost?.openForConversation(conversationId, target) ?? Promise.resolve({ status: "blocked" }));
  chatHost = new CapabilityChatHost(() => capabilityRuntime, capabilities, repositories, interactionHost);
  const secrets = new SecretStore(paths.secretsFile, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const profiles = new ProfileStore(paths.settingsFile, secrets, listSearchProviderManifests());
  const configRuntime = createConfigRuntime({
    documents: createScopedConfigFileStore(join(userDataRoot, "capability-config")),
    secrets,
    newId: randomUUID,
  });
  await profiles.initialize();
  const modelGateway = new PiModelGateway();
  try {
    const memoryStore = createSqliteMemory({ database: database.scope("base:memory").database });
    memoryHost = new ChatMemoryHost(memoryStore, database.scope("host:chat-memory").database, repositories,
      configRuntime.createScope("chat").service.bind(memoryPolicyDefinition));
    await memoryHost.initialize();
    memoryHost.learning = createMemoryLearning({ host: memoryHost, resolveLlm: () => profiles.resolveActiveLlm(), model: modelGateway, fake: process.env.DEEPFIELD_AGENT_MODE === "fake" });
    memoryHost.subscribe(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(MEMORY_CHANNELS.changed); });
  } catch { memoryHost?.dispose(); memoryHost = undefined; console.warn("[memory] initialization_failed"); }

  const interactionClassifier = new InteractionResponseClassifier(() => profiles.resolveActiveLlm(), modelGateway);
  const configuredLlm = new ConfiguredLlmService(
    () => profiles.resolveActiveLlm(),
    modelGateway,
    { agentMode: process.env.DEEPFIELD_AGENT_MODE, onTitleDiagnostic: ({ category }) => console.warn(`[conversation-title] ${category}`) },
  );
  const configuration = new ConfigurationService(profiles, modelGateway);
  const skillsDir = resolveSkillsDir({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });

  // Finish loading the Main catalog before IPC registration and window
  // creation: the renderer reads skills.list once on mount, so the first call
  // must already see the bundled summary instead of a transient empty list.
  // The Utility Process lazily loads the same directory through its first
  // non-secret worker argument (skillsDir).
  try {
    const { catalog } = await loadPiSkillCatalog(skillsDir);
    mainSkillCatalog = catalog;
  } catch {
    // A missing/unreadable skills directory degrades to an empty skill list
    // without leaking the underlying error to the renderer.
    mainSkillCatalog = undefined;
  }
  appRuntime = createApplicationRuntime({
    ...(memoryHost ? { memory: memoryHost } : {}),
    interactions: interactionHost.coordinator,
    respondToInteraction: (conversationId, command, messageId) => interactionHost!.respond(conversationId, command, "user_message", messageId),
    respondToTask: (conversationId, command, messageId) => interactionHost!.respondToTask(conversationId, command, messageId),
    classifyInteractionResponse: (pending, content, requestId) => interactionHost!.classifyResponse(pending, content, requestId, interactionClassifier),
    onUserMessage: conversationId => interactionHost!.revokeTask(conversationId),
    onTaskStopped: conversationId => interactionHost!.revokeTask(conversationId),
    taskScope: conversationId => interactionHost!.taskScope(conversationId),
    onDispose: () => interactionHost?.dispose(),
    repositories,
    profiles,
    capabilityDirectory: () => chatHost?.directory() ?? [],
    capabilityHelp: () => chatHost?.helpDirectory() ?? [],
    helpTools: webSearch => availableChatTools(webSearch, !!memoryHost),
    onRequestStarted: (requestId, conversationId, prompt, restoredKeys) => { chatHost?.begin(requestId, conversationId, prompt, restoredKeys); interactionHost?.begin(requestId, conversationId); },
    onRequestFinished: requestId => { chatHost?.end(requestId); interactionHost?.end(requestId); },
    onAnalysisChanged: conversationId => chatHost?.announce(conversationId),
    onAutoEvent: (conversationId, event) => chatHost?.emitAuto(conversationId, event),
    isConversationActive: conversationId => chatHost?.isActiveConversation(conversationId) === true,
    worker: {
      send: (request) => {
        const client = agentRuntime?.client;
        if (!client) {
          throw new Error("agent worker is not available");
        }
        return client.send(request);
      },
    },
    titleGenerator: configuredLlm,
  });
  const prepared = await prepareCapabilities(capabilityPaths({ userDataRoot, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }));
  capabilitySnapshot = prepared.workerSnapshot;
  capabilityRuntime = createCapabilityRuntime(prepared, capabilities, undefined, repositories.capabilityInvocations, {
    createConfigScope: capabilityId => configRuntime.createScope(capabilityId),
    databaseOwner: database,
    ...(memoryHost ? { createMemoryScope: (id: string) => createCapabilityMemoryService(memoryHost!.store, memoryHost!.ownerId, id,
      operationKey => memoryHost!.sourceFor(`capability:${createHash("sha256").update(operationKey).digest("hex")}`, "", "", "confirmed"), () => memoryHost!.highWatermark()) } : {}),
  });
  const disposeNavigation = registerNavigationIpc(ipcMainAdapter, capabilityRuntime.navigation);
  agentRuntime = startAgentWorker(repositories, secrets, skillsDir);
  const services = createCapabilityHostServices({
    "trace.v1": createTracePort(),
    "tools.audit.v1": { version: 1, deleteByTraceIds: (ids: readonly string[]) => repositories.toolExecutions.deleteByTraceIds(ids) },
    "model.configuration": {
      profiles: { resolveActiveLlm: () => profiles.resolveActiveLlm(), resolveActiveSearch: () => profiles.resolveActiveSearch() },
      settings: { get: () => configuration.get() },
      onConfigurationChanged: (listener: () => void) => { configurationListeners.add(listener); return () => { configurationListeners.delete(listener); }; },
    },
    "model.execution": { gateway: modelGateway, transport: {
      sendCapability: agentRuntime.client.sendCapability.bind(agentRuntime.client),
      cancelCapability: agentRuntime.client.cancelCapability.bind(agentRuntime.client),
    }, mode: process.env.DEEPFIELD_AGENT_MODE },
    "tools.retrieval": true,
    "usage.context": withUsageContext,
    "document.save": {
      showSaveDialog: (options: Electron.SaveDialogOptions) => mainWindow && !mainWindow.isDestroyed() ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options),
      writeFile, rename, unlink, randomToken: randomUUID,
    },
  });
  await capabilityRuntime.start(agentRuntime.client, services);
  await chatHost.connectTaskProviders();
  await interactionHost.recover();
  const disposeInteractions = registerChatInteractionIpc(ipcMainAdapter, interactionHost);
  appRuntime.chatService.recoverInteractionResumes();
  const disposeChatCapability = registerCapabilityChatIpc(ipcMainAdapter, chatHost,
    conversationId => appRuntime?.chatService.taskChanged(conversationId));
  for (const link of repositories.chatCapabilities.allTasks()) appRuntime.chatService.taskChanged(link.conversationId);
  const disposeManagement = registerCapabilityManagementIpc(ipcMainAdapter, capabilityRuntime, () => {
    app.relaunch();
    setImmediate(() => app.quit());
  });
  protocol.handle("deepfield-capability", createCapabilityResourceHandler(() => capabilityRuntime?.readyEntries().map(entry => ({ id: entry.manifest.id, root: entry.root, state: "ready" })) ?? []));
  const disposeMemory = registerMemoryIpc(ipcMainAdapter, () => memoryHost);
  const disposeApp = registerIpcHandlers({
    beforeConversationDelete: conversationId => interactionHost!.releaseConversation(conversationId),
    capabilities,
    onConfigurationChanged: () => { for (const listener of configurationListeners) listener(); for (const event of repositories.chatInteractions.pendingEvents()) appRuntime?.chatService.interactionChanged(event.conversationId); },
    usage: usageRuntime.query,
    ipcMain: ipcMainAdapter,
    clipboard: { writeText: (text) => clipboard.writeText(text) },
    conversations: appRuntime.conversationService,
    settings: configuration,
    skills: { list: () => mainSkillCatalog?.list() ?? [] },
    chat: appRuntime.chatService,
  });

  ipcDispose = () => { disposeMemory(); disposeInteractions(); disposeChatCapability(); disposeNavigation(); disposeManagement(); disposeApp(); protocol.unhandle("deepfield-capability"); };
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let usageShutdownStarted = false;
let usageShutdownComplete = false;
app.on("before-quit", (event) => {
  if (!usageShutdownComplete && usageRuntime) {
    event.preventDefault();
    if (!usageShutdownStarted) {
      usageShutdownStarted = true;
      memoryHost?.dispose(); memoryHost = undefined;
      ipcDispose?.(); ipcDispose = undefined;
      void (async () => {
        await capabilityRuntime?.dispose();
        // Pass the current Worker into the bounded shutdown orchestration so
        // an unacknowledged flush remains visible even if it exits meanwhile.
        await usageRuntime?.shutdown(agentRuntime);
        await traceCollector?.close();
        await contentCollector?.close();
      })().catch(() => {}).finally(() => { usageShutdownComplete = true; app.quit(); });
    }
    return;
  }
  ipcDispose?.();
  ipcDispose = undefined;
  memoryHost?.dispose(); memoryHost = undefined;
  appRuntime?.chatService.dispose();
  // Order: reject/clean host RPC first, then kill the worker, then close the DB.
  toolHost?.dispose();
  toolHost = undefined;
  chatHost?.dispose();
  chatHost = undefined;
  agentRuntime?.dispose();
  agentRuntime = undefined;
  void capabilityRuntime?.dispose();
  appRuntime = undefined;
  try { traceStore?.close(); } catch { console.warn("[trace] close_failed"); }
  traceStore = undefined;
  try { contentStore?.close(); } catch { console.warn("[trace-content] close_failed"); }
  contentStore = undefined;
  configureTraceContent(undefined);
  configureTraceCollector(undefined);
  configureTraceLookup(undefined);
  if (database) {
    try {
      database.close();
    } catch {
      // already closed
    }
    database = undefined;
  }
});
