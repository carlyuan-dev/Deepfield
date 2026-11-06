import { Type, type Static } from "typebox";
import type { MemoryIndex, MemoryRecord } from "@deepfield/base/memory";

const object = { additionalProperties: false } as const;
export const MemoryReferenceSchema = Type.Object({ id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 1 }) }, object);
export type MemoryReference = Static<typeof MemoryReferenceSchema>;
export const MemoryEntrySchema = Type.Object({
  ...MemoryReferenceSchema.properties,
  summary: Type.String({ maxLength: 120 }), content: Type.Optional(Type.String({ maxLength: 2000 })),
  kind: Type.Optional(Type.String()), view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("detail")])),
  applicability: Type.String({ maxLength: 300 }), scope: Type.String(), origin: Type.String(),
}, object);
export type MemoryEntry = Static<typeof MemoryEntrySchema>;
export const ChatMemorySnapshotSchema = Type.Object({
  entries: Type.Array(MemoryEntrySchema, { maxItems: 100 }),
  state: Type.Optional(Type.Union([Type.Literal("ready"), Type.Literal("empty"), Type.Literal("disabled"), Type.Literal("error")])),
  reason: Type.Optional(Type.String({ maxLength: 300 })),
  nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
}, object);
export type ChatMemorySnapshot = Static<typeof ChatMemorySnapshotSchema>;
export const MemoryInputSchema = Type.Object({
  kind: Type.Union([Type.Literal("profile"), Type.Literal("preference"), Type.Literal("convention"), Type.Literal("experience")]),
  summary: Type.String({ minLength: 1, maxLength: 120 }), content: Type.String({ minLength: 1, maxLength: 2000 }),
  applicability: Type.String({ maxLength: 300 }),
}, object);
export const MemoryUserRequestSchema = Type.String({ minLength: 1, maxLength: 4000 });
const authority = { userRequest: MemoryUserRequestSchema };
const scope = Type.Union([Type.Literal("user"), Type.Literal("conversation")]);
export const MemoryCommandSchema = Type.Union([
  Type.Object({ operation: Type.Literal("search"), query: Type.String({ maxLength: 2000 }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000 })) }, object),
  Type.Object({ operation: Type.Literal("read"), id: Type.String({ minLength: 1 }) }, object),
  Type.Object({ operation: Type.Literal("remember"), ...authority, scope, input: MemoryInputSchema }, object),
  Type.Object({ operation: Type.Literal("revise"), ...authority, ...MemoryReferenceSchema.properties, input: MemoryInputSchema }, object),
  Type.Object({ operation: Type.Literal("forget"), ...authority, ...MemoryReferenceSchema.properties }, object),
  Type.Object({ operation: Type.Literal("clear"), ...authority }, object),
  Type.Object({ operation: Type.Literal("validate"), refs: Type.Array(MemoryReferenceSchema, { maxItems: 100 }) }, object),
]);
export type MemoryCommand = Static<typeof MemoryCommandSchema>;
export interface MemoryToolReply {
  status: "saved" | "unchanged" | "deleted" | "ok" | "unclear" | "conflict" | "invalidated" | "disabled" | "miss" | "error" | "unavailable" | "failed";
  message?: string;
  entries?: MemoryEntry[];
  memoryRefs?: MemoryReference[];
  validRefs?: MemoryReference[];
  useEnabled?: boolean;
  nextOffset?: number;
  reason?: string;
}
export interface MemorySettings { useEnabled: boolean; autoLearnEnabled: boolean; noticeSeen: boolean }
export interface MemoryLearningStatus { conversationId: string; requestId: string; status: "saved" | "empty" | "failed" | "interrupted" | "skipped"; savedCount: number; reason?: string; updatedAt: number }
export interface MemoryDashboard { available: boolean; settings: MemorySettings; records: MemoryIndex[]; learning: MemoryLearningStatus[]; error?: string }
export interface MemoryDetail { record: MemoryRecord; history: MemoryRecord[]; sources: Array<{ label: string; time?: number }> }
export interface MemoryManagementApi {
  get(query?: string): Promise<MemoryDashboard>;
  configure(patch: Partial<MemorySettings>): Promise<MemoryDashboard>;
  read(id: string): Promise<MemoryDetail>;
  save(id: string, revision: number, input: Static<typeof MemoryInputSchema>): Promise<MemoryRecord>;
  forget(id: string, revision: number): Promise<void>;
  clear(): Promise<void>;
  retry(): Promise<void>;
  onChanged(listener: () => void): () => void;
}
export const MEMORY_CHANNELS = { get: "memory:get", configure: "memory:configure", read: "memory:read", save: "memory:save", forget: "memory:forget", clear: "memory:clear", retry: "memory:retry", changed: "memory:changed" } as const;
export const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_read", "memory_remember", "memory_revise", "memory_forget", "memory_clear"]);
