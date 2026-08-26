import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } from "electron";
import { join } from "node:path";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { createAppPaths, resolveUserDataRoot } from "./paths.js";
import { SecretStore } from "./secret-store.js";
import { createAgentWorkerRuntime, type AgentWorkerRuntime } from "./agent-worker-runtime.js";
import {
  createApplicationRuntime,
  type ApplicationRuntime,
} from "./application-runtime.js";
import { registerIpcHandlers, type IpcMainLike } from "./ipc.js";
import { createWindow } from "./window.js";

let mainWindow: BrowserWindow | undefined;
let agentRuntime: AgentWorkerRuntime | undefined;
let appRuntime: ApplicationRuntime | undefined;
let ipcDispose: (() => void) | undefined;
let database: ReturnType<typeof openDatabase> | undefined;

const ipcMainAdapter: IpcMainLike = {
  handle: (channel, listener) => ipcMain.handle(channel, listener),
  removeHandler: (channel) => ipcMain.removeHandler(channel),
};

function startAgentWorker(): AgentWorkerRuntime {
  const child = utilityProcess.fork(join(__dirname, "agent-worker.js"), [], {
    serviceName: "Deepfield Agent",
  });
  const runtime = createAgentWorkerRuntime(child);
  child.on("exit", () => {
    if (agentRuntime === runtime) {
      agentRuntime = undefined;
    }
  });
  agentRuntime = runtime;
  return runtime;
}

void app.whenReady().then(() => {
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

  agentRuntime = startAgentWorker();
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
    },
  });
  ipcDispose = registerIpcHandlers({
    ipcMain: ipcMainAdapter,
    projects: appRuntime.projectService,
    settings: secrets,
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

app.on("before-quit", () => {
  ipcDispose?.();
  ipcDispose = undefined;
  agentRuntime?.dispose();
  agentRuntime = undefined;
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
