import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppError, appResult, CHAT_INTERACTION_CHANNELS as channels, RespondCommandSchema } from "@deepfield/contracts";
import type { IpcMainLike } from "../ipc.js";
import type { ChatInteractionHost } from "./interaction-host.js";

/** ipcMainAdapter has verified the actual window; the caller never supplies response source. */
export function registerChatInteractionIpc(ipc: IpcMainLike, host: ChatInteractionHost): () => void {
  const senders = new Map<number, { send(channel: string, payload: unknown): void }>();
  const id = Type.String({ minLength: 1 }); const revision = Type.Integer({ minimum: 1 });
  const remove = host.onChanged(conversationId => {
    for (const sender of senders.values()) { try { sender.send(channels.events, conversationId); } catch { /* closed */ } }
  });
  ipc.handle(channels.subscribe, (event, ...args) => { if (args.length) throw new AppError("INPUT.INVALID"); senders.set(event.sender.id, event.sender); });
  ipc.handle(channels.unsubscribe, (event, ...args) => { if (args.length) throw new AppError("INPUT.INVALID"); senders.delete(event.sender.id); });
  ipc.handle(channels.list, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id]), args)) throw new AppError("INPUT.INVALID"); return host.list(args[0]);
  }));
  for (const [channel, source] of [[channels.respond, "chat_button"], [channels.editorRespond, "form_button"]] as const) {
    ipc.handle(channel, (_event, ...args) => appResult(async () => {
      if (!Value.Check(Type.Tuple([id, RespondCommandSchema]), args)) throw new AppError("INPUT.INVALID");
      if (source === "form_button") await host.readEditor(args[0], args[1].interactionId);
      return host.respond(args[0], args[1], source);
    }));
  }
  ipc.handle(channels.editorRead, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id, id]), args)) throw new AppError("INPUT.INVALID"); return host.readEditor(args[0], args[1]);
  }));
  ipc.handle(channels.editorAutoOpen, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id, id]), args)) throw new AppError("INPUT.INVALID"); return host.autoOpenEditor(args[0], args[1]);
  }));
  ipc.handle(channels.editorOpen, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id, id]), args)) throw new AppError("INPUT.INVALID"); return host.openEditorManually(args[0], args[1]);
  }));
  ipc.handle(channels.editorBegin, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id, id, revision]), args)) throw new AppError("INPUT.INVALID"); return host.beginEdit(args[0], args[1], args[2]);
  }));
  ipc.handle(channels.editorUpdate, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id, id, revision, Type.Unknown()]), args)) throw new AppError("INPUT.INVALID"); return host.updateEditor(args[0], args[1], args[2], args[3]);
  }));
  ipc.handle(channels.editorTransition, (_event, ...args) => appResult(() => {
    if (!Value.Check(Type.Tuple([id, id, revision, id]), args)) throw new AppError("INPUT.INVALID"); return host.updateEditor(args[0], args[1], args[2], undefined, args[3]);
  }));
  return () => { remove(); senders.clear(); for (const channel of Object.values(channels)) if (channel !== channels.events) ipc.removeHandler(channel); };
}
