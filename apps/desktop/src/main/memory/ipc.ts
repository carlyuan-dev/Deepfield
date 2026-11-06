import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppError, appResult, MEMORY_CHANNELS, MemoryInputSchema } from "@deepfield/contracts";
import type { IpcMainLike } from "../ipc.js";
import type { ChatMemoryHost } from "./host.js";

export function registerMemoryIpc(ipc: IpcMainLike, host: () => ChatMemoryHost | undefined): () => void {
  const id = Type.String({ minLength: 1, maxLength: 200 }), revision = Type.Integer({ minimum: 1 });
  const schema = {
    get: Type.Tuple([Type.String({ maxLength: 2000 })]), configure: Type.Tuple([Type.Object({ useEnabled: Type.Optional(Type.Boolean()), autoLearnEnabled: Type.Optional(Type.Boolean()), noticeSeen: Type.Optional(Type.Boolean()) }, { additionalProperties: false })]),
    read: Type.Tuple([id]), save: Type.Tuple([id, revision, MemoryInputSchema]), forget: Type.Tuple([id, revision]), clear: Type.Tuple([]), retry: Type.Tuple([]),
  };
  for (const name of Object.keys(schema) as (keyof typeof schema)[]) {
    ipc.handle(MEMORY_CHANNELS[name], (_event, ...args) => appResult(async () => {
      if (!Value.Check(schema[name], args)) throw new AppError("INPUT.INVALID");
      const current = host();
      if (!current) {
        if (name === "get") return { available: false, settings: { useEnabled: false, autoLearnEnabled: false, noticeSeen: true }, records: [], learning: [], error: "记忆服务暂不可用，请重启应用后重试。" };
        throw new AppError("INTERNAL.UNKNOWN");
      }
      switch (name) {
        case "get": return current.get(args[0] as string);
        case "configure": return current.configure(args[0] as Parameters<ChatMemoryHost["configure"]>[0]);
        case "read": return current.read(args[0] as string);
        case "save": return current.save(args[0] as string, args[1] as number, args[2] as Parameters<ChatMemoryHost["save"]>[2]);
        case "forget": current.forget(args[0] as string, args[1] as number); return null;
        case "clear": current.clear(); return null;
        case "retry": await current.retry(); return null;
      }
    }));
  }
  return () => { for (const name of Object.keys(schema) as (keyof typeof schema)[]) ipc.removeHandler(MEMORY_CHANNELS[name]); };
}
