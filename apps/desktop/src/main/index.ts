import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
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
import { DeepSeekService } from "./deepseek-service.js";
import { FakeCompanyRecognizer } from "./fake-company-recognizer.js";
import { loadPiSkillCatalog, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";

let mainWindow: BrowserWindow | undefined;
let agentRuntime: AgentWorkerRuntime | undefined;
let toolHost: ToolWorkerHost | undefined;
let appRuntime: ApplicationRuntime | undefined;
let ipcDispose: (() => void) | undefined;
let database: ReturnType<typeof openDatabase> | undefined;
let mainSkillCatalog: PiSkillCatalog | undefined;

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
  const repositories = createRepositories(database);
  const secrets = new SecretStore(paths.secretsFile, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const deepSeekService = new DeepSeekService(secrets, {
    enabled: process.env.DEEPFIELD_AGENT_MODE !== "fake",
  });
  const companyRecognizer =
    process.env.DEEPFIELD_AGENT_MODE === "fake"
      ? new FakeCompanyRecognizer()
      : deepSeekService;

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
    secrets,
    worker: {
      send: (request) => {
        const client = agentRuntime?.client;
        if (!client) {
          throw new Error("agent worker is not available");
        }
        return client.send(request);
      },
      sendResearch: (request) => {
        const client = agentRuntime?.client;
        if (!client) throw new Error("agent worker is not available");
        return client.sendResearch(request);
      },
      cancelResearch: (requestId, runId, stage) => {
        const client = agentRuntime?.client;
        if (!client) throw new Error("agent worker is not available");
        client.cancelResearch(requestId, runId, stage);
      },
    },
    titleGenerator: deepSeekService,
    companyRecognizer,
    companyCompleter: deepSeekService,
  });
  appRuntime.companyResearch.cleanupAbandoned();
  appRuntime.companyProfiles.resume();
  ipcDispose = registerIpcHandlers({
    ipcMain: ipcMainAdapter,
    conversations: appRuntime.conversationService,
    industryResearch: appRuntime.industryResearch,
    settings: secrets,
    llm: deepSeekService,
    skills: { list: () => mainSkillCatalog?.list() ?? [] },
    chat: appRuntime.chatService,
    companyResearch: appRuntime.companyResearch,
    companyProfiles: appRuntime.companyProfiles,
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

app.on("before-quit", () => {
  ipcDispose?.();
  ipcDispose = undefined;
  // Order: reject/clean host RPC first, then kill the worker, then close the DB.
  toolHost?.dispose();
  toolHost = undefined;
  agentRuntime?.dispose();
  agentRuntime = undefined;
  appRuntime?.companyProfiles.dispose();
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
