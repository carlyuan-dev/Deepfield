import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppError, appResult } from "@deepfield/contracts";
import { DraftRefSchema, ViewRefSchema } from "@deepfield/capability-sdk";
import type { IpcMainLike } from "../ipc.js";
import { IPC_CHANNELS } from "../../preload/preload-api.js";
import type { CapabilityChatHost } from "./chat-host.js";

/** Trusted-window renderer bridge for task cards and real human confirmation. */
export function registerCapabilityChatIpc(ipc: IpcMainLike, host: CapabilityChatHost,
  taskChanged: (conversationId: string) => void): () => void {
  const senders = new Map<number, { send(channel: string, payload: unknown): void }>();
  const remove = host.onTasks(conversationId => {
    taskChanged(conversationId);
    for (const sender of senders.values()) { try { sender.send(IPC_CHANNELS.chatCapabilityEvents, conversationId); } catch { /* window closed */ } }
  });
  const removeStream = host.onAutoEvents((conversationId, event) => {
    for (const sender of senders.values()) { try { sender.send(IPC_CHANNELS.chatCapabilityStream, { conversationId, event }); } catch { /* window closed */ } }
  });
  const one = Type.Tuple([Type.String({ minLength: 1 })]);
  ipc.handle(IPC_CHANNELS.chatCapabilitySubscribe, (event, ...args) => {
    if (args.length) throw new AppError("INPUT.INVALID");
    senders.set(event.sender.id, event.sender);
  });
  ipc.handle(IPC_CHANNELS.chatCapabilityUnsubscribe, (event, ...args) => {
    if (args.length) throw new AppError("INPUT.INVALID");
    senders.delete(event.sender.id);
  });
  ipc.handle(IPC_CHANNELS.chatCapabilityActive, (_event, ...args) => appResult(() => {
    if (!Value.Check(one, args)) throw new AppError("INPUT.INVALID");
    host.setActiveConversation(args[0]); return null;
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityTasks, (_event, ...args) => appResult(() => {
    if (!Value.Check(one, args)) throw new AppError("INPUT.INVALID");
    return host.tasks(args[0]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityConfirmations, (_event, ...args) => appResult(() => {
    if (!Value.Check(one, args)) throw new AppError("INPUT.INVALID");
    return host.pendingConfirmations(args[0]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityOperations, (_event, ...args) => appResult(() => {
    if (!Value.Check(one, args)) throw new AppError("INPUT.INVALID");
    return host.operations(args[0]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityViews, (_event, ...args) => appResult(() => {
    if (!Value.Check(one, args)) throw new AppError("INPUT.INVALID");
    return host.views(args[0]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityApprove, (_event, ...args) => appResult(async () => {
    if (!Value.Check(Type.Tuple([Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), Type.Boolean()]), args)) throw new AppError("INPUT.INVALID");
    return host.approve(args[1], args[0], args[2]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityDismiss, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([Type.String({ minLength: 1 }), Type.String({ minLength: 1 })]), args)) throw new AppError("INPUT.INVALID");
    return host.dismiss(args[1], args[0]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityOpen, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([Type.String({ minLength: 1 }), Type.Unknown()]), args)
      || (!Value.Check(ViewRefSchema, args[1]) && !Value.Check(DraftRefSchema, args[1]))) throw new AppError("INPUT.INVALID");
    return host.openForConversation(args[0], args[1]);
  }));
  ipc.handle(IPC_CHANNELS.chatCapabilityAnalyze, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), Type.Boolean()]), args)) throw new AppError("INPUT.INVALID");
    return host.chooseAnalysis(args[0], args[1], args[2], args[3]);
  }));
  return () => {
    remove(); removeStream(); senders.clear();
    for (const channel of [IPC_CHANNELS.chatCapabilitySubscribe, IPC_CHANNELS.chatCapabilityUnsubscribe,
      IPC_CHANNELS.chatCapabilityActive, IPC_CHANNELS.chatCapabilityTasks, IPC_CHANNELS.chatCapabilityConfirmations, IPC_CHANNELS.chatCapabilityOperations,
      IPC_CHANNELS.chatCapabilityViews, IPC_CHANNELS.chatCapabilityApprove, IPC_CHANNELS.chatCapabilityDismiss,
      IPC_CHANNELS.chatCapabilityOpen, IPC_CHANNELS.chatCapabilityAnalyze]) ipc.removeHandler(channel);
  };
}
