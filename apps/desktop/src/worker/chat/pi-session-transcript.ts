import { buildSessionContext, type AgentMessage, type Entry } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { ChatTranscriptMessageSchema, type AgentContextSnapshot, type ChatTranscriptMessage } from "@deepfield/contracts";
import { mapHistoryMessages, type ModelIdentity } from "./pi-message-mapper.js";

export { toolResultProjection } from "../tools/tool-source-projection.js";

function safeArguments(args: Record<string, unknown>): Record<string, unknown> {
  // Tool parameters are model-facing JSON, never a place to retain transport credentials.
  return JSON.parse(JSON.stringify(args, (key, value: unknown) => /^(?:headers|authorization|api[_-]?key|access[_-]?token|password|secret)$/iu.test(key) ? undefined : value)) as Record<string, unknown>;
}

/** Allowlist model-facing fields; never serialize details, transport or hidden reasoning. */
export function transcriptMessage(message: AgentMessage): ChatTranscriptMessage | undefined {
  let clean: unknown;
  if (message.role === "user") {
    clean = { role: message.role, content: typeof message.content === "string" ? message.content : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), timestamp: message.timestamp };
  } else if (message.role === "toolResult") {
    clean = { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, timestamp: message.timestamp,
      content: message.content.flatMap(part => part.type === "text" ? [{ type: "text", text: part.text }] : []) };
  } else if (message.role === "assistant") {
    const { input, output, cacheRead, cacheWrite, totalTokens, cost } = message.usage;
    clean = { role: message.role, api: message.api, provider: message.provider, model: message.model, timestamp: message.timestamp, stopReason: message.stopReason,
      usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, total: cost.total } },
      content: message.content.flatMap(part => part.type === "text" ? [{ type: "text", text: part.text }] : part.type === "toolCall" ? [{ type: "toolCall", id: part.id, name: part.name, arguments: safeArguments(part.arguments) }] as unknown[] : []) };
  }
  return Value.Check(ChatTranscriptMessageSchema, clean) ? structuredClone(clean) : undefined;
}

export function restoreSessionContext(context: AgentContextSnapshot, model: ModelIdentity): { messages: Message[]; provenance: string } {
  const turns = new Map(context.historyTurns?.map(turn => [turn.requestId, turn]));
  const emitted = new Set<string>();
  const messages = context.messages.flatMap(message => {
    const turn = message.requestId === undefined ? undefined : turns.get(message.requestId);
    if (!turn) return mapHistoryMessages([message], model);
    if (emitted.has(turn.requestId)) return [];
    emitted.add(turn.requestId);
    return turn.messages as Message[];
  });
  const entries: Entry[] = messages.map((message, index) => ({ type: "message", id: `history-${index}`, parentId: index === 0 ? null : `history-${index - 1}`, seq: index, timestamp: message.timestamp, message }));
  return {
    messages: buildSessionContext(entries).messages as Message[],
    provenance: (context.historyTurns ?? []).filter(turn => emitted.has(turn.requestId)).map(turn => {
      const results = turn.messages.filter(message => message.role === "toolResult" && ["web_search", "read_webpage"].includes(message.toolName));
      return `历史请求 ${turn.requestId}: network=${turn.network}; networkResults=${results.length}; successfulNetworkResults=${results.filter(message => message.role === "toolResult" && !message.isError).length}。仅记录当时权限与实际工具结果，不表示本轮新核实。`;
    }).join("\n"),
  };
}
