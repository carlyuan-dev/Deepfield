import { Type } from "typebox";
import { Value } from "typebox/value";
import { ViewOpenResultSchema } from "@deepfield/capability-sdk";
import { AppError, appResult } from "@deepfield/contracts";
import type { IpcMainLike } from "../ipc.js";
import { IPC_CHANNELS } from "../../preload/preload-api.js";
import type { ViewNavigation } from "./view-navigation.js";

/** Only register on the top-frame trusted-window adapter. No renderer open RPC. */
export function registerNavigationIpc(ipc: IpcMainLike, navigation: ViewNavigation): () => void {
  const subscriptions = new Map<number, () => void>();
  const remove = (id: number) => { subscriptions.get(id)?.(); subscriptions.delete(id); };
  ipc.handle(IPC_CHANNELS.navigationSubscribe, (event, ...args) => {
    if (args.length) throw new AppError("INPUT.INVALID");
    remove(event.sender.id);
    const sender = event.sender;
    const detach = navigation.attach(sender.id, value => sender.send(IPC_CHANNELS.navigationEvents, value));
    const destroyed = () => remove(sender.id);
    sender.on("destroyed", destroyed);
    subscriptions.set(sender.id, () => { detach(); sender.removeListener("destroyed", destroyed); });
  });
  ipc.handle(IPC_CHANNELS.navigationUnsubscribe, (event, ...args) => {
    if (args.length) throw new AppError("INPUT.INVALID");
    remove(event.sender.id);
  });
  ipc.handle(IPC_CHANNELS.navigationAck, (event, ...args) => appResult(async () => {
    if (!Value.Check(Type.Tuple([Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), ViewOpenResultSchema]), args)) throw new AppError("INPUT.INVALID");
    return navigation.ack(event.sender.id, args[0], args[1], args[2]);
  }));
  ipc.handle(IPC_CHANNELS.navigationRetry, (event, ...args) => appResult(async () => {
    if (!Value.Check(Type.Tuple([Type.String({ minLength: 1 })]), args)) throw new AppError("INPUT.INVALID");
    return navigation.retry(event.sender.id, args[0]);
  }));
  ipc.handle(IPC_CHANNELS.navigationManual, (_event, ...args) => appResult(() => {
    if (args.length) throw new AppError("INPUT.INVALID");
    navigation.noteManualNavigation(); return null;
  }));
  return () => {
    for (const id of subscriptions.keys()) remove(id);
    for (const channel of [IPC_CHANNELS.navigationSubscribe, IPC_CHANNELS.navigationUnsubscribe, IPC_CHANNELS.navigationAck, IPC_CHANNELS.navigationRetry, IPC_CHANNELS.navigationManual]) ipc.removeHandler(channel);
  };
}
