import { CapabilityRegistry, activateRegisteredCapability } from "./capabilities/registry.js";
import { activate as activateCompanyResearch } from "../../../../capabilities/company-research/main.js";
import { createCompanyResearchWorkerClient } from "../../../../capabilities/company-research/worker-client.js";
import { ConfiguredCompanyRecognizer } from "../../../../capabilities/company-research/application/company-recognizer.js";
import { withUsageContext } from "../shared/usage-collection.js";
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, utilityProcess } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { createUsageRepository } from "@deepfield/persistence";
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
import { ConfiguredLlmService } from "./configured-llm-service.js";
import { FakeCompanyRecognizer } from "../../../../capabilities/company-research/application/fake-company-recognizer.js";
import { loadPiSkillCatalog, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import { PiModelGateway } from "../shared/model-gateway.js";
import { listSearchProviderManifests } from "@deepfield/retrieval";
import { ConfigurationService } from "./configuration-service.js";
import { createCompanyProfileCompleter } from "../../../../capabilities/company-research/application/company-profile-completer.js";

let mainWindow: BrowserWindow | undefined;
let agentRuntime: AgentWorkerRuntime | undefined;
let toolHost: ToolWorkerHost | undefined;
let appRuntime: ApplicationRuntime | undefined;
const capabilities = new CapabilityRegistry();
const configurationListeners = new Set<() => void>();
let ipcDispose: (() => void) | undefined;
let database: ReturnType<typeof openDatabase> | undefined;
let mainSkillCatalog: PiSkillCatalog | undefined;
let usageRuntime: ReturnType<typeof createMainUsageRuntime> | undefined;

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
  const child = utilityProcess.fork(join(__dirname, "agent-worker.js"), [skillsDir], {
    serviceName: "Deepfield Agent",
  });
  let runtimeRef!: AgentWorkerRuntime;
  const host = createToolWorkerHost({
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
  const runtime = createAgentWorkerRuntime(child, { host });
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
  database = openDatabase(paths.database);
  migrate(database);
  usageRuntime = createMainUsageRuntime(createUsageRepository(database));
  configureUsageRecorder(usageRuntime.recorder);
  const repositories = createRepositories(database);
  const secrets = new SecretStore(paths.secretsFile, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const profiles = new ProfileStore(paths.settingsFile, secrets, listSearchProviderManifests());
  await profiles.initialize();
  const modelGateway = new PiModelGateway();
  const configuredLlm = new ConfiguredLlmService(
    () => profiles.resolveActiveLlm(),
    modelGateway,
    { onTitleDiagnostic: ({ category }) => console.warn(`[conversation-title] ${category}`) },
  );
  const configuration = new ConfigurationService(profiles, modelGateway);
  const companyRecognizer =
    process.env.DEEPFIELD_AGENT_MODE === "fake"
      ? new FakeCompanyRecognizer()
      : new ConfiguredCompanyRecognizer(() => profiles.resolveActiveLlm(), modelGateway, withUsageContext);

  const skillsDir = resolveSkillsDir({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });

  agentRuntime = startAgentWorker(repositories, secrets, skillsDir);
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
    repositories,
    profiles,
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
  // Temporary explicit built-in snapshot; Task4 replaces this with the package loader.
  const companyWorker = createCompanyResearchWorkerClient(agentRuntime.client);
  await activateRegisteredCapability({
    registry: capabilities, capabilityId: "company-research",
    activateMain: registrar => activateCompanyResearch(registrar, {
      repositories: {
        capabilityItems: repositories.capabilityItems, companies: repositories.companies,
        itemCompanies: repositories.itemCompanies, companyResearchRuns: repositories.companyResearchRuns,
        companyResearchDiagnostics: repositories.companyResearchDiagnostics, companyResearchBatches: repositories.companyResearchBatches,
        toolExecutions: { deleteByTraceIds: ids => repositories.toolExecutions.deleteByTraceIds(ids) },
        runInTransaction: work => repositories.runInTransaction(work),
      },
      profiles, worker: companyWorker, companyRecognizer,
      companyCompleter: createCompanyProfileCompleter(profiles, companyWorker, diagnostic => repositories.companyProfileDiagnostics.record(diagnostic)),
      requestIdFactory: randomUUID, settings: configuration,
      onConfigurationChanged: listener => { configurationListeners.add(listener); return () => { configurationListeners.delete(listener); }; },
      documentSave: {
        showSaveDialog: options => mainWindow && !mainWindow.isDestroyed() ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options),
        writeFile, rename, unlink, randomToken: randomUUID,
      },
    }),
    activateWorker: () => agentRuntime!.client.activateCapability("company-research", "builtin:company-research", randomUUID()),
    deactivateWorker: () => agentRuntime?.client.deactivateCapability("company-research"),
    onWorkerUnavailable: listener => agentRuntime!.client.subscribeUnavailable(listener),
  }).catch(() => { /* Chat remains available if the optional package fails. */ });
  ipcDispose = registerIpcHandlers({
    capabilities,
    onConfigurationChanged: () => { for (const listener of configurationListeners) listener(); },
    usage: usageRuntime.query,
    ipcMain: ipcMainAdapter,
    clipboard: { writeText: (text) => clipboard.writeText(text) },
    conversations: appRuntime.conversationService,
    settings: configuration,
    skills: { list: () => mainSkillCatalog?.list() ?? [] },
    chat: appRuntime.chatService,
  });

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
      ipcDispose?.(); ipcDispose = undefined;
      void capabilities.dispose();
      void (async () => {
        // Pass the current Worker into the bounded shutdown orchestration so
        // an unacknowledged flush remains visible even if it exits meanwhile.
        await usageRuntime?.shutdown(agentRuntime);
      })().catch(() => {}).finally(() => { usageShutdownComplete = true; app.quit(); });
    }
    return;
  }
  ipcDispose?.();
  ipcDispose = undefined;
  // Order: reject/clean host RPC first, then kill the worker, then close the DB.
  toolHost?.dispose();
  toolHost = undefined;
  agentRuntime?.dispose();
  agentRuntime = undefined;
  void capabilities.dispose();
  appRuntime = undefined;
  if (database) {
    try {
      database.close();
    } catch {
      // already closed
    }
    database = undefined;
  }
});
