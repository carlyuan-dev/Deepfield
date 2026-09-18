import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { describe, expect, it } from "vitest";
import { assistant } from "../agent/pi-chat-agent-test-helpers.js";
import { createPiSessionCheckpointCollector } from "./pi-session-checkpoints.js";

function checkpointEvents(events: AgentWorkerEvent[]) {
  return events.filter(
    (event): event is Extract<AgentWorkerEvent, { type: "transcript_checkpoint" }> =>
      event.type === "transcript_checkpoint",
  );
}

describe("Pi session checkpoint collector", () => {
  it("keeps an emitted snapshot unchanged when later messages are recorded", () => {
    const events: AgentWorkerEvent[] = [];
    const collector = createPiSessionCheckpointCollector("req-1", (event) => events.push(event));

    collector.record(assistant("first"));
    collector.record(assistant("second"));

    const checkpoints = checkpointEvents(events);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.messages).toHaveLength(1);
    expect(checkpoints[1]?.messages).toHaveLength(2);
  });

  it("does not share transcript state between collectors", () => {
    const firstEvents: AgentWorkerEvent[] = [];
    const secondEvents: AgentWorkerEvent[] = [];
    const first = createPiSessionCheckpointCollector("req-1", (event) => firstEvents.push(event));
    const second = createPiSessionCheckpointCollector("req-2", (event) => secondEvents.push(event));

    first.record(assistant("first"));
    second.record(assistant("second"));

    expect(checkpointEvents(firstEvents)[0]).toMatchObject({ requestId: "req-1", messages: [{ role: "assistant" }] });
    expect(checkpointEvents(secondEvents)[0]).toMatchObject({ requestId: "req-2", messages: [{ role: "assistant" }] });
    expect(checkpointEvents(secondEvents)[0]?.messages).toHaveLength(1);
  });

  it("ignores messages that are not persistable transcript entries", () => {
    const events: AgentWorkerEvent[] = [];
    const collector = createPiSessionCheckpointCollector("req-1", (event) => events.push(event));
    const customMessage = {
      role: "custom",
      customType: "status",
      content: "internal-only",
      display: false,
      timestamp: 1000,
    } as AgentMessage;

    collector.record(customMessage);

    expect(events).toEqual([]);
  });
});
