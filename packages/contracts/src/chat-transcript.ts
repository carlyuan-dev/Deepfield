import { Type, type Static } from "typebox";
import { JsonObjectSchema } from "./tools.js";

const text = Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false });
const toolCall = Type.Object({ type: Type.Literal("toolCall"), id: Type.String(), name: Type.String(), arguments: JsonObjectSchema }, { additionalProperties: false });
const counts = { input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() };
export const ChatTranscriptMessageSchema = Type.Union([
  Type.Object({ role: Type.Literal("user"), content: Type.String(), timestamp: Type.Number() }, { additionalProperties: false }),
  Type.Object({
    role: Type.Literal("assistant"), content: Type.Array(Type.Union([text, toolCall])),
    api: Type.String(), provider: Type.String(), model: Type.String(), timestamp: Type.Number(),
    usage: Type.Object({ ...counts, totalTokens: Type.Number(), cost: Type.Object({ ...counts, total: Type.Number() }, { additionalProperties: false }) }, { additionalProperties: false }),
    stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse"), Type.Literal("error"), Type.Literal("aborted")]),
  }, { additionalProperties: false }),
  Type.Object({ role: Type.Literal("toolResult"), toolCallId: Type.String(), toolName: Type.String(), content: Type.Array(text), isError: Type.Boolean(), timestamp: Type.Number() }, { additionalProperties: false }),
]);
export type ChatTranscriptMessage = Static<typeof ChatTranscriptMessageSchema>;

export const ChatHistoryTurnSchema = Type.Object({
  requestId: Type.String(), network: Type.Union([Type.Literal("enabled"), Type.Literal("disabled")]),
  messages: Type.Array(ChatTranscriptMessageSchema),
}, { additionalProperties: false });
export type ChatHistoryTurn = Static<typeof ChatHistoryTurnSchema>;

export const ChatToolSourceSchema = Type.Object({ title: Type.String({ maxLength: 300 }), url: Type.String({ maxLength: 8192, pattern: "^https?://" }) }, { additionalProperties: false });
export type ChatToolSource = Static<typeof ChatToolSourceSchema>;
