import { MEMORY_TOOL_NAMES, type MemoryReference } from "./memory.js";

export function memoryReferences(value: unknown): MemoryReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(ref => ref && typeof ref === "object" && typeof ref.id === "string" && Number.isSafeInteger(ref.revision) && ref.revision > 0 ? [{ id: ref.id, revision: ref.revision }] : []);
}
export const memoryReferenceKey = (ref: MemoryReference) => `${ref.id}:${ref.revision}`;

/** Durable history stores references, never Memory bodies (including tool arguments).
 * Runtime may keep a result only while the host confirms every referenced revision.
 * Ordinary chat text and non-memory tools retain their established behavior. */
export function projectMemoryHistory<T extends { role: string }>(messages: readonly T[], valid?: ReadonlySet<string>, receiptRefs = valid): T[] {
  return messages.map(message => {
    const m = message as T & { content?: unknown; toolName?: string };
    if (m.role === "assistant" && Array.isArray(m.content)) {
      return { ...m, content: m.content.map(part => part.type === "toolCall" && MEMORY_TOOL_NAMES.has(part.name)
        ? { ...part, arguments: { memoryHistory: true, message: "历史记忆操作；不要重放写入。" } } : part) };
    }
    if (m.role !== "toolResult" || !MEMORY_TOOL_NAMES.has(m.toolName ?? "")) return message;
    let payload: { memoryRefs?: unknown; status?: unknown; reason?: unknown } = {};
    try { payload = JSON.parse((m.content as { text: string }[]).map(part => part.text).join("\n")); } catch { /* Malformed history is redacted too. */ }
    const refs = memoryReferences(payload?.memoryRefs);
    if (valid && refs.length > 0 && refs.every(ref => valid.has(memoryReferenceKey(ref)))) return message;
    // A live result can acknowledge an operation without exposing remembered text.
    // Durable checkpoints always take the redacted branch below, so old writes are not replayed.
    if (valid && typeof payload.status === "string") {
      const receipts: Record<string, string> = {
        ok: "本次操作已完成；未返回可用记忆。", miss: "本次未找到匹配记忆；不代表没有其他已保存记忆。",
        disabled: "使用记忆已关闭，仍可在设置中管理。", error: "记忆服务读取或写入失败，操作未确认完成。", deleted: "删除操作已完成，原对话保留。",
        unclear: "操作未完成；核对当前用户原话依据，仅有实际歧义风险才向用户询问。",
        conflict: "记忆已变化，请读取最新版本。", invalidated: "操作已失效，未确认保存。",
        unavailable: "记忆服务当前不可用。", failed: "记忆操作未完成。",
      };
      if (refs.length && refs.every(ref => receiptRefs?.has(memoryReferenceKey(ref)))) {
        receipts.saved = "本次记忆已保存。"; receipts.unchanged = "记忆已保存，无需重复写入。";
      }
      const text = receipts[payload.status];
      const reason = typeof payload.reason === "string" && /^[a-z_]{1,80}$/u.test(payload.reason) ? payload.reason : undefined;
      if (text) return { ...m, content: [{ type: "text", text: JSON.stringify({ status: payload.status, memoryRefs: refs, ...(reason ? { reason } : {}), message: text }) }] };
    }
    return { ...m, content: [{ type: "text", text: JSON.stringify({
      status: "historical_reference", memoryRefs: refs,
      message: "记忆详情已隐藏或失效；如需使用请重新读取，不能据此报告已保存或重放操作。",
    }) }] };
  });
}
