import { Type, type Static } from "typebox";
import { MemoryReferenceSchema } from "./memory.js";
import { ChatTranscriptMessageSchema } from "./chat-transcript.js";

/** A replaceable conversation projection. Original messages remain the source of truth. */
export const ChatCompactionSchema = Type.Object({
  memoryDependencies: Type.Optional(Type.Array(MemoryReferenceSchema, { maxItems: 100 })),
  summary: Type.String({ minLength: 1, maxLength: 24000 }),
  retainedMessages: Type.Array(ChatTranscriptMessageSchema),
  sourceMessageCount: Type.Integer({ minimum: 0 }),
  createdAt: Type.Integer({ minimum: 0 }),
  tokensBefore: Type.Integer({ minimum: 0 }),
  tokensAfter: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type ChatCompaction = Static<typeof ChatCompactionSchema>;
