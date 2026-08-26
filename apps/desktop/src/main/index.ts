import { app, BrowserWindow, utilityProcess } from "electron";
import { join } from "node:path";
import {
  createAgentWorkerRuntime,
  type AgentWorkerRuntime,
} from "./agent-worker-runtime.js";
import { createWindow } from "./window.js";

let mainWindow: BrowserWindow | undefined;
let agentRuntime: AgentWorkerRuntime | undefined;

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
  startAgentWorker();
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
  agentRuntime?.dispose();
  agentRuntime = undefined;
});
