import { createHash, randomUUID } from "node:crypto";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { EvidenceProjection, ModelRequestObservationInput, ModelRequestObserver } from "@deepfield/capability-sdk";

export interface ObservedStreamOptions extends SimpleStreamOptions {
  requestObservation?: ModelRequestObservationInput;
}

type Slot = { messageIndex: number; contentBlockIndex?: number; text: string; toolCallId?: string; user: boolean };
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const sanitize = (text: string): string => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const record = (value: unknown): Record<string, any> | undefined => typeof value === "object" && value !== null ? value as Record<string, any> : undefined;

function serializedSlots(payload: unknown): Slot[] {
  const messages = record(payload)?.messages;
  if (!Array.isArray(messages)) return [];
  const slots: Slot[] = [];
  messages.forEach((value, messageIndex) => {
    const message = record(value);
    if (!message) return;
    if (typeof message.content === "string") {
      slots.push({ messageIndex, text: message.content, user: message.role === "user", ...(message.role === "tool" ? { toolCallId: message.tool_call_id } : {}) });
    } else if (Array.isArray(message.content)) {
      message.content.forEach((value: unknown, contentBlockIndex: number) => {
        const block = record(value);
        if (block?.type === "text" && typeof block.text === "string") slots.push({ messageIndex, contentBlockIndex, text: block.text, user: message.role === "user" });
        if (block?.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : undefined;
          if (typeof text === "string") slots.push({ messageIndex, contentBlockIndex, text, toolCallId: block.tool_use_id, user: false });
        }
      });
    }
  });
  return slots;
}

function inputText(message: Context["messages"][number]): string {
  return typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
}

/** Mapping is positional and protocol-structural; never searches generated assistant prose. */
function project(payload: unknown, context: Context, input: ModelRequestObservationInput, id: string): EvidenceProjection[] {
  const slots = serializedSlots(payload);
  const toolSlots = slots.filter(slot => slot.toolCallId !== undefined);
  const userSlots = slots.filter(slot => slot.user);
  return input.origins.map((range, index) => {
    const message = context.messages[range.messageIndex];
    const toolOrdinal = context.messages.slice(0, range.messageIndex).filter(message => message.role === "toolResult").length;
    const userOrdinal = context.messages.slice(0, range.messageIndex).reduce((count, message) => count + (message.role !== "user" ? 0 : typeof message.content === "string" ? Number(message.content.trim().length > 0) : message.content.filter(part => part.type === "text" && part.text.trim().length > 0).length), 0);
    const slot = message?.role === "toolResult" ? toolSlots[toolOrdinal] : message?.role === "user" ? userSlots[userOrdinal] : undefined;
    // Pi sanitizes lone surrogates. A changed protocol layout or a user payload
    // override must be explicit unmapped, rather than inventing a precise range.
    const original = message ? inputText(message) : "";
    const expected = message ? sanitize(original) : undefined;
    const mapped = slot !== undefined && slot.text === expected && (message?.role !== "user" || typeof message.content === "string") && (message?.role !== "toolResult" || slot.toolCallId === range.toolCallId) && range.start >= 0 && range.end >= range.start && range.end <= original.length;
    const start = sanitize(original.slice(0, range.start)).length;
    const end = sanitize(original.slice(0, range.end)).length;
    const text = mapped ? slot.text.slice(start, end) : "";
    return { projectionId: `${id}:${index}`, toolCallId: range.toolCallId, origin: range.origin, mapping: mapped ? "mapped" : "unmapped", messageIndex: slot?.messageIndex ?? -1, ...(slot?.contentBlockIndex === undefined ? {} : { contentBlockIndex: slot.contentBlockIndex }), text, start, end, visibleBytes: Buffer.byteLength(text, "utf8"), visibleHash: hash(text), ...(range.modelClipping ? { modelClipping: range.modelClipping } : {}), ...(range.sourceLocatorText ? { sourceLocatorText: range.sourceLocatorText } : {}) };
  });
}

export function observeSerializedRequest(context: Context, options: ObservedStreamOptions | undefined, observer: ModelRequestObserver, fetch: typeof globalThis.fetch) {
  const input = options?.requestObservation;
  if (!input) return undefined;
  const id = randomUUID();
  let dispatched = false;
  let failed = false;
  let responseStatus: number | undefined;
  let observerFailure: unknown;
  let projections: EvidenceProjection[] = [];
  const emit = (state: "prepared" | "dispatched" | "failed", responseState: "pending" | "succeeded" | "failed" | "not_sent") => {
    try { observer({ modelRequestId: id, requestId: input.requestId, phase: input.phase, state, responseState, ...(responseStatus === undefined ? {} : { responseStatus }), projections }); }
    catch (error) { observerFailure = error; throw error; }
  };
  return {
    onPayload: async (payload: unknown, model: any) => {
      const override = await options?.onPayload?.(payload, model);
      const final = override ?? payload;
      projections = project(final, context, input, id);
      emit("prepared", "not_sent");
      return override;
    },
    fetch: (async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined;
      projections = body === undefined ? project(undefined, context, options!.requestObservation!, id) : project(JSON.parse(body), context, options!.requestObservation!, id);
      if (options?.signal?.aborted || init?.signal?.aborted || input instanceof Request && input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const pending = fetch(input, init);
      dispatched = true;
      // Avoid an unhandled transport rejection if the observer rejects dispatch.
      void pending.catch(() => undefined);
      emit("dispatched", "pending");
      const response = await pending;
      responseStatus = response.status;
      return response;
    }) as typeof globalThis.fetch,
    finish(stopReason: string) {
      if (observerFailure !== undefined) throw observerFailure;
      if (stopReason === "error" || stopReason === "aborted") {
        if (!failed) { failed = true; emit("failed", dispatched ? "failed" : "not_sent"); }
      } else if (dispatched) emit("dispatched", "succeeded");
    },
  };
}
