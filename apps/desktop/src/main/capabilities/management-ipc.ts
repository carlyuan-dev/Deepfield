import { AppError, appResult, CapabilityStatusSchema, CapabilitySetEnabledArgsSchema, safeCapabilityIssue, type CapabilitySnapshot, type ManagedCapability } from "@deepfield/contracts";
import { Value } from "typebox/value";
import type { IpcMainLike } from "../ipc.js";
import { IPC_CHANNELS } from "../../preload/preload-api.js";
import type { CapabilityRuntime } from "./runtime.js";

type ManagementRuntime = Pick<CapabilityRuntime, "list" | "issues" | "subscribe" | "setEnabled">;
/** Caller must supply the application's trusted top-level-window IPC adapter. */
export function registerCapabilityManagementIpc(ipc: IpcMainLike, runtime: ManagementRuntime, requestRestart: () => void): () => void {
  const subscriptions = new Map<number, () => void>();
  let restartRequested = false;
  const snapshot = (): CapabilitySnapshot => {
    // Directory names and caught exceptions never cross the renderer boundary.
    const issues = runtime.issues.map(issue => safeCapabilityIssue(issue.code));
    const packages: ManagedCapability[] = [];
    for (const { issue, ...item } of runtime.list().slice(0, 1000)) {
      const value = { ...item, ...(issue ? { issue: safeCapabilityIssue(issue) } : {}) };
      if (Value.Check(CapabilityStatusSchema, value)) packages.push(value as ManagedCapability);
      else issues.push(safeCapabilityIssue("invalid_manifest"));
    }
    return { packages, issues: issues.slice(0, 1000) };
  };
  const remove = (id: number) => { const dispose = subscriptions.get(id); subscriptions.delete(id); dispose?.(); };
  ipc.handle(IPC_CHANNELS.capabilityManagementList, (_event, ...args) => appResult(async () => {
    if (args.length) throw new AppError("INPUT.INVALID");
    return snapshot();
  }));
  ipc.handle(IPC_CHANNELS.capabilityManagementSetEnabled, (_event, ...args) => appResult(async () => {
    if (!Value.Check(CapabilitySetEnabledArgsSchema, args)) throw new AppError("INPUT.INVALID");
    await runtime.setEnabled(args[0], args[1]);
    return null;
  }));
  ipc.handle(IPC_CHANNELS.capabilityManagementRestart, (_event, ...args) => appResult(async () => {
    if (args.length) throw new AppError("INPUT.INVALID");
    if (restartRequested) return null;
    restartRequested = true;
    try {
      requestRestart();
    } catch {
      restartRequested = false;
      throw new AppError("INTERNAL.UNKNOWN");
    }
    return null;
  }));
  ipc.handle(IPC_CHANNELS.capabilityManagementSubscribe, (event, ...args) => appResult(async () => {
    if (args.length) throw new AppError("INPUT.INVALID");
    const sender = event.sender;
    if (subscriptions.has(sender.id)) return null;
    const destroyed = () => remove(sender.id);
    const send = () => { try { sender.send(IPC_CHANNELS.capabilityManagementEvents, snapshot()); } catch { remove(sender.id); } };
    const unsubscribe = runtime.subscribe(send);
    sender.on("destroyed", destroyed);
    subscriptions.set(sender.id, () => { unsubscribe(); sender.removeListener("destroyed", destroyed); });
    send();
    return null;
  }));
  ipc.handle(IPC_CHANNELS.capabilityManagementUnsubscribe, (event, ...args) => appResult(async () => {
    if (args.length) throw new AppError("INPUT.INVALID");
    remove(event.sender.id); return null;
  }));
  return () => {
    for (const id of subscriptions.keys()) remove(id);
    for (const channel of [IPC_CHANNELS.capabilityManagementList, IPC_CHANNELS.capabilityManagementSetEnabled, IPC_CHANNELS.capabilityManagementRestart, IPC_CHANNELS.capabilityManagementSubscribe, IPC_CHANNELS.capabilityManagementUnsubscribe]) ipc.removeHandler(channel);
  };
}
