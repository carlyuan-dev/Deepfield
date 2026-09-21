import { CapabilityCallSchema } from "@deepfield/capability-sdk";
import { Value } from "typebox/value";
import { AppError, appResult } from "@deepfield/contracts";
import type { IpcMainLike, WebContentsLike } from "../ipc.js";
import { IPC_CHANNELS } from "../../preload/preload-api.js";
import type { CapabilityRegistry } from "./registry.js";

/** Must receive the same trusted-window adapter as all other application IPC. */
export function registerCapabilityIpc(ipc: IpcMainLike, registry: CapabilityRegistry): () => void {
  const subscribers = new Map<number, { sender: WebContentsLike; dispose(): void }>();
  const remove = (id: number) => { const entry = subscribers.get(id); subscribers.delete(id); entry?.dispose(); };
  ipc.handle(IPC_CHANNELS.capabilityInvoke, (_event, ...args) => appResult(async () => {
    if (args.length !== 1 || !Value.Check(CapabilityCallSchema, args[0])) throw new AppError("INPUT.INVALID");
    return registry.call(args[0]);
  }));
  ipc.handle(IPC_CHANNELS.capabilitySubscribe, (event, ...args) => {
    if (args.length) throw new AppError("INPUT.INVALID");
    if (subscribers.has(event.sender.id)) return;
    const sender = event.sender;
    const destroyed = () => remove(sender.id);
    const unsubscribe = registry.subscribe(value => { try { sender.send(IPC_CHANNELS.capabilityEvents, value); } catch { remove(sender.id); } });
    sender.on("destroyed", destroyed);
    subscribers.set(sender.id, { sender, dispose: () => { unsubscribe(); sender.removeListener("destroyed", destroyed); } });
  });
  ipc.handle(IPC_CHANNELS.capabilityUnsubscribe, (event, ...args) => {
    if (args.length) throw new AppError("INPUT.INVALID"); remove(event.sender.id);
  });
  return () => {
    for (const id of subscribers.keys()) remove(id);
    for (const channel of [IPC_CHANNELS.capabilityInvoke, IPC_CHANNELS.capabilitySubscribe, IPC_CHANNELS.capabilityUnsubscribe]) ipc.removeHandler(channel);
  };
}
