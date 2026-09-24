import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiChatAgentError, PiRunDiagnostic } from "./pi-runtime.js";

export function hasProviderFailure(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      const assistant = message as AssistantMessage;
      return (
        assistant.stopReason === "error" ||
        assistant.stopReason === "aborted" ||
        assistant.errorMessage !== undefined
      );
    }
  }
  return false;
}

export function normalizedStopReason(messages: unknown[]): PiRunDiagnostic["stopReason"] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    if (typeof value !== "object" || value === null || (value as { role?: unknown }).role !== "assistant") continue;
    const reason = (value as { stopReason?: unknown }).stopReason;
    if (reason === "stop" || reason === "length" || reason === "error" || reason === "aborted") return reason;
    if (reason === "toolUse") return "tool_use";
    return "unknown";
  }
  return "unknown";
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function assistantTurnCount(messages: unknown[]): number {
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant",
  ).length;
}

export function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function modelInputCharsEstimate(systemPrompt: string, ...parts: unknown[]): number {
  return systemPrompt.length + parts.reduce<number>((total, part) => total + serializedChars(part), 0);
}

export function assistantToolCalls(message: AssistantMessage): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  return message.content.flatMap((part) => {
    if (part.type !== "toolCall") return [];
    const input =
      typeof part.arguments === "object" && part.arguments !== null
        ? (part.arguments as Record<string, unknown>)
        : {};
    return [{ id: part.id, name: part.name, input }];
  });
}

export function finalToolFreeAnswer(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      (candidate as { role?: unknown }).role !== "assistant"
    ) {
      continue;
    }
    const assistant = candidate as AssistantMessage;
    if (hasToolCalls(assistant)) {
      return undefined;
    }
    return assistantText(assistant);
  }
  return undefined;
}

export function validateFinalAnswer(text: string | undefined, userPrompt: string, endedWithToolUse: boolean):
  | { ok: true; text: string }
  | { ok: false; code: PiChatAgentError["code"] } {
  if (endedWithToolUse) return { ok: false, code: "invalid_final_tool_use" };
  if (text === undefined || text.trim().length === 0) return { ok: false, code: "invalid_final_empty" };
  if (text.includes("<｜｜DSML｜｜") || text.includes("<|DSML|>")) return { ok: false, code: "invalid_final_protocol" };
  // Language follows the real-human system context. Character heuristics would reject
  // valid code, names, and explicitly requested English answers; never discard those.
  return { ok: true, text };
}
