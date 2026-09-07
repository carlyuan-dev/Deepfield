import { describe, expect, it } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { createChatEventHub, type ChatEventHub } from "./chat-event-hub.js";

const started = (requestId: string): AgentWorkerEvent => ({ requestId, type: "started" });
const delta = (requestId: string, text: string): AgentWorkerEvent => ({
  requestId,
  type: "text_delta",
  delta: text,
});
const completed = (requestId: string, text: string): AgentWorkerEvent => ({
  requestId,
  type: "completed",
  text,
});
const failed = (requestId: string): AgentWorkerEvent => ({
  requestId,
  type: "failed",
  code: "error",
  message: "boom",
});

function collect(
  hub: ChatEventHub,
): { received: Array<{ conversationId: string; event: AgentWorkerEvent }>; unsubscribe(): void } {
  const received: Array<{ conversationId: string; event: AgentWorkerEvent }> = [];
  const unsubscribe = hub.subscribe((payload) => received.push(payload));
  return { received, unsubscribe };
}

describe("chat event hub", () => {
  it("routes events only for registered requests", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.registerRequest("r1", "c1");
    hub.emit(started("r1"));
    hub.emit(delta("r1", "测"));
    expect(received).toEqual([
      { conversationId: "c1", event: started("r1") },
      { conversationId: "c1", event: delta("r1", "测") },
    ]);
  });

  it("drops unknown events without guessing a conversation", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.emit(started("ghost"));
    hub.emit(delta("ghost", "x"));
    expect(received).toEqual([]);
  });

  it("removes the mapping after a terminal and drops late events", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.registerRequest("r1", "c1");
    hub.emit(started("r1"));
    hub.emit(completed("r1", "最终"));
    hub.emit(delta("r1", "晚到"));
    expect(hub.activeCount()).toBe(0);
    expect(received[received.length - 1]).toEqual({
      conversationId: "c1",
      event: completed("r1", "最终"),
    });
    expect(
      received.some(
        (entry) => entry.event.type === "text_delta" && entry.event.delta === "晚到",
      ),
    ).toBe(false);
  });

  it("drops events after a failed terminal too", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.registerRequest("r1", "c1");
    hub.emit(failed("r1"));
    hub.emit(delta("r1", "late"));
    expect(hub.activeCount()).toBe(0);
    expect(received).toEqual([{ conversationId: "c1", event: failed("r1") }]);
  });

  it("re-binds a request id after a terminal when registered again", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.registerRequest("r1", "c1");
    hub.emit(completed("r1", "最终"));
    hub.emit(delta("r1", "late")); // dropped
    hub.registerRequest("r1", "c2");
    hub.emit(started("r1"));
    hub.emit(delta("r1", "新"));
    expect(hub.activeCount()).toBe(1);
    expect(
      received.some((entry) => entry.event.type === "text_delta" && entry.event.delta === "新"),
    ).toBe(true);
  });

  it("unregisters a request explicitly", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.registerRequest("r1", "c1");
    hub.unregisterRequest("r1");
    hub.emit(started("r1"));
    expect(hub.activeCount()).toBe(0);
    expect(received).toEqual([]);
  });

  it("dispose clears listeners and mappings", () => {
    const hub = createChatEventHub();
    const { received } = collect(hub);
    hub.registerRequest("r1", "c1");
    hub.dispose();
    hub.emit(started("r1"));
    expect(received).toEqual([]);
    expect(hub.activeCount()).toBe(0);
  });

  it("isolates separate instances", () => {
    const first = createChatEventHub();
    const second = createChatEventHub();
    const firstReceived: string[] = [];
    const secondReceived: string[] = [];
    first.subscribe((payload) => firstReceived.push(payload.event.requestId));
    second.subscribe((payload) => secondReceived.push(payload.event.requestId));
    first.registerRequest("r1", "c1");
    first.emit(started("r1"));
    expect(firstReceived).toEqual(["r1"]);
    expect(secondReceived).toEqual([]);
  });

  it("keeps the mapping while non-terminal events flow", () => {
    const hub = createChatEventHub();
    hub.registerRequest("r1", "c1");
    hub.emit(started("r1"));
    hub.emit(delta("r1", "测"));
    expect(hub.activeCount()).toBe(1);
  });
});
