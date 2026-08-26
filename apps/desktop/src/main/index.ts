import { app, BrowserWindow, utilityProcess } from "electron";
import { join } from "node:path";
import { AgentWorkerClient, type MessageEndpoint } from "./agent-worker-client.js";
import { createWindow } from "./window.js";

let mainWindow: BrowserWindow | undefined;
let workerClient: AgentWorkerClient | undefined;

function startAgentWorker(): AgentWorkerClient {
  const child = utilityProcess.fork(join(__dirname, "agent-worker.js"), [], {
    serviceName: "Deepfield Agent",
  });
  const endpoint: MessageEndpoint = {
    postMessage: (value) => child.postMessage(value),
    onMessage: (listener) => {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onExit: (listener) => {
      child.on("exit", listener);
      return () => {
        child.off("exit", listener);
      };
    },
  };
  return new AgentWorkerClient(endpoint);
}

void app.whenReady().then(() => {
  workerClient = startAgentWorker();
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
  workerClient?.dispose();
  workerClient = undefined;
});
