import type { ChatTranscriptMessage } from "@deepfield/contracts";

/** Keep whole tool batches. An interrupted call never acquires a fabricated result. */
export function pairedSessionMessages(messages: ChatTranscriptMessage[], completed: boolean): ChatTranscriptMessage[] {
  const safe: ChatTranscriptMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") continue;
    if (message.role === "user") { safe.push(message); continue; }
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const calls = message.content.filter(part => part.type === "toolCall");
    if (calls.length === 0) {
      if (completed) safe.push(message);
      continue;
    }
    const results: ChatTranscriptMessage[] = [];
    for (let next = index + 1; next < messages.length && messages[next]!.role === "toolResult"; next += 1) results.push(messages[next]!);
    if (calls.every(call => results.some(result => result.role === "toolResult" && result.toolCallId === call.id))) {
      safe.push(message, ...results.filter(result => result.role === "toolResult" && calls.some(call => call.id === result.toolCallId)));
    }
  }
  return safe;
}
