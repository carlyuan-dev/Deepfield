import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createPreloadApi, type IpcBridge } from "./preload-api.js";

const ipc: IpcBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const handler = (event: IpcRendererEvent, ...args: unknown[]) => listener(event, ...args);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld("deepfield", createPreloadApi(ipc));
