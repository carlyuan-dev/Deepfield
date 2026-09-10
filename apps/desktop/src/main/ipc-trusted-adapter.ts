import type { IpcEventLike, IpcMainLike, WebContentsLike } from "./ipc.js";
import { isAllowedNavigation } from "./navigation.js";

export interface RendererWebContentsLike extends WebContentsLike {
  mainFrame: { url: string };
  isDestroyed(): boolean;
}

export interface RendererIpcEventLike extends IpcEventLike {
  sender: RendererWebContentsLike;
  senderFrame: { url: string } | null;
}

interface RendererIpcMainLike {
  handle(channel: string, listener: (event: RendererIpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export function createTrustedIpcMainAdapter(
  ipcMain: RendererIpcMainLike,
  getTrustedSender: () => RendererWebContentsLike | undefined,
  rendererUrl: string,
): IpcMainLike {
  return {
    handle: (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
      let trusted = false;
      try {
        const sender = getTrustedSender();
        trusted = sender !== undefined &&
          event.sender === sender &&
          !sender.isDestroyed() &&
          event.senderFrame !== null &&
          event.senderFrame === sender.mainFrame &&
          rendererUrl.length > 0 &&
          isAllowedNavigation(rendererUrl, event.senderFrame.url);
      } catch {
        // A destroyed/detached Electron object must also fail closed.
      }
      if (!trusted) throw new Error("untrusted IPC sender");
      return listener(event, ...args);
    }),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  };
}
